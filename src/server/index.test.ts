import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createRagServer } from "./index.js";
import { ResumeTooLongError } from "../resume/jd-analyzer.js";
import type { PgVectorStore } from "../storage/pg-vector-store.js";

// mock store 避开 Postgres/OpenAI 依赖，专注验证登录门槛与路由装配
const mockStore = {
  listDocs: async () => [],
  getCacheStats: () => ({ total: 0 }),
  search: async () => [],
  searchKeyword: async () => [],
} as unknown as PgVectorStore;

describe("createRagServer login gating (e2e)", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_LOGIN_USERS = "";
    process.env.H5_WIKI_PROXY_PORT = "0"; // 避免占用真实 3002
    const app = createRagServer(mockStore, 0);
    server = (app as unknown as { httpServer: import("node:http").Server }).httpServer;
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server?.closeAllConnections?.();
    server?.close();
    delete process.env.H5_WIKI_PROXY_PORT;
    delete process.env.H5_LOGIN_USERNAME;
    delete process.env.H5_LOGIN_PASSWORD;
    delete process.env.H5_LOGIN_USERS;
  });

  it("redirects unauthenticated / to /login?next=", async () => {
    const res = await fetch(base + "/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?next=");
  });

  it("strips stale token from next when redirecting to login (loop guard)", async () => {
    const res = await fetch(base + "/?token=stale", { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login?next=")).toBe(true);
    expect(decodeURIComponent(loc)).not.toContain("token=");
  });

  it("redirects unauthenticated /resume/chat to login", async () => {
    const res = await fetch(base + "/resume/chat", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?next=");
  });

  it("redirects unauthenticated /resume/jd to login", async () => {
    const res = await fetch(base + "/resume/jd", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?next=");
  });

  it("rejects anonymous /api/resume/jd-match with 401", async () => {
    const res = await fetch(base + "/api/resume/jd-match", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 503 for jd-match when no jdAnalyzer wired (valid token)", async () => {
    // 先登录拿 token + cookie
    const good = await fetch(base + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
    });
    const data = await good.json();
    const res = await fetch(base + "/api/resume/jd-match", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: (good.headers.get("set-cookie") || "").split(";")[0] },
      body: JSON.stringify({ jd: "招 Node 工程师，要求 TypeScript / RAG / Docker" }),
    });
    // 本测试未装配 jdAnalyzer → 503（页面可达性由 login gating 覆盖）
    expect(res.status).toBe(503);
    expect(data.token).toBeTruthy();
  });

  it("rejects empty /api/resume/jd-match body", async () => {
    const good = await fetch(base + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
    });
    const cookie = (good.headers.get("set-cookie") || "").split(";")[0];
    const res = await fetch(base + "/api/resume/jd-match", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("serves /resume/jd page to an authenticated user", async () => {
    const good = await fetch(base + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
    });
    const cookie = (good.headers.get("set-cookie") || "").split(";")[0];
    const res = await fetch(base + "/resume/jd", { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("JD 匹配诊断");
    expect(html).not.toContain("__WIKI_URL__");
  });

  it("serves /resume publicly (no login)", async () => {
    const res = await fetch(base + "/resume");
    expect(res.status).toBe(200);
    const html = await res.text();
    // 未配置 H5_WIKI_PUBLIC_URL 时，占位符回退为本地默认 wiki 地址
    // （测试中 H5_WIKI_PROXY_PORT=0，故地址为 http://localhost:0）
    expect(html).toMatch(/href="http:\/\/localhost:\d+"/);
    expect(html).not.toContain("__WIKI_URL__");
  });

  it("redirects /index.html static bypass to /", async () => {
    const res = await fetch(base + "/index.html", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("rejects unauthenticated /api/documents with 401", async () => {
    const res = await fetch(base + "/api/documents");
    expect(res.status).toBe(401);
  });

  it("blocks anonymous /api/token/new with 401", async () => {
    const res = await fetch(base + "/api/token/new", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("logs in with good credentials, then cookie grants access", async () => {
    const bad = await fetch(base + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(bad.status).toBe(401);

    const good = await fetch(base + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
    });
    expect(good.status).toBe(200);
    const data = await good.json();
    expect(typeof data.token).toBe("string");
    const cookie = (good.headers.get("set-cookie") || "").split(";")[0];

    const page = await fetch(base + "/", { headers: { cookie } });
    expect(page.status).toBe(200);

    // 登录页预检查：/api/token 用 cookie 回显 token（新标签页恢复会话）
    const tokRes = await fetch(base + "/api/token", { headers: { cookie } });
    const tokData = await tokRes.json();
    expect(tokData.valid).toBe(true);
    expect(tokData.token).toBe(data.token);
  });

  it("serves the /login page", async () => {
    const res = await fetch(base + "/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Navigate 登录");
  });
});

describe("jd-match ResumeTooLongError budget mapping (e2e)", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_LOGIN_USERS = "";
    process.env.H5_WIKI_PROXY_PORT = "0";
    // 注入抛 ResumeTooLongError 的假 analyzer → 路由应映射为可读 400（而非 502）
    const app = createRagServer(
      mockStore, 0,
      undefined, undefined, undefined, undefined, undefined,
      { analyze: async () => { throw new ResumeTooLongError(99999); } },
    );
    server = (app as unknown as { httpServer: import("node:http").Server }).httpServer;
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server?.closeAllConnections?.();
    server?.close();
    delete process.env.H5_WIKI_PROXY_PORT;
    delete process.env.H5_LOGIN_USERNAME;
    delete process.env.H5_LOGIN_PASSWORD;
    delete process.env.H5_LOGIN_USERS;
  });

  it("returns a readable 400 with char count when resume exceeds budget", async () => {
    const good = await fetch(base + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
    });
    const cookie = (good.headers.get("set-cookie") || "").split(";")[0];
    const res = await fetch(base + "/api/resume/jd-match", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ jd: "招 Node 工程师" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("简历过长");
    expect(body.error).toContain("99999");
  });
});

describe("createRagServer wiki public url injection", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_LOGIN_USERS = "";
    process.env.H5_WIKI_PROXY_PORT = "0";
    process.env.H5_WIKI_PUBLIC_URL = "https://wiki.example.com";
    const app = createRagServer(mockStore, 0);
    server = (app as unknown as { httpServer: import("node:http").Server }).httpServer;
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server?.closeAllConnections?.();
    server?.close();
    delete process.env.H5_WIKI_PROXY_PORT;
    delete process.env.H5_WIKI_PUBLIC_URL;
    delete process.env.H5_LOGIN_USERNAME;
    delete process.env.H5_LOGIN_PASSWORD;
    delete process.env.H5_LOGIN_USERS;
  });

  it("injects public wiki url into H5 pages", async () => {
    const res = await fetch(base + "/resume");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="https://wiki.example.com"');
    expect(html).not.toContain("localhost:3003");
    expect(html).not.toContain("__WIKI_URL__");
  });
});
