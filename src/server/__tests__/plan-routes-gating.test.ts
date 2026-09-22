/**
 * /agent/plan 页面 + /api/agent/plan 接口的权限边界 e2e（2026-09-22 新增）
 *
 * 为什么不止有 handler 单测：plan-chat.test.ts 直接双参调 handler，绕过了
 * requireAdminApi / requirePage 两个中间件 —— 而「guest 不能进」这条保证恰恰
 * 全在中间件里。本文件起一个真监听端口的实例、走真 HTTP，把三道门各钉一条：
 *
 *   ① 页面 /agent/plan      → requirePage(ADMIN_ROLES)：guest 403
 *   ② 接口 /api/agent/plan  → requireAdminApi：guest 403
 *   ③ 未装配 planStream      → 503（fail-closed，绝不回退全量工具集）
 *   ④ 直连 /agent-plan.html  → 302 到带门禁的规范路由（静态目录绕过防线）
 *   ⑤ 已装配                 → admin 200 且能看到真实 SSE 帧（证明 503 只属未装配）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRagServer } from "../index.js";
import type { PgVectorStore } from "../../storage/pg-vector-store.js";

const mockStore = {
  listDocs: async () => [],
  getCacheStats: () => ({ total: 0 }),
  search: async () => [],
  searchKeyword: async () => [],
} as unknown as PgVectorStore;

/** 最小 stub：能流出 plan → tool → answer 三路 chunk 即可，不触及任何真实工具 / LLM */
const stubPlanStream = () =>
  (async function* () {
    yield {
      plan: {
        goal: "整理 docs",
        currentStepIndex: 0,
        createdAt: 1,
        updatedAt: 2,
        steps: [{ id: "s1", description: "读文件", status: "completed", result: "14 个文件" }],
      },
    };
    yield { intermediateSteps: [{ action: { tool: "read_file", toolInput: { path: "a.md" } }, observation: "A" }] };
    yield { output: "汇总完成" };
  })();

async function loginAs(base: string, url: string, body: unknown) {
  const res = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

function useIsolatedUsersFile(): void {
  process.env.H5_USERS_FILE = path.join(
    os.tmpdir(),
    `h5-users-plan-gating-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
  );
}

/** 起一个监听随机端口的实例；planStream 缺省即「编排视图未装配」 */
async function startServer(planStream?: unknown) {
  process.env.H5_LOGIN_USERNAME = "admin";
  process.env.H5_LOGIN_PASSWORD = "secret";
  process.env.H5_GUEST_USERNAME = "guest";
  process.env.H5_GUEST_PASSWORD = "gw";
  process.env.H5_LOGIN_USERS = "";
  process.env.H5_WIKI_PROXY_PORT = "0";

  const app = createRagServer(
    mockStore,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { planStream: planStream as never },
  );
  const server = (app as unknown as { httpServer: import("node:http").Server }).httpServer;
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

afterAll(() => {
  for (const k of ["H5_WIKI_PROXY_PORT", "H5_LOGIN_USERNAME", "H5_LOGIN_PASSWORD", "H5_GUEST_USERNAME", "H5_GUEST_PASSWORD", "H5_LOGIN_USERS", "H5_USERS_FILE"]) {
    delete process.env[k];
  }
});

describe("编排视图已装配：三道门 + 静态绕过", () => {
  let server: import("node:http").Server;
  let base: string;
  let adminCookie = "";
  let guestCookie = "";

  beforeAll(async () => {
    useIsolatedUsersFile();
    ({ server, base } = await startServer(stubPlanStream));
    adminCookie = (await loginAs(base, "/api/login", { username: "admin", password: "secret", next: "/" })).cookie;
    guestCookie = (await loginAs(base, "/api/login/guest", { next: "/" })).cookie;
  });
  afterAll(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  it("① 页面 /agent/plan：guest → 403（ADMIN_ROLES 门禁）", async () => {
    const res = await fetch(base + "/agent/plan", { headers: { cookie: guestCookie }, redirect: "manual" });
    expect(res.status).toBe(403);
  });

  it("② 接口 /api/agent/plan：guest → 403，且不写任何 SSE 帧", async () => {
    const res = await fetch(base + "/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: guestCookie },
      body: JSON.stringify({ question: "读 docs" }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("event:");
  });

  it("③ 接口 /api/agent/plan：admin → 200 且按序吐 plan → tool → answer → done", async () => {
    const res = await fetch(base + "/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ question: "读 docs/ 并汇总" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    const frameNames = body
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7));
    expect(frameNames).toEqual(["plan", "tool", "answer", "done"]);
    expect(body).toContain('"tool":"read_file"');
  });

  it("④ 直连 /agent-plan.html → 302 到带门禁的 /agent/plan（静态目录绕过防线）", async () => {
    const res = await fetch(base + "/agent-plan.html", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/agent/plan");
  });
});

describe("编排视图未装配：fail-closed", () => {
  let server: import("node:http").Server;
  let base: string;
  let adminCookie = "";

  beforeAll(async () => {
    useIsolatedUsersFile();
    ({ server, base } = await startServer(undefined));
    adminCookie = (await loginAs(base, "/api/login", { username: "admin", password: "secret", next: "/" })).cookie;
  });
  afterAll(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  it("⑤ admin 打接口 → 503（不降级、不 fallback 到任何全量工具集）", async () => {
    const res = await fetch(base + "/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ question: "x" }),
    });
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toContain("Plan agent 未装配");
  });
});
