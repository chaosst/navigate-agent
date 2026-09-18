import { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, Static } from "ink";
import { Input } from "./input.js";
import { ApprovalPrompt } from "./approval-prompt.js";
import { MessageItem, AgentLabel, type OutputMessage } from "./output.js";
import { MarkdownView } from "./markdown-view.js";
import {
  computeDynamicBudget,
  tailByRows,
  terminalColumns,
  terminalRows,
} from "./layout.js";
import {
  ptcProgramToMessage,
  ptcDispatchToMessage,
  extractRunCodeErrorKind,
  StreamAccumulator,
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
import { updatePlanMessage, PLAN_MESSAGE_MARKER } from "./plan-utils.js"
import {
  capTurnCards,
  pushToolCallStart,
  settleToolCall,
} from "./turn-cards.js"
import {
  delegateCardKey,
  delegateFinalLine,
  delegateResultLine,
  patchCardByKey,
  renderDelegateBody,
  type DelegateActivity,
} from "./delegate-card.js"
import { onDelegateEvent } from "../agent/delegate-tool.js";
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

/**
 * dynamic 区最多同时挂几条当轮卡片。
 *
 * 不再写死常量：帧高必须小于终端行数（否则 Ink 的 eraseLines 被夹到首行，
 * 输入框会跑到屏幕顶部、下方留一大片空白——见 layout.ts 顶部注释）。
 * 每次 emit 现场按当前终端高度算，窗口 resize 也自然跟上（emit 是 ref 读取，无陈旧闭包）。
 */
function currentCardLimit(): number {
  return computeDynamicBudget(terminalRows()).cardsLimit;
}

/** 思考指示动画帧（盲文点阵，几乎所有现代终端字体都有；等宽、不抖） */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

  /** delegate 子 agent 活动记账（runId → 次数/最近调用；end 时清除） */
  const delegateActivityRef = useRef<Map<string, DelegateActivity>>(new Map());

  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  /** 思考指示动画帧序号（仅 running 时自增） */
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  /** 本回合起始时刻（performance-free：仅用于显示已耗时） */
  const turnStartRef = useRef(0);
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
          { maxTokens: config.planMaxTokens, maxTimeMs: config.planMaxTimeMs, maxSteps: config.planMaxSteps },
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
          ? createHierarchicalAgent(
              llmRef.current, toolsRef.current, tracer, toolStatsRegistry, config.llmTimeoutMs, toolFilter,
              { maxTokens: config.planMaxTokens, maxTimeMs: config.planMaxTimeMs, maxSteps: config.planMaxSteps },
            )
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
  // state on an interval to prevent a re-render on every token
  // (~12 fps instead of hundreds of renders per second).
  //
  // 同一个 tick 顺带推进思考指示的动画帧：两者生命周期完全一致（都是 running），
  // 分开起两个定时器只会多一倍重绘。
  const streamingBufferRef = useRef("");

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setStreamingText(streamingBufferRef.current);
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
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

  /**
   * 追加一张当轮卡片（只进 dynamic 区，不落 Static）。
   *
   * 超预算时在 buffer 内**折叠**最老的普通工具卡（turn-cards.capTurnCards），
   * 绝不回合中途写 <Static>——中途插 Static 会让终端滚动、Ink 擦错区域，
   * 状态行重复多行 / 画面跳顶都源于此。整轮卡片在 commitTurnBuffer 统一落盘。
   */
  const emit = useCallback((msg: OutputMessage) => {
    turnBufferRef.current = capTurnCards([...turnBufferRef.current, msg], currentCardLimit());
    setDynamicMessages(turnBufferRef.current);
  }, []);

  /**
   * 结算一次普通工具调用（同上：只动 buffer，不碰 <Static>）。
   * 同名连续调用合并成一张 ×N 卡（turn-cards.settleToolCall）。
   */
  const settleTool = useCallback((tool: string, detailLine: string) => {
    turnBufferRef.current = settleToolCall(turnBufferRef.current, tool, detailLine);
    setDynamicMessages(turnBufferRef.current);
  }, []);

  /** 计划卡片是原地刷新的（同一张卡反复更新状态），所以走替换而非追加 */
  const emitPlan = useCallback((planText: string) => {
    turnBufferRef.current = updatePlanMessage(turnBufferRef.current, planText);
    setDynamicMessages(turnBufferRef.current);
  }, []);

  /** 按 key 原地更新当轮卡片；卡已被挤进 <Static> 时返回 false（调用方兜底） */
  const patchCard = useCallback((key: string, patch: (msg: OutputMessage) => OutputMessage): boolean => {
    const next = patchCardByKey(turnBufferRef.current, key, patch);
    if (!next) return false;
    turnBufferRef.current = next;
    setDynamicMessages(next);
    return true;
  }, []);

  /**
   * 把 delegate 父步骤的终稿摘要并入最近的已 settle 委托卡。
   * 委托过程已由事件卡实时展示（见下方 onDelegateEvent 订阅），父步骤到达时
   * 不再开「Calling: delegate」新卡，只补一行结果预览；找不到卡（如子 agent
   * 秒败没发 start）返回 false，由调用方退回普通卡片。
   */
  const settleDelegateResult = useCallback((observation: string): boolean => {
    for (let i = turnBufferRef.current.length - 1; i >= 0; i--) {
      const m = turnBufferRef.current[i];
      if (m.name === "delegate" && !m.running) {
        const next = turnBufferRef.current.map((x, j) =>
          j === i ? { ...x, content: `${x.content}\n${delegateResultLine(observation)}` } : x,
        );
        turnBufferRef.current = next;
        setDynamicMessages(next);
        return true;
      }
    }
    return false;
  }, []);

  // 订阅 delegate 子 agent 事件：一次委托一张卡，childTool 原地更新（帧高纪律）
  useEffect(() => {
    return onDelegateEvent((e) => {
      const key = delegateCardKey(e.runId);
      if (e.type === "start") {
        delegateActivityRef.current.set(e.runId, { agent: e.agent, task: e.task, count: 0 });
        emit({
          role: "tool",
          name: "delegate",
          key,
          running: true,
          timestamp: new Date(),
          content: renderDelegateBody({ agent: e.agent, task: e.task, count: 0 }),
        });
        return;
      }
      const activity = delegateActivityRef.current.get(e.runId);
      if (e.type === "childTool") {
        if (!activity) return;
        activity.count += 1;
        const raw = typeof e.input === "string" ? e.input : (JSON.stringify(e.input) ?? "");
        activity.lastTool = `${e.tool}(${raw.slice(0, 60)})`;
        patchCard(key, (msg) => ({ ...msg, content: renderDelegateBody(activity) }));
        return;
      }
      // end：settle 卡片；卡若已溢出进 <Static>，补一条系统行兜底，别让终态消失
      const finalLine = delegateFinalLine(activity, e.ok, e.outputChars, e.error);
      delegateActivityRef.current.delete(e.runId);
      const patched = patchCard(key, (msg) => ({
        ...msg,
        running: false,
        content: renderDelegateBody(activity ?? { agent: e.agent, task: "", count: 0 }, finalLine),
      }));
      if (!patched) {
        emit({
          role: "system",
          content: `delegate[${e.agent}] ${finalLine}`,
          timestamp: new Date(),
        });
      }
    });
  }, [emit, patchCard]);

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
      turnStartRef.current = Date.now();
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
          // 升档提示走当轮卡片，回合收尾统一落 <Static>——
          // 回合中途 setStaticMessages 会让终端滚动、Ink 擦错区域（状态行重复的根源）
          emit({
            role: "system",
            content: autoChip,
            timestamp: new Date(),
          });
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
            // delegate：过程已由事件卡实时展示，父步骤只把终稿摘要并入该卡；
            // 找不到事件卡（如子 agent 秒败）才退回普通 Calling 卡
            if (step.action.tool === "delegate") {
              const obs = String(step.observation ?? "");
              if (!settleDelegateResult(obs)) {
                emit({
                  role: "tool",
                  content: `Calling: delegate\n→ ${obs.slice(0, 200)}`,
                  name: "delegate",
                  timestamp: new Date(),
                });
              }
              continue;
            }
            // 普通工具：同名连续调用合并成 ×N 卡（不再一次调用一张卡刷屏）
            settleTool(step.action.tool, `→ ${String(step.observation).slice(0, 200)}`);
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
              // delegate：子 agent 活动由事件卡实时展示（onDelegateEvent 订阅），
              // 且这里的 step 到达时执行已完成——running 卡没有意义，结果在 onToolEnd 并入
              if (tool === "delegate") return;
              turnBufferRef.current = capTurnCards(
                pushToolCallStart(turnBufferRef.current, tool, JSON.stringify(input, null, 2)),
                currentCardLimit(),
              );
              setDynamicMessages(turnBufferRef.current);
            },
            onToolEnd(result) {
              if (result.tool === "delegate") {
                settleDelegateResult(result.output);
                return;
              }
              // 同名连续调用在 settleToolCall 里合并成 ×N 卡
              settleTool(result.tool, `→ ${result.output}`);
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
        turnStartRef.current = 0;
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
  //   [当轮卡片] (0-{cardsLimit} 张: 工具调用 / PTC 程序 / plan 卡片)
  //   [streaming text] (0-{previewRows} 行，markdown 渲染)
  //   [审批 / 提问卡片] (0-1 张)
  //   [思考指示 / 等待确认] (0-1 行，**输入框上方**)
  //   > input (3 lines)
  //
  // 当轮卡片与流式文本在**同一层**，所以整块原子重绘、顺序稳定；
  // 回合结束时卡片才整体落入 <Static>（见 commitTurnBuffer）。
  //
  // ★ 帧高纪律（2026-09-16）：整个 dynamic 区高度必须 < 终端行数。
  //   超了 Ink 的 eraseLines 会被夹在屏幕首行 → 输入框跑到顶部 + 下方大片空白。
  //   所以下面的卡片数、卡片正文行数、预览行数**全部**来自 computeDynamicBudget。
  // ------------------------------------------------------------------
  const cols = terminalColumns();
  const budget = computeDynamicBudget(terminalRows(), {
    // 审批 / 提问卡片（带边框 3~6 行）出现时先从预算里扣掉
    approvalRows: pendingRequest ? 6 : 0,
  });
  // 预览：源文本按「行预算」裁尾部（中文折行也算得准），再交给 markdown 渲染；
  // 渲染会加 "│ " 排水沟/缩进，所以列宽先留出 4 列，宁可少给一行也不许溢出。
  const previewSource = streamingText
    ? tailByRows(streamingText, { rows: budget.previewRows, columns: Math.max(20, cols - 4) })
    : "";
  const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
  const elapsedSec = running && turnStartRef.current > 0
    ? ((Date.now() - turnStartRef.current) / 1000).toFixed(1)
    : "0.0";

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

        {/* 当轮卡片（dynamic）：回合收尾时整体落入 <Static>，中途不插队。
            plan 卡多给 2 行正文预算（goal + 步骤状态比普通卡需要更多行，
            且 computeDynamicBudget 的槽位口径就是 cardBodyRows+2，不破坏帧高预算） */}
        {dynamicMessages.map((msg, i) => (
          <MessageItem
            key={`dyn-${i}`}
            msg={msg}
            agentName={agentName}
            bodyRows={
              typeof msg.content === "string" && msg.content.startsWith(PLAN_MESSAGE_MARKER)
                ? budget.cardBodyRows + 2
                : budget.cardBodyRows
            }
            columns={Math.max(20, cols - 3)}
          />
        ))}

        {/* Streaming text (dynamic)：markdown 渲染 + 按行预算裁尾部。
            固定 height：流式时每帧文字增减不再推挤下方（思考指示/输入框不再上下震动）；
            maxRows 是渲染后的块级行数硬保证（markdown 会扩展，tailByRows 只钳源文本）。 */}
        {running || previewSource ? (
          <Box flexDirection="column" marginBottom={1} height={budget.previewRows + 1}>
            <AgentLabel agentName={agentName} />
            <Box paddingLeft={2}>
              <MarkdownView
                text={previewSource}
                columns={Math.max(20, cols - 2)}
                maxCodeRows={budget.previewRows}
                maxRows={budget.previewRows}
              />
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

        {/* 思考指示：紧贴输入框**上方**（原来在输入框下面 → 输入框看着不在帧底）。
            审批等待时改口径：那是等用户，不是模型在思考。 */}
        {running ? (
          <Box paddingX={1}>
            {pendingRequest ? (
              <Text color="yellow">{"⏸ 等待你的确认…"}</Text>
            ) : (
              <Text color="yellow">
                {`${spinner} Agent is thinking… ${elapsedSec}s`}
              </Text>
            )}
          </Box>
        ) : null}

        {/* Input (dynamic) */}
        <Input
          onSubmit={onSubmit}
          disabled={running || !!pendingRequest}
          agentMode={agentMode}
          onToggleAgentMode={handleToggleAgentMode}
        />
      </Box>
    </Box>
  );
}
