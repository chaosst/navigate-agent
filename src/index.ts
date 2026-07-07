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
import { OpenAIEmbeddings } from "@langchain/openai";
import { AgentMemory } from "./memory/index.js";

async function main() {
  const config = loadConfig();
  const llm = createChatModel(config);
  const tools = createTools();
  const systemPrompt = buildSystemPrompt();
  const executor = await createAgentExecutor(llm, tools, systemPrompt, config.maxIterations);
  const embeddings = new OpenAIEmbeddings({
    apiKey: config.openAIApiKey,
    model: "text-embedding-3-small",
  });
  const memory = await AgentMemory.create("navigate.db", embeddings);
  render(React.createElement(App, { executor, memory }));
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
