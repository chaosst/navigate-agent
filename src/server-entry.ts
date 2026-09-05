#!/usr/bin/env node
/**
 * Server-only entry point — starts the web server (RAG, Wiki, Resume)
 * without the TUI chat interface.
 *
 * Usage: npx tsx src/server-entry.ts
 */
import "dotenv/config";
import { loadConfig } from "./config/index.js";
import { createChatModel, createEmbeddings } from "./agent/langchain.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { createAgentExecutor, createPtcAgent } from "./agent/loop.js";
import { GraphAgentExecutor } from "./agent/graph-agent-executor.js";
import { buildResumeSystemPrompt } from "./resume/prompt.js";
import { analyzeJdMatch, serializeResumeForJd } from "./resume/jd-analyzer.js";
import type { JdMatchResult } from "./resume/jd-analyzer.js";
import type { ResumeData } from "./resume/types.js";
import { loadResumeSource } from "./resume/loader.js";
import { createTools } from "./tools/registry.js";
import type { StructuredTool } from "@langchain/core/tools";
import { PgVectorStore } from "./storage/pg-vector-store.js";
import { getPool } from "./storage/pool.js";
import { RagSearchTool } from "./rag/retriever.js";
import { createRagServer } from "./server/index.js";
import { ResumeStore } from "./resume/store.js";
import { ResumeSearchTool } from "./resume/search-tool.js";
import { parseResumeText } from "./resume/parser.js";
import { createHash } from "node:crypto";
import { SkillRegistry } from "./skills/registry.js";
import { ApiKeyStore } from "./server/key-store.js";
import type { ApiKeyAuthConfig } from "./server/api-key-auth.js";
import { ToolStatsRegistry } from "./tools/stats-registry.js";
import { PermissionWrapper } from "./tools/permission.js";

