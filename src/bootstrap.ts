/**
 * bootstrap.ts — Agent 启动接线（从 index.ts 提取，TUI 与 perf runner 共用）
 *
 * 为什么提取：
 *  TUI（index.ts）与性能测试（src/perf/run.ts）需要同一套接线
 *  （llm / embeddings / pool / memory / rag / resume / skills / tools / tracer）。
 *  之前 index.ts 独享这份接线，perf runner 若复制一遍必然漂移。
 *  这里收口为 bootstrapAgent()，两个入口共用，行为不变。
 *
 * 注入点：llm / tracer 可显式传入（perf runner 用 --mock 注入 mock LLM、
 *  给每个任务配独立 tracer session）；不传则走默认（createChatModel + 单例 tracer）。
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import type { StructuredTool } from "@langchain/core/tools";
import type { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import type { Pool } from "pg";
import { loadConfig, type AppConfig } from "./config/index.js";
import { createChatModel, createEmbeddings } from "./agent/langchain.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { Tracer } from "./agent/tracer.js";
import { AgentMemory } from "./memory/index.js";
import { PgVectorStore } from "./storage/pg-vector-store.js";
import { getPool } from "./storage/pool.js";
import { RagSearchTool } from "./rag/retriever.js";
import { ParallelDocsTool } from "./rag/parallel-tool.js";
import { DelegateTool } from "./agent/delegate-tool.js";
import { ResumeStore } from "./resume/store.js";
import { ResumeSearchTool } from "./resume/search-tool.js";
import { parseResumeText } from "./resume/parser.js";
import { loadResumeSource } from "./resume/loader.js";
import { SkillRegistry } from "./skills/registry.js";
import { createTools } from "./tools/registry.js";
import { AskUserTool } from "./tools/ask-user.js";
import { buildApproval, resolveApprovalMode, type ApprovalMode, type HumanChannel } from "./tools/human-channel.js";
import { ToolStatsRegistry } from "./tools/stats-registry.js";
import { ToolFilter } from "./tools/tool-filter.js";
import { PermissionWrapper } from "./tools/permission.js";

export interface BootstrapAgentOptions {
  /** 注入外部 llm（mock 用）；不传则 createChatModel(config) */
  llm?: ChatOpenAI;
  /** 注入 tracer（perf runner 每条任务独立 session 用）；不传则 new Tracer() */
  tracer?: Tracer;
  /** 审批模式；缺省读 APPROVAL_POLICY，再缺省 interactive（TUI 语义） */
  humanMode?: ApprovalMode;
}

export interface BootstrapResult {
  config: AppConfig;
  llm: ChatOpenAI;
  embeddings: OpenAIEmbeddings;
  pool: Pool;
  memory: AgentMemory;
  ragStore: PgVectorStore;
  ragTool: RagSearchTool;
  parallelDocsTool: ParallelDocsTool;
  resumeTool: ResumeSearchTool | undefined;
  resumeSummary: string | undefined;
  skillTools: StructuredTool[];
  tracer: Tracer;
  toolStatsRegistry: ToolStatsRegistry;
  toolFilter: ToolFilter;
  /** 全部可用工具（含 RAG/resume/skills 的 read 包装），已注册统计 */
  tools: StructuredTool[];
  /** 委派子 agent 工具（normal 主 agent 用；profile 按 name 裁剪 child 工具面） */
  delegateTool: DelegateTool;
  systemPrompt: string;
  /** 人在环通道（allow 模式下为 undefined）；TUI 渲染后 attach 交互器 */
  humanChannel?: HumanChannel;
}

