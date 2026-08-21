#!/usr/bin/env node
import "dotenv/config";
import React from "react";
import { render } from "ink";
import { App } from "./tui/app.js";
import { loadConfig } from "./config/index.js";
import { createChatModel } from "./agent/langchain.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { createTools } from "./tools/registry.js";
import type { StructuredTool } from "@langchain/core/tools";
import { OpenAIEmbeddings } from "@langchain/openai";
import { AgentMemory } from "./memory/index.js";
import { PgVectorStore } from "./storage/pg-vector-store.js";
import { getPool, closePool } from "./storage/pool.js";
import { RagSearchTool } from "./rag/retriever.js";
import { ResumeStore } from "./resume/store.js";
import { ResumeSearchTool } from "./resume/search-tool.js";
import { parseResume } from "./resume/parser.js";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SkillRegistry } from "./skills/registry.js";
import { Tracer } from "./agent/tracer.js";
import { ToolStatsRegistry } from "./tools/stats-registry.js";
import { ToolFilter } from "./tools/tool-filter.js";
import { PermissionWrapper } from "./tools/permission.js";

async function main() {
  const config = loadConfig();
  const llm = createChatModel(config);

  const embeddings = new OpenAIEmbeddings({
    apiKey: config.openAIApiKey,
    model: config.embeddingModel,
    // baseURL 默认与 LLM 一致；若你的 API 无 embedding 模型，摘要检索会降级关键词（不致命）
    ...(config.baseURL ? { configuration: { baseURL: config.baseURL } } : {}),
  });

  // 连接池（被 AgentMemory 和 PgVectorStore 共享）
  const pool = await getPool(config);

  const memory = await AgentMemory.create(pool, embeddings);

  // RAG setup
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

  // 统计与过滤（须先于工具创建：createTools 会把核心工具包装为 PermissionWrapper 并注册）
  const tracer = new Tracer()
  const toolStatsRegistry = new ToolStatsRegistry()
  const toolFilter = new ToolFilter()
  // 辅助：把非核心工具（RAG/简历/技能）也包装为只读并注册，保证统计完整
  const wrapRead = (tool: StructuredTool): StructuredTool =>
    new PermissionWrapper(tool, "read", undefined, toolStatsRegistry)

  const allTools = [
    ...createTools(toolStatsRegistry),
    wrapRead(ragTool),
    ...(resumeTool ? [wrapRead(resumeTool)] : []),
    ...skillTools.map(wrapRead),
  ];

  const systemPrompt = buildSystemPrompt(resumeSummary);

  render(React.createElement(App, {
    config,
    memory,
    agentName: "Navigate",
    llm,
    tools: allTools,
    systemPrompt,
    tracer,
    toolFilter,
    toolStatsRegistry
  }));

  process.on("SIGINT", async () => {
    await closePool();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await closePool();
    process.exit(0);
  });
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
