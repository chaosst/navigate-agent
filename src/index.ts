#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./tui/app.js";
import { bootstrapAgent } from "./bootstrap.js";
import { closePool } from "./storage/pool.js";
import { installConsoleGuard } from "./tui/console-guard.js";

async function main() {
  // Agent 启动接线统一收口到 bootstrap.ts（TUI 与 perf runner 共用）
  const { config, memory, llm, tools, systemPrompt, tracer, toolFilter, toolStatsRegistry, humanChannel } =
    await bootstrapAgent();

  // 关键时序：启动期日志（Resume indexed / skills loading）留在终端——
  // 那时 Ink 还没挂载，写 stdout 无害。挂载之后 stdout 归 Ink 独占，
  // 任何 console.* 都会打乱擦帧（见 console-guard.ts 注释），必须改道到 agent.log。
  installConsoleGuard();

  render(React.createElement(App, {
    config,
    memory,
    agentName: "Navigate",
    llm,
    tools,
    systemPrompt,
    tracer,
    toolFilter,
    toolStatsRegistry,
    humanChannel,
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