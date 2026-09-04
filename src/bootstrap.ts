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
import { existsSync, readFileSync } from "node:fs";
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
import { ResumeStore } from "./resume/store.js";
import { ResumeSearchTool } from "./resume/search-tool.js";
import { parseResume } from "./resume/parser.js";
import { SkillRegistry } from "./skills/registry.js";
import { createTools } from "./tools/registry.js";
import { ToolStatsRegistry } from "./tools/stats-registry.js";
import { ToolFilter } from "./tools/tool-filter.js";
import { PermissionWrapper } from "./tools/permission.js";

export interface BootstrapAgentOptions {
  /** 注入外部 llm（mock 用）；不传则 createChatModel(config) */
  llm?: ChatOpenAI;
  /** 注入 tracer（perf runner 每条任务独立 session 用）；不传则 new Tracer() */
  tracer?: Tracer;
}

export interface BootstrapResult {
  config: AppConfig;
  llm: ChatOpenAI;
  embeddings: OpenAIEmbeddings;
  pool: Pool;
  memory: AgentMemory;
  ragStore: PgVectorStore;
  ragTool: RagSearchTool;
  resumeTool: ResumeSearchTool | undefined;
  resumeSummary: string | undefined;
  skillTools: StructuredTool[];
  tracer: Tracer;
  toolStatsRegistry: ToolStatsRegistry;
  toolFilter: ToolFilter;
  /** 全部可用工具（含 RAG/resume/skills 的 read 包装），已注册统计 */
  tools: StructuredTool[];
  systemPrompt: string;
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

  // Resume setup
  let resumeSummary: string | undefined;
  let resumeTool: ResumeSearchTool | undefined;

  if (existsSync("resume.md")) {
    try {
      const resumeStore = await ResumeStore.create("navigate.db", embeddings);
      const rawMd = readFileSync("resume.md", "utf-8");
      const resumeData = parseResume("resume.md");

      const hash = md5(rawMd);
      if (await resumeStore.hasChanged(hash)) {
        await resumeStore.import(resumeData, rawMd);
        console.log("Resume indexed successfully");
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
  // 辅助：把非核心工具（RAG/简历/技能）也包装为只读并注册，保证统计完整
  const wrapRead = (tool: StructuredTool): StructuredTool =>
    new PermissionWrapper(tool, "read", undefined, toolStatsRegistry);

  const tools: StructuredTool[] = [
    ...createTools(toolStatsRegistry),
    wrapRead(ragTool),
    ...(resumeTool ? [wrapRead(resumeTool)] : []),
    ...skillTools.map(wrapRead),
  ];

  const systemPrompt = buildSystemPrompt(resumeSummary);

  return {
    config,
    llm,
    embeddings,
    pool,
    memory,
    ragStore,
    ragTool,
    resumeTool,
    resumeSummary,
    skillTools,
    tracer,
    toolStatsRegistry,
    toolFilter,
    tools,
    systemPrompt,
  };
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}