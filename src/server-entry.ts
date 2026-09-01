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
import { createTools } from "./tools/registry.js";
import type { StructuredTool } from "@langchain/core/tools";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PgVectorStore } from "./storage/pg-vector-store.js";
import { getPool } from "./storage/pool.js";
import { RagSearchTool } from "./rag/retriever.js";
import { createRagServer } from "./server/index.js";
import { ResumeStore } from "./resume/store.js";
import { ResumeSearchTool } from "./resume/search-tool.js";
import { parseResume } from "./resume/parser.js";
import { existsSync, readFileSync } from "node:fs";
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
  const ragTool = new RagSearchTool(ragStore);

  // Resume setup
  let resumeSummary: string | undefined;
  let resumeTool: ResumeSearchTool | undefined;
  let resumeData: Awaited<ReturnType<typeof parseResume>> | undefined;
  let resumeStore: ResumeStore | undefined;

  if (existsSync("resume.md")) {
    try {
      resumeStore = await ResumeStore.create("navigate.db", embeddings);
      const rawMd = readFileSync("resume.md", "utf-8");
      resumeData = parseResume("resume.md");

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

  // 统计注册表：核心工具经 PermissionWrapper 包装后注册（统计/限流/熔断生效）
  const toolStatsRegistry = new ToolStatsRegistry()
  const wrapRead = (tool: StructuredTool): StructuredTool =>
    new PermissionWrapper(tool, "read", undefined, toolStatsRegistry)

  const allTools = [
    ...createTools(toolStatsRegistry),
    wrapRead(ragTool),
    ...(resumeTool ? [wrapRead(resumeTool)] : []),
    ...skillTools.map(wrapRead),
  ];

  const systemPrompt = buildSystemPrompt(resumeSummary);
  const executor =
    config.agentMode === "ptc"
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

  createRagServer(ragStore, 3001, executor, resumeStore, resumeData, apiAuth);

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
