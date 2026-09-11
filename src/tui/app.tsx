import { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, Static } from "ink";
import { Input } from "./input.js";
import { ApprovalPrompt } from "./approval-prompt.js";
import { MessageItem, type OutputMessage } from "./output.js";
import {
  ptcProgramToMessage,
  ptcDispatchToMessage,
  extractRunCodeErrorKind,
  StreamAccumulator,
  clipPreview,
} from "./ptc.js";
import { handleCommand } from "./commands.js";
import { createAgentExecutor, createHierarchicalAgent, createPtcAgent, runAgentMessages } from "../agent/loop.js";
import type { AgentMemory } from "../memory/index.js";
import { GraphAgentExecutor } from "../agent/graph-agent-executor.js";
import { HierarchicalAgentLangGraph } from "../agent/hierarchical-agent-langgraph.js";
import { PtcAgentLangGraph } from "../ptc/ptc-agent-langgraph.js";
import type { ChatOpenAI } from "@langchain/openai";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentStep } from "@langchain/core/agents";
import type { ExecutionPlan } from "../agent/types.js";
import type { PtcDispatchEvent } from "../ptc/dispatch-bridge.js";
import { AgentMode, AppConfig } from "../config/index.js";
import { ModeRouter, type RouteDecision, type RoutableMode } from "../agent/mode-router.js";
import { Tracer } from "../agent/tracer.js";
import { ToolStatsRegistry } from "../tools/stats-registry.js"
import { ToolFilter } from "../tools/tool-filter.js"
import { updatePlanMessage } from "./plan-utils.js"
import { ManualInteractor, type HumanChannel, type HumanRequest, type HumanResponse } from "../tools/human-channel.js";

/** 统一流式块（三种模式并集；各模式只产出相关字段，见设计文档 §5.2 AgentStreamChunk） */
interface StreamChunk {
  plan?: ExecutionPlan;
  intermediateSteps?: AgentStep[];
  /** 最终回答（finalize/fallback 产出；累积进最终 assistant 消息） */
  output?: string;
  /** 中间轮次的叙述文字（agent 思考/说明，仅动态预览，不进入最终消息） */
  outputPreview?: string;
  ptcProgram?: { code: string; description: string };
  ptcDispatch?: PtcDispatchEvent;
}

/** dynamic 区最多同时挂几条当轮卡片；超出部分提前落 <Static>，防止帧高失控 */
const TURN_BUFFER_LIMIT = 8;

interface AppProps {
  config: AppConfig;
  memory: AgentMemory;
  agentName?: string;
  llm: ChatOpenAI;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  tracer?: Tracer;
  toolStatsRegistry?: ToolStatsRegistry;
  toolFilter?: ToolFilter;
  /** 人在环通道（allow 模式为 undefined）；App 渲染后 attach 交互器 */
  humanChannel?: HumanChannel;
}

