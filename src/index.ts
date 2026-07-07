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

async function main() {
  const config = loadConfig();
  const llm = createChatModel(config);
  const tools = createTools();
  const systemPrompt = buildSystemPrompt();
  const executor = await createAgentExecutor(llm, tools, systemPrompt, config.maxIterations);
  render(React.createElement(App, { executor }));
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
