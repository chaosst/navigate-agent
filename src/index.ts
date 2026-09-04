#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./tui/app.js";
import { bootstrapAgent } from "./bootstrap.js";
import { closePool } from "./storage/pool.js";

async function main() {
  // Agent 启动接线统一收口到 bootstrap.ts（TUI 与 perf runner 共用）
  const { config, memory, llm, tools, systemPrompt, tracer, toolFilter, toolStatsRegistry } =
    await bootstrapAgent();

  render(React.createElement(App, {
    config,
    memory,
    agentName: "Navigate",
    llm,
    tools,
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

main().catch(err => { console.error("Fatal:", err); process.exit(1); });