export async function bootstrapAgent(
  opts: BootstrapAgentOptions = {},
): Promise<BootstrapResult> {
  const config = loadConfig();
  const llm = opts.llm ?? createChatModel(config);
  const embeddings = createEmbeddings(config);

  // 连接池（被 AgentMemory 和 PgVectorStore 共享）
  const pool = await getPool(config);

  const memory = await AgentMemory.create(pool, embeddings, undefined, undefined, llm);

  // RAG setup
  const ragStore = new PgVectorStore(pool, embeddings);
  const ragTool = new RagSearchTool(ragStore);
  const parallelDocsTool = new ParallelDocsTool(ragStore, llm, {
    maxConcurrency: Math.max(1, Number(process.env.MAX_PARALLEL_WORKERS ?? 4)),
    llmTimeoutMs: config.llmTimeoutMs,
  });

  // Resume setup
  let resumeSummary: string | undefined;
  let resumeTool: ResumeSearchTool | undefined;

  // 走 loader 而非硬编码 resume.md：与 server-entry 共用同一套入口归一化
  // （resume.md 优先 → resume.docx 经 mammoth 转换 + normalizeConvertedMarkdown）。
  // 旧实现直接 existsSync("resume.md")，导致 TUI 完全看不到 provider 无关的 docx 简历。
  const resumeSource = await loadResumeSource();
  if (resumeSource) {
    try {
      const resumeStore = await ResumeStore.create("navigate.db", embeddings);
      const rawMd = resumeSource.text;
      const resumeData = parseResumeText(rawMd);

      // 空索引守卫：0 章节 ⇒ 索引为空 ⇒ 简历问答恒答「未提及」。宁可装配失败也不要静默空转。
      if (resumeData.sections.length === 0) {
        throw new Error(
          "解析出 0 个章节 —— 索引将为空，简历问答无法回答任何问题。" +
            `源文件：${resumeSource.sourcePath}。请确认分节能被识别为 \`## 标题\`。`,
        );
      }

      const hash = md5(rawMd);
      if (await resumeStore.hasChanged(hash)) {
        await resumeStore.import(resumeData, rawMd);
        console.log(`Resume indexed successfully (source: ${resumeSource.sourcePath})`);
      } else {
        console.log("Resume unchanged, using cached index");
      }

      resumeSummary = await resumeStore.getSummary();
      resumeTool = new ResumeSearchTool(resumeStore);
    } catch (err) {
      console.error("Resume loading skipped:", (err as Error).message);
    }
  }

  // Skill system setup
  let skillTools: StructuredTool[] = [];
  try {
    const skillRegistry = new SkillRegistry("skills");
    skillTools = await skillRegistry.loadAll();
  } catch (err) {
    console.warn("Skill loading skipped:", (err as Error).message);
  }

  // 统计与过滤（须先于工具创建：createTools 会把核心工具包装为 PermissionWrapper 并注册）
  const tracer = opts.tracer ?? new Tracer();
  const toolStatsRegistry = new ToolStatsRegistry();
  const toolFilter = new ToolFilter();

  // 人在环：interactive 弹审批（TUI）/ deny 自动拒绝（无人值守）/ allow 全放行
  const approvalMode = opts.humanMode ?? resolveApprovalMode(process.env.APPROVAL_POLICY);
  const { channel: humanChannel, policy: approvalPolicy } = buildApproval(approvalMode);

  // 辅助：把非核心工具（RAG/简历/技能）也包装为只读并注册，保证统计完整
  const wrapRead = (tool: StructuredTool): StructuredTool =>
    new PermissionWrapper(tool, "read", undefined, toolStatsRegistry, humanChannel, approvalPolicy);

  const tools: StructuredTool[] = [
    ...createTools(toolStatsRegistry, humanChannel, approvalPolicy),
    wrapRead(ragTool),
    wrapRead(parallelDocsTool),
    ...(resumeTool ? [wrapRead(resumeTool)] : []),
    ...skillTools.map(wrapRead),
  ];

  // 委派子 agent：父工具全集按 name 裁剪给 child；child 不含 delegate → 深度固定两层。
  // 注：必须 wrapRead 后再 push —— ToolFilter 只认 PermissionWrapper 的 .permission；
  // 裸 DelegateTool 无此属性会被动态工具过滤静默滤掉（normal 主场景将不可见）。
  const delegateTool = new DelegateTool({
    llm,
    tools,
    maxChildIterations: Math.min(config.maxIterations, 8),
    llmTimeoutMs: config.llmTimeoutMs,
  });
  tools.push(wrapRead(delegateTool));

  // agent 主动提问工具：同样必须 wrapRead 后 push（否则被 ToolFilter 静默滤掉）
  if (humanChannel) {
    tools.push(wrapRead(new AskUserTool(humanChannel)));
  }

  const systemPrompt = buildSystemPrompt(resumeSummary, true, true);

  return {
    config,
    llm,
    embeddings,
    pool,
    memory,
    ragStore,
    ragTool,
    parallelDocsTool,
    resumeTool,
    resumeSummary,
    skillTools,
    tracer,
    toolStatsRegistry,
    toolFilter,
    tools,
    delegateTool,
    systemPrompt,
    humanChannel,
  };
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}