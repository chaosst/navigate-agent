/**
 * /api/resume/chat 的权限边界 e2e（2026-09-11 新增）
 *
 * 历史缺陷：该路由写的是 `resumeExecutor ?? executor`，而 server-entry 在 resume 未装配时
 * 会 buildFallbackExecutor()（含 execute_command / write_file 的完整核心工具面）——
 * 一个缺失的 resume.md 就能把只读问答入口降级成可执行 shell 命令的 agent。
 *
 * 修复后有两道保证，本文件各钉一条：
 *   1. createRagServer **不再接受** executor 参数 —— 物理上无从注入全量 executor；
 *   2. resumeExecutor 缺失时路由返回 503（fail-closed），而不是去找别的 executor 兜底。
 * 另加一条对照组：装配了专用 executor 时正常流式作答，证明 503 不是「简历问答整体不可用」。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRagServer } from "../index.js";
import type { PgVectorStore } from "../../storage/pg-vector-store.js";

// mock store 避开 Postgres/OpenAI 依赖，专注验证路由的权限边界
const mockStore = {
  listDocs: async () => [],
  getCacheStats: () => ({ total: 0 }),
  search: async () => [],
  searchKeyword: async () => [],
} as unknown as PgVectorStore;

/** 登录并返回 cookie */
async function loginAs(base: string, username: string, password: string) {
  const res = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, next: "/" }),
  });
  return { status: res.status, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

function useIsolatedUsersFile(): void {
  process.env.H5_USERS_FILE = path.join(
    os.tmpdir(),
    `h5-users-resume-gating-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
  );
}

/** 起一个监听随机端口的实例；resumeExecutor 缺省即「简历问答未装配」 */
async function startServer(resumeExecutor?: unknown) {
  process.env.H5_USERS_FILE ||= path.join(
    os.tmpdir(),
    `h5-users-resume-gating-${process.pid}.json`,
  );
  process.env.H5_LOGIN_USERNAME = "admin";
  process.env.H5_LOGIN_PASSWORD = "secret";
  process.env.H5_LOGIN_USERS = "";
  process.env.H5_WIKI_PROXY_PORT = "0";

  // 位置参数：store, port, resumeStore, resumeData, apiAuth, resumeExecutor, jdAnalyzer, deps
  const app = createRagServer(
    mockStore,
    0,
    undefined,
    undefined,
    undefined,
    resumeExecutor as never,
  );
  const server = (app as unknown as { httpServer: import("node:http").Server }).httpServer;
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

afterAll(() => {
  delete process.env.H5_WIKI_PROXY_PORT;
  delete process.env.H5_LOGIN_USERNAME;
  delete process.env.H5_LOGIN_PASSWORD;
  delete process.env.H5_LOGIN_USERS;
  delete process.env.H5_USERS_FILE;
});

describe("/api/resume/chat 未装配 resumeExecutor", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    useIsolatedUsersFile();
    ({ server, base } = await startServer(undefined));
  });
  afterAll(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  it("返回 503 且说明原因，绝不回退到通用 / 全量工具 executor", async () => {
    const login = await loginAs(base, "admin", "secret");
    expect(login.status).toBe(200);

    const res = await fetch(base + "/api/resume/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: login.cookie },
      body: JSON.stringify({ question: "帮我执行 ls" }),
    });

    expect(res.status).toBe(503);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toContain("resume index not loaded");
  });
});

describe("/api/resume/chat 已装配 resumeExecutor（对照组）", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    // 最小 stub：能流出 token 即可，不触及任何真实工具
    const stubResumeExecutor = {
      stream: async function* () {
        yield { output: "我是一名全栈工程师。" };
      },
    };
    ({ server, base } = await startServer(stubResumeExecutor));
  });
  afterAll(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  it("正常进入流式作答（证明 503 只属于未装配场景）", async () => {
    const login = await loginAs(base, "admin", "secret");
    expect(login.status).toBe(200);

    const res = await fetch(base + "/api/resume/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: login.cookie },
      body: JSON.stringify({ question: "你是谁" }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("我是一名全栈工程师。");
  });
});