export function App({ config, memory, agentName = "Agent", llm, tools, systemPrompt, tracer, toolStatsRegistry, toolFilter, humanChannel }: AppProps) {
  // ------------------------------------------------------------------
  // 渲染分两层：
  //
  // - staticMessages → <Static>：写一次、永不重绘。终端里可能累积几十行，不参与
  //   每次 re-render，所以输入时只重绘下方小块 dynamic 区，不闪。
  // - dynamicMessages → dynamic 区：**当轮**的卡片 + 流式文本，每 50ms 整块重绘。
  //
  // 关键约束（2026-09-11 修复流式布局问题）：**回合中途不要往 <Static> 插东西**。
  // <Static> 打印在 dynamic 区**上方**，而流式文本在 dynamic 区里不断整块重绘；
  // 中途插一行卡片，正在读的那段回答就被工具卡片「拦腰截断」。
  // 因此当轮的卡片先进 turnBufferRef，回合收尾时按原顺序整体落盘。
  // ------------------------------------------------------------------
  const [staticMessages, setStaticMessages] = useState<OutputMessage[]>([]);
  const [dynamicMessages, setDynamicMessages] = useState<OutputMessage[]>([]);

  /** 当轮卡片缓冲（同步可读，供流式回调使用） */
  const turnBufferRef = useRef<OutputMessage[]>([]);

  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [sessionName, setSessionName] = useState("Chat");
  const [agentMode, setAgentMode] = useState<AgentMode>(config.agentMode);

  // 人在环：待答请求。由 channel 通知驱动，不参与回合状态机
  const [pendingRequest, setPendingRequest] = useState<HumanRequest | null>(null);
  // TUI 侧交互器：把用户按键兑现成通道请求的结果（惰性初始化，避免每次渲染都 new）
  const interactorRef = useRef<ManualInteractor | null>(null);
  if (!interactorRef.current) interactorRef.current = new ManualInteractor();
  const interactor = interactorRef.current;

  // 后挂载交互器：bootstrap 先建空通道（未挂载时自动走无人值守兜底）
  useEffect(() => {
    humanChannel?.attach(interactor);
  }, [humanChannel]);

  // 订阅 pending 变化 → 触发 re-render 渲染卡片
  useEffect(() => {
    if (!humanChannel) return;
    setPendingRequest(humanChannel.pending);
    return humanChannel.subscribe(() => setPendingRequest(humanChannel.pending));
  }, [humanChannel]);

  const handleHumanAnswer = useCallback(
    (res: HumanResponse) => {
      if (!pendingRequest) return;
      interactor.answer(pendingRequest.id, res);
    },
    [pendingRequest],
  );

  // Refs to keep values accessible inside stable callbacks without
  // causing the callback identity to change (which would tear down
  // and recreate the stdin handler in ControlledTextInput, breaking input).
  const llmRef = useRef(llm);
  const toolsRef = useRef(tools);
  const executorRef = useRef<PtcAgentLangGraph | HierarchicalAgentLangGraph | GraphAgentExecutor | null>(null);

  // auto 路由所需：mode 状态镜像 + router + 跨轮 lastMode + 懒建 plan executor
  // （全部经 ref，保证 onSubmit 稳定闭包 [deps: memory] 读到最新值）
  const agentModeRef = useRef<AgentMode>(agentMode);
  useEffect(() => { agentModeRef.current = agentMode; }, [agentMode]);

  const routerRef = useRef<ModeRouter | null>(null);
  useEffect(() => { routerRef.current = new ModeRouter({ llm }); }, [llm]);

  const lastAutoModeRef = useRef<RoutableMode>("normal");
  const autoPlanExecRef = useRef<HierarchicalAgentLangGraph | null>(null);
  // ensureAutoPlan 由 effect 按最新 deps 更新，避免 onSubmit 陈旧闭包
  const ensureAutoPlanRef = useRef<() => HierarchicalAgentLangGraph>(
    () => { throw new Error("ensureAutoPlan not initialized"); },
  );
  useEffect(() => {
    ensureAutoPlanRef.current = () => {
      if (!autoPlanExecRef.current) {
        autoPlanExecRef.current = createHierarchicalAgent(
          llmRef.current!, toolsRef.current!, tracer, toolStatsRegistry, config.llmTimeoutMs, toolFilter,
        );
      }
      return autoPlanExecRef.current;
    };
  }, [tracer, toolStatsRegistry, config, toolFilter]);

  // 按当前模式动态创建 executor；切换/卸载时 cleanup 释放旧 PTC 实例（worker runtime）
  useEffect(() => {
    const exec =
      agentMode === "ptc"
        ? createPtcAgent(llm, tools, {
            maxIterations: config.maxIterations,
            ptc: {
              maxProgramLength: config.ptcMaxProgramLength,
              maxWallMs: config.ptcMaxWallMs,
              maxOutputBytes: config.ptcMaxOutputBytes,
              maxParallelSubCalls: config.ptcMaxParallelSubCalls,
              mode: config.ptcMode,
            },
            toolFilter,
            tracer,
            toolStatsRegistry,
            llmTimeoutMs: config.llmTimeoutMs,
            humanChannel,
          })
        : agentMode === "plan"
          ? createHierarchicalAgent(llmRef.current, toolsRef.current, tracer, toolStatsRegistry, config.llmTimeoutMs, toolFilter)
          : createAgentExecutor(
              llm,
              tools,
              systemPrompt,
              config.maxIterations,
              toolStatsRegistry,
              toolFilter,
              tracer,
              config.llmTimeoutMs,
            );
    executorRef.current = exec;
    return () => {
      if (exec instanceof PtcAgentLangGraph) {
        void exec.dispose();
      }
    };
  }, [agentMode, llm, tools, config, systemPrompt, toolStatsRegistry, toolFilter, tracer, humanChannel]);
  useEffect(() => { llmRef.current = llm; }, [llm]);
  useEffect(() => { toolsRef.current = tools; }, [tools]);

  // Streaming token buffer — tokens accumulate here and are flushed to
  // state on a 50 ms interval to prevent a re-render on every token
  // (~20 fps instead of hundreds of renders per second).
  const streamingBufferRef = useRef("");

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setStreamingText(streamingBufferRef.current);
    }, 50);
    return () => clearInterval(interval);
  }, [running]);

  // Load existing messages from memory on mount
  useEffect(() => {
    (async () => {
      const session = await memory.getSession();
      if (session) {
        setSessionName(session.name);
        const msgs = await memory.store.getMessages(session.id);
        if (msgs.length > 0) {
          setStaticMessages(
            msgs.map((m) => ({
              role: m.role as "user" | "assistant" | "system" | "tool",
              content: m.content,
              timestamp: m.createdAt,
            })),
          );
        }
      }
    })();
  }, [memory]);

  const handleToggleAgentMode = useCallback(() => {
    setAgentMode(prev => {
      const modes: AgentMode[] = ["normal", "auto", "plan", "ptc"]
      const next = modes[(modes.indexOf(prev)+1)%4];
      const label: Record<AgentMode, string> = {
        normal: "⚡ Standard ReAct mode. (Shift+Tab to toggle)",
        auto: "🔀 Auto mode: escalates to plan when the task needs it. (Shift+Tab to toggle)",
        plan: "🗺️ Plan mode enabled. Agent will create a step-by-step plan before executing. (Shift+Tab to toggle)",
        ptc: "📦 PTC mode enabled. Agent writes TypeScript programs to batch tool calls. (Shift+Tab to toggle)",
      };
      setStaticMessages((msgs) => [
        ...msgs,
        {
          role: "system" as const,
          content: label[next],
          timestamp: new Date(),
        },
      ]);
      return next;
    });
  }, []);

  // ------------------------------------------------------------------
  // 回合渲染原语：当轮卡片先留在 dynamic 区，回合收尾才整体落 <Static>。
  // 落盘时机是这一组函数的唯一职责，别在回合中途直接 setStaticMessages。
  // ------------------------------------------------------------------

  /** 追加一张当轮卡片（只进 dynamic 区，不落 Static） */
  const emit = useCallback((msg: OutputMessage) => {
    turnBufferRef.current = [...turnBufferRef.current, msg];
    if (turnBufferRef.current.length > TURN_BUFFER_LIMIT) {
      const overflow = turnBufferRef.current.slice(0, turnBufferRef.current.length - TURN_BUFFER_LIMIT);
      turnBufferRef.current = turnBufferRef.current.slice(-TURN_BUFFER_LIMIT);
      setStaticMessages((prev) => [...prev, ...overflow]);
    }
    setDynamicMessages(turnBufferRef.current);
  }, []);

  /** 结算当轮最后一张「进行中」卡片（工具调用结束时把 running 换成结果） */
  const settleRunningCard = useCallback((patch: (msg: OutputMessage) => OutputMessage) => {
    let idx = -1;
    for (let i = turnBufferRef.current.length - 1; i >= 0; i--) {
      if (turnBufferRef.current[i].running) { idx = i; break; }
    }
    if (idx < 0) return;
    turnBufferRef.current = turnBufferRef.current.map((m, i) => (i === idx ? patch(m) : m));
    setDynamicMessages(turnBufferRef.current);
  }, []);

  /** 计划卡片是原地刷新的（同一张卡反复更新状态），所以走替换而非追加 */
  const emitPlan = useCallback((planText: string) => {
    turnBufferRef.current = updatePlanMessage(turnBufferRef.current, planText);
    setDynamicMessages(turnBufferRef.current);
  }, []);

  /** 回合收尾：当轮卡片整体落入 <Static>（保持原有顺序），dynamic 区清空 */
  const commitTurnBuffer = useCallback(() => {
    const buffered = turnBufferRef.current;
    turnBufferRef.current = [];
    setDynamicMessages([]);
    if (buffered.length > 0) setStaticMessages((prev) => [...prev, ...buffered]);
  }, []);

  /** 丢弃当轮缓冲（/clear、切换会话时用） */
  const resetTurnBuffer = useCallback(() => {
    turnBufferRef.current = [];
    setDynamicMessages([]);
  }, []);

  const onSubmit = useCallback(
    async (value: string) => {
      // Handle /session commands
      if (value.startsWith("/session")) {
        const parts = value.split(/\s+/);
        if (parts[1] === "new") {
          const s = await memory.store.createSession();
          await memory.switchSession(s.id);
          setSessionName(s.name);
          setStaticMessages([]);
          resetTurnBuffer();
        } else if (parts[1] === "switch" && parts[2]) {
          const s = await memory.switchSession(parts[2]);
          if (s) {
            setSessionName(s.name);
            const msgs = await memory.store.getMessages(s.id);
            setStaticMessages(
              msgs.map((m) => ({
                role: m.role as "user" | "assistant" | "system" | "tool",
                content: m.content,
                timestamp: m.createdAt,
              })),
            );
            resetTurnBuffer();
          }
        } else if (!parts[1] || parts[1] === "list") {
          const sessions = await memory.listSessions();
          const list = sessions
            .map((s) => `${s.id.slice(0, 8)}: ${s.name}`)
            .join("\n");
          setStaticMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `Sessions:\n${list}`,
              timestamp: new Date(),
            },
          ]);
        }
        return;
      }

      if (value.startsWith("/")) {
        const result = handleCommand(value);
        if (result === "CLEAR") {
          setStaticMessages([]);
          resetTurnBuffer();
          return;
        }
        // /show is not supported with <Static> — static messages can't
        // be updated after rendering. Silently ignore.
        if (value.startsWith("/show")) return;
        if (result)
          setStaticMessages((prev) => [
            ...prev,
            { role: "system", content: result, timestamp: new Date() },
          ]);
        return;
      }

      // Add user message to static area
      setStaticMessages((prev) => [
        ...prev,
        { role: "user", content: value, timestamp: new Date() },
      ]);
      await memory.addUserMessage(value);
      setRunning(true);
      streamingBufferRef.current = "";
      setStreamingText("");
      resetTurnBuffer();

      try {
        let output: string;

        let exec = executorRef.current;
        if (!exec) {
          throw new Error("Agent executor not initialized yet");
        }
        const turn = await memory.prepareTurn(value)

        // ---- auto：按当前用户输入实时选档（仅 normal↔plan；ptc 仍手动）----
        let autoChip: string | null = null;
        if (agentModeRef.current === "auto") {
          const router = routerRef.current;
          if (!router) throw new Error("Mode router not initialized yet");
          const decision: RouteDecision = await router.resolveMode(value, {
            lastMode: lastAutoModeRef.current,
          });
          lastAutoModeRef.current = decision.mode;
          if (decision.mode === "plan") {
            exec = ensureAutoPlanRef.current();
            autoChip = `[auto→🗺️ plan] ${decision.reason}`;
          }
          // normal：沿用 executorRef（agentMode=auto 时上方 effect 已构建 normal 实例）
        }
        if (autoChip) {
          setStaticMessages((prev) => [
            ...prev,
            { role: "system", content: autoChip, timestamp: new Date() },
          ]);
        }
        // ---- 三种模式共用同一套 chunk 渲染 ----
        // 卡片 → 当轮缓冲（回合收尾才落 <Static>）；叙述 → 动态预览。
        // 最终回答与中间叙述的区分由 StreamAccumulator 负责，三模式语义一致。
        const streamAcc = new StreamAccumulator();
        const renderChunk = (chunk: StreamChunk) => {
          streamAcc.push(chunk);
          streamingBufferRef.current = streamAcc.previewText;

          // plan 卡片：同一张卡原地刷新状态
          if (chunk.plan) {
            const plan = chunk.plan;
            emitPlan(
              [
                `🗺️ Plan: ${plan.goal}`,
                ...plan.steps.map(
                  (s: any, i: number) =>
                    `  ${i + 1}. [${s.status}] ${s.description}${s.result ? " → " + s.result.slice(0, 80) : ""}`,
                ),
              ].join("\n"),
            );
          }
          // PTC：run_code 程序卡片 / 程序内子调用
          if (chunk.ptcProgram) {
            emit(ptcProgramToMessage(chunk.ptcProgram));
          }
          if (chunk.ptcDispatch) {
            emit(ptcDispatchToMessage(chunk.ptcDispatch));
          }
          for (const step of chunk.intermediateSteps ?? []) {
            // run_code 步骤：卡片已由 ptcProgram 块展示，这里只补失败徽章
            if (step.action.tool === "run_code") {
              const kind = extractRunCodeErrorKind(step.observation);
              if (kind) {
                emit({
                  role: "system",
                  content: `run_code failed: [${kind}]`,
                  timestamp: new Date(),
                });
              }
              continue;
            }
            emit({
              role: "tool",
              content: `Calling: ${step.action.tool}\n→ ${String(step.observation).slice(0, 200)}`,
              name: step.action.tool,
              timestamp: new Date(),
            });
          }
        };

        if (exec instanceof PtcAgentLangGraph) {
          // ---- PTC Mode: programmatic tool calling ----
          for await (const rawChunk of exec.stream({ messages: turn.messages })) {
            renderChunk(rawChunk as StreamChunk);
          }
          output = streamAcc.output;
        } else if (exec instanceof HierarchicalAgentLangGraph) {
          // ---- Plan Mode: use HierarchicalAgentLangGraph ----
          for await (const rawChunk of exec.stream({ messages: turn.messages })) {
            renderChunk(rawChunk as StreamChunk);
          }
          output = streamAcc.output;
        } else {
          // ---- Normal Mode: use GraphAgentExecutor ----
          // 与 PTC / plan 同一语义：onPreview = 中间轮次叙述（仅预览，不进最终回答），
          // onToken = finalize 产出的最终回答。
          output = await runAgentMessages(exec as GraphAgentExecutor, turn.messages, {
            onToolStart(tool, input) {
              emit({
                role: "tool",
                content: `Calling: ${tool}\n${JSON.stringify(input, null, 2)}`,
                name: tool,
                timestamp: new Date(),
                running: true,
              });
            },
            onToolEnd(result) {
              settleRunningCard((msg) => ({
                ...msg,
                running: false,
                content: `→ ${result.output}`,
              }));
            },
            onPreview(token) {
              streamAcc.push({ outputPreview: token });
              streamingBufferRef.current = streamAcc.previewText;
            },
            onToken(token) {
              streamAcc.push({ output: token });
              streamingBufferRef.current = streamAcc.previewText;
            },
          }, config.llmTimeoutMs);
        }

        // 收尾顺序关键：当轮卡片先整体落 <Static>，最终回答排在它们之后
        commitTurnBuffer();
        setStaticMessages((prev) => [
          ...prev,
          { role: "assistant", content: output, timestamp: new Date() },
        ]);
        await memory.addAssistantMessage(output);
        // 摘要后台生成，不阻塞回合收尾；顶层 .catch 兜住 DB/未预期异常
        void memory.rememberAfterTurn().catch((err) =>
          console.error(`[AgentMemory] rememberAfterTurn failed:`, err),
        );
      } catch (error) {
        // 半途失败也要把已发生的卡片落盘，否则用户看不到执行到了哪一步
        commitTurnBuffer();
        setStaticMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Error: ${(error as Error).message}`,
            timestamp: new Date(),
          },
        ]);
      } finally {
        // 预览是易失区，成功失败都在这里清（原来只在成功路径清 → 异常后旧预览会一直挂在输入框上方）
        streamingBufferRef.current = "";
        setStreamingText("");
        setRunning(false);
      }
    },
    [memory],
  );

  // ------------------------------------------------------------------
  // Layout:
  //
  // <Static>  ← messages written once, never cleared/rewritten
  //   [user msg]
  //   [tool msg]
  //   [assistant msg]
  //   ...
  //
  // Dynamic area  ← only this part is cleared/rewritten on re-render
  //   status line (1 line)
  //   [当轮卡片] (0-N lines: 工具调用 / PTC 程序 / plan 卡片)
  //   [streaming text] (0-N lines)
  //   [审批 / 提问卡片] (0-1 张)
  //   > input (1-2 lines)
  //   [Agent is thinking...] (0-1 lines)
  //
  // 当轮卡片与流式文本在**同一层**，所以整块原子重绘、顺序稳定；
  // 回合结束时卡片才整体落入 <Static>（见 commitTurnBuffer）。
  // ------------------------------------------------------------------
  return (
    <Box flexDirection="column">
      <Static items={staticMessages}>
        {(msg: OutputMessage, i: number) => (
          <MessageItem key={i} msg={msg} agentName={agentName} />
        )}
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {/* Status line */}
        <Text dimColor>
          {" "}Navigate Agent | {sessionName}
          {agentMode === "auto" ? (
            <Text color="cyan"> | 🔀 Auto Mode</Text>
          ) : agentMode === "plan" ? (
            <Text color="magenta"> | 🗺️ Plan Mode</Text>
          ) : agentMode === "ptc" ? (
            <Text color="magenta"> | 📦 PTC Mode</Text>
          ) : null}
          {pendingRequest ? <Text color="yellow"> | 等待你的确认</Text> : null}
          {" "}(/help)
        </Text>

        {/* 当轮卡片（dynamic）：回合收尾时整体落入 <Static>，中途不插队 */}
        {dynamicMessages.map((msg, i) => (
          <MessageItem key={`dyn-${i}`} msg={msg} agentName={agentName} />
        ))}

        {/* Streaming text (dynamic) */}
        {streamingText ? (
          <Box flexDirection="column" marginBottom={1}>
            <Box paddingY={1}>
              <Text bold color="#4FC3F7">
                {agentName}:
              </Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color="white">
                {/* 预览可能很长（PTC 模式 agent 逐步说明）：只留尾部，但按整行切，
                    绝不切出 `…ckage.json` 这种半截词 */}
                {clipPreview(streamingText)}
              </Text>
            </Box>
          </Box>
        ) : null}

        {/* 人在环：审批 / 提问卡片（dynamic 区；<Static> 写一次不可改） */}
        {pendingRequest ? (
          <ApprovalPrompt
            key={pendingRequest.id}
            request={pendingRequest}
            onAnswer={handleHumanAnswer}
          />
        ) : null}

        {/* Input (dynamic) */}
        <Input
          onSubmit={onSubmit}
          disabled={running || !!pendingRequest}
          agentMode={agentMode}
          onToggleAgentMode={handleToggleAgentMode}
        />

        {running ? (
          <Box paddingX={1}>
            <Text color="yellow">Agent is thinking...</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
