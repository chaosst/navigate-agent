#!/usr/bin/env node
import "dotenv/config";
import React from "react";
import { render } from "ink";
import { App } from "./tui/app.js";
import { loadConfig } from "./config/index.js";
import { createChatModel } from "./agent/langchain.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { createAgentExecutor } from "./agent/loop.js";
import { createTools } from "./tools/registry.js";
import type { StructuredTool } from "@langchain/core/tools";
import { OpenAIEmbeddings } from "@langchain/openai";
import { AgentMemory } from "./memory/index.js";
import { RagVectorStore } from "./rag/vectorstore.js";
import { RagSearchTool } from "./rag/retriever.js";
import { createRagServer } from "./server/index.js";
import { ResumeStore } from "./resume/store.js";
import { WikiStore } from "./wiki/store.js";
import { ResumeSearchTool } from "./resume/search-tool.js";
import { parseResume } from "./resume/parser.js";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SkillRegistry } from "./skills/registry.js";

async function main() {
  const config = loadConfig();
  const llm = createChatModel(config);

  const embeddings = new OpenAIEmbeddings({
    apiKey: config.openAIApiKey,
    model: "text-embedding-3-small",
  });

  const memory = await AgentMemory.create("navigate.db", embeddings);

  // RAG setup
  const ragStore = new RagVectorStore(embeddings, "rag_data");
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

  // Wiki setup
  let wikiStore: WikiStore | undefined;
  try {
    wikiStore = await WikiStore.create("navigate.db", ragStore);
    console.log("Wiki knowledge base initialized");
  } catch (err) {
    console.warn("Wiki initialization skipped:", (err as Error).message);
  }

  // Skill system setup
  let skillTools: StructuredTool[] = [];
  try {
    const skillRegistry = new SkillRegistry("skills");
    skillTools = await skillRegistry.loadAll();
  } catch (err) {
    console.warn("Skill loading skipped:", (err as Error).message);
  }

  const allTools = [
    ...createTools(),
    ragTool,
    ...(resumeTool ? [resumeTool] : []),
    ...skillTools,
  ];

  const systemPrompt = buildSystemPrompt(resumeSummary);
  const executor = await createAgentExecutor(llm, allTools, systemPrompt, config.maxIterations);

  createRagServer(ragStore, 3001, executor, resumeStore, resumeData, wikiStore);

  render(React.createElement(App, { executor, memory }));
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