async function main() {
  const config = loadConfig();
  const apiAuth: ApiKeyAuthConfig | undefined =
    config.apiKeys || config.apiKeyLegacy
      ? {
          keyStore: ApiKeyStore.fromEnv(config.apiKeys, config.apiKeyLegacy),
          ipWhitelist: config.apiIpWhitelist
            ? config.apiIpWhitelist.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
          signatureWindowMs: config.apiSignatureWindowMs,
          trustProxy: config.apiTrustProxy,
          failureLimit: config.apiFailureLimit,
          failureWindowMs: config.apiFailureWindowMs,
        }
      : undefined;
  const llm = createChatModel(config);

  const embeddings = createEmbeddings(config)

  // RAG setup
  const pool = await getPool(config);
  const ragStore = new PgVectorStore(pool, embeddings);

  /**
   * 完整能力主 agent（仅 resume 未装配时的 resume chat 兜底需要）：
   * rag / skill / 核心工具 + 统计注册表全部在这里装配，避免 resume 场景下空转。
   */
  async function buildFallbackExecutor() {
    const ragTool = new RagSearchTool(ragStore);
    let skillTools: StructuredTool[] = [];
    try {
      const skillRegistry = new SkillRegistry("skills");
      skillTools = await skillRegistry.loadAll();
    } catch (err) {
      console.warn("Skill loading skipped:", (err as Error).message);
    }
    // 统计注册表：核心工具经 PermissionWrapper 包装后注册（统计/限流/熔断生效）
    const toolStatsRegistry = new ToolStatsRegistry();
    const wrapRead = (tool: StructuredTool): StructuredTool =>
      new PermissionWrapper(tool, "read", undefined, toolStatsRegistry);
    const allTools = [
      ...createTools(toolStatsRegistry),
      wrapRead(ragTool),
      ...skillTools.map(wrapRead),
    ];
    const systemPrompt = buildSystemPrompt(undefined);
    return config.agentMode === "ptc"
      ? createPtcAgent(llm, allTools, {
          maxIterations: config.maxIterations,
          ptc: {
            maxProgramLength: config.ptcMaxProgramLength,
            maxWallMs: config.ptcMaxWallMs,
            maxOutputBytes: config.ptcMaxOutputBytes,
            maxParallelSubCalls: config.ptcMaxParallelSubCalls,
            mode: config.ptcMode,
          },
          toolStatsRegistry,
          llmTimeoutMs: config.llmTimeoutMs,
        })
      : createAgentExecutor(llm, allTools, systemPrompt, config.maxIterations, toolStatsRegistry, undefined, undefined, config.llmTimeoutMs);
  }

  // Resume setup — 入口归一化：resume.md 优先，其次 resume.docx（mammoth 本地转 md）。
  // 下游（结构化解析 / RAG / JD 诊断 / 展示页）只消费归一化后的 markdown 单一事实源。
  let resumeSummary: string | undefined;
  let resumeTool: ResumeSearchTool | undefined;
  let resumeData: Awaited<ReturnType<typeof parseResumeText>> | undefined;
  let resumeStore: ResumeStore | undefined;
  let resumeMarkdown: string | undefined;

  const resumeSource = await loadResumeSource();
  if (resumeSource) {
    try {
      resumeStore = await ResumeStore.create("navigate.db", embeddings);
      resumeMarkdown = resumeSource.text;
      resumeData = parseResumeText(resumeMarkdown);

      const hash = md5(resumeMarkdown);
      if (await resumeStore.hasChanged(hash)) {
        await resumeStore.import(resumeData, resumeMarkdown);
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

  // 简历问答专用 sub-agent（最小权限面）：
  // - 工具集只有 resumeTool（不含 shell/文件/web 等），LLM 想越界也没有工具可用；
  // - 不传 toolStatsRegistry / tracer → finalize 时 buildStatsFooter() 输出空串，
  //   回答末尾不会带主 agent 的「工具调用统计 / Tokens」脚注；
  // - 专用 system prompt 固化「只答简历 + 越界拒绝」规则。
  let resumeExecutor: GraphAgentExecutor | undefined;
  if (resumeTool) {
    resumeExecutor = new GraphAgentExecutor(
      llm,
      [resumeTool],
      buildResumeSystemPrompt(resumeSummary),
      Math.min(config.maxIterations, 8), // 简历问答检索收敛快，限制轮数防烧钱
      undefined, // toolStatsRegistry — 故意不传（消除脚注）
      undefined, // toolFilter
      undefined, // tracer
      config.llmTimeoutMs,
    );
  }

  // JD 匹配诊断器：结构化紧凑序列化（serializeResumeForJd）而非 resume.md 原文——
  // 去 frontmatter/装饰噪音、token 更省；超过 MAX_JD_RESUME_CHARS 时 analyze
  // 抛 ResumeTooLongError，jd-match 路由转可读 400。
  const jdAnalyzer = resumeData
    ? { analyze: (jd: string): Promise<JdMatchResult> => analyzeJdMatch(llm, serializeResumeForJd(resumeData as ResumeData), jd) }
    : undefined;

  // 主 agent（完整能力面：rag / skill / 核心工具）只在 resume 未装配时按需构造，
  // 作为 /api/resume/chat 的兜底（resume chat 优先 resumeExecutor）。
  // resume 装配成功时，web 进程的 agent 面 = resumeExecutor（最小工具集）；
  // 完整能力的入口在 TUI（src/bootstrap.ts + src/index.ts），本进程无需空转构造
  // 一套永远不被调用的 executor + 工具面。
  const executor = resumeExecutor
    ? undefined
    : await buildFallbackExecutor();

  createRagServer(ragStore, 3001, executor, resumeStore, resumeData, apiAuth, resumeExecutor, jdAnalyzer);

  console.log("");
  console.log("──────────────────────────────────────────");
  console.log("  Web server running on http://localhost:3001");
  console.log("  zyplayer-doc on http://localhost:8083");
  console.log("  Agent CLI: npm run dev");
  console.log("──────────────────────────────────────────");

  // Keep the process alive
  await new Promise(() => {});
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
