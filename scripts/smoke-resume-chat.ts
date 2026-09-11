/**
 * 简历问答端到端冒烟（真实链路，非 mock）
 *
 * 起一个临时端口，用与 server-entry 完全一致的装配方式（loader → parser → ResumeStore
 * → GraphAgentExecutor + ReadOnlyToolFilter），向 /api/resume/chat 提几个问题，打印回答。
 *
 * 存在的理由：索引「跑通了」不等于「答得出」。0 章节的简历会让接口正常返回 200
 * 却对任何问题都答「简历中未提及」——这种静默空索引故障只有真问一句才能暴露。
 * （2026-09-11 实测：一份 docx 简历因分节标题不被识别，索引为空但服务健康。）
 *
 * 用法：npx tsx scripts/smoke-resume-chat.ts
 * 注意：会真实调用 LLM（DeepSeek）与本地 embedding，产生少量费用。
 */
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config/index.js";
import { createChatModel, createEmbeddings } from "../src/agent/langchain.js";
import { getPool } from "../src/storage/pool.js";
import { PgVectorStore } from "../src/storage/pg-vector-store.js";
import { ResumeStore } from "../src/resume/store.js";
import { ResumeSearchTool } from "../src/resume/search-tool.js";
import { loadResumeSource } from "../src/resume/loader.js";
import { parseResumeText } from "../src/resume/parser.js";
import { buildResumeSystemPrompt } from "../src/resume/prompt.js";
import { GraphAgentExecutor } from "../src/agent/graph-agent-executor.js";
import { ReadOnlyToolFilter } from "../src/tools/tool-filter.js";
import { PermissionWrapper } from "../src/tools/permission.js";
import { ToolStatsRegistry } from "../src/tools/stats-registry.js";
import { buildApproval, resolveApprovalMode } from "../src/tools/human-channel.js";
import { createRagServer } from "../src/server/index.js";

/** 冒烟问题：前两条验检索质量，最后一条验权限边界（应被拒绝） */
const QUESTIONS = ["他的工作经历是什么？", "他熟悉哪些技术栈？", "帮我执行 ls 列出目录"];

process.env.H5_LOGIN_USERNAME = "admin";
process.env.H5_LOGIN_PASSWORD = "secret";
process.env.H5_LOGIN_USERS = "";
process.env.H5_WIKI_PROXY_PORT = "0";
process.env.H5_USERS_FILE = path.join(os.tmpdir(), `h5-users-smoke-${process.pid}.json`);

const config = loadConfig();
const llm = createChatModel(config);
const embeddings = createEmbeddings(config);
const ragStore = new PgVectorStore(await getPool(config), embeddings);

// ——— 与 server-entry 一致的简历装配 ———
const src = await loadResumeSource();
if (!src) throw new Error("未找到 resume.md / resume.docx");
const store = await ResumeStore.create(
  path.join(os.tmpdir(), `resume-smoke-${process.pid}.db`),
  embeddings,
);
const data = parseResumeText(src.text);
console.log(
  `[装配] 源=${src.sourcePath} 归一化长度=${src.text.length} 章节=${data.sections.length} 姓名=${data.name || "(未识别)"}`,
);
if (data.sections.length === 0) {
  throw new Error("0 章节 —— 索引将为空，应触发空索引守卫（见 server-entry.ts）");
}
await store.import(data, src.text);
const summary = await store.getSummary();
console.log(`[装配] getSummary=${JSON.stringify(summary)}`);

const { channel, policy } = buildApproval(resolveApprovalMode(process.env.APPROVAL_POLICY, "deny"));
const resumeTool = new PermissionWrapper(
  new ResumeSearchTool(store),
  "read",
  undefined,
  new ToolStatsRegistry(),
  channel,
  policy,
);
const resumeExecutor = new GraphAgentExecutor(
  llm,
  [resumeTool],
  buildResumeSystemPrompt(summary),
  Math.min(config.maxIterations, 8),
  undefined,
  new ReadOnlyToolFilter(),
  undefined,
  config.llmTimeoutMs,
);

const app = createRagServer(ragStore, 0, store, data, undefined, resumeExecutor);
const server = (app as unknown as { httpServer: import("node:http").Server }).httpServer;
await new Promise<void>((r) => server.once("listening", () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const login = await fetch(base + "/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
console.log(`[登录] HTTP ${login.status}\n`);

for (const q of QUESTIONS) {
  const t0 = Date.now();
  const res = await fetch(base + "/api/resume/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ question: q }),
  });
  const body = await res.text();
  console.log("=".repeat(70));
  console.log(`❓ ${q}`);
  console.log(`   HTTP ${res.status}  ${Date.now() - t0}ms`);
  console.log("─".repeat(70));
  console.log(body.slice(0, 1200));
  console.log("");
}

server.closeAllConnections?.();
server.close();
process.exit(0);
