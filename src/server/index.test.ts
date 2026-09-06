import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
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

/** 登录并返回 status/cookie/token */
async function loginAs(base: string, username: string, password: string) {
  const res = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, next: "/" }),
  });
  const data = await res.json();
  return { status: res.status, data, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

/** 账号文件隔离：指向临时文件，避免测试误读/误写开发机真实 rag_data/h5-users.json */
function useIsolatedUsersFile(): void {
  process.env.H5_USERS_FILE = path.join(os.tmpdir(), `h5-users-it-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}
function unsetIsolatedUsersFile(): void {
  delete process.env.H5_USERS_FILE;
}

describe("createRagServer login gating (e2e)", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    useIsolatedUsersFile();
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
    unsetIsolatedUsersFile();
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

  it("redirects unauthenticated /resume to login (resume page now gated)", async () => {
    const res = await fetch(base + "/resume", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?next=");
  });

  it("rejects anonymous /api/resume with 401 (data matches page gating)", async () => {
    const res = await fetch(base + "/api/resume");
    expect(res.status).toBe(401);
  });

  it("serves /resume to an authenticated user with wiki url injected", async () => {
    const good = await loginAs(base, "admin", "secret");
    expect(good.status).toBe(200);
    const res = await fetch(base + "/resume", { headers: { cookie: good.cookie } });
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
    useIsolatedUsersFile();
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
    unsetIsolatedUsersFile();
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
    useIsolatedUsersFile();
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
    unsetIsolatedUsersFile();
  });

  it("injects public wiki url into H5 pages", async () => {
    const good = await loginAs(base, "admin", "secret");
    expect(good.status).toBe(200);
    const res = await fetch(base + "/resume", { headers: { cookie: good.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="https://wiki.example.com"');
    expect(html).not.toContain("localhost:3003");
    expect(html).not.toContain("__WIKI_URL__");
  });
});

describe("guest (体验账号) role gating e2e", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    useIsolatedUsersFile();
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_LOGIN_USERS = "";
    process.env.H5_GUEST_USERNAME = "guest";
    process.env.H5_GUEST_PASSWORD = "guest123";
    process.env.H5_WIKI_PROXY_PORT = "0";
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
    delete process.env.H5_GUEST_USERNAME;
    delete process.env.H5_GUEST_PASSWORD;
    unsetIsolatedUsersFile();
  });

  it("guest can open all allowed pages, but /admin returns the 403 denied page", async () => {
    const g = await loginAs(base, "guest", "guest123");
    expect(g.status).toBe(200);
    expect(g.data.role).toBe("guest");

    for (const p of ["/", "/resume", "/resume/chat", "/resume/jd"]) {
      const r = await fetch(base + p, { headers: { cookie: g.cookie } });
      expect(r.status, `page ${p} should be reachable by guest`).toBe(200);
    }

    const denied = await fetch(base + "/admin", { headers: { cookie: g.cookie } });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("无权限");

    const me = await (await fetch(base + "/api/me", { headers: { cookie: g.cookie } })).json();
    expect(me).toEqual({ username: "guest", role: "guest", isAdmin: false });
  });

  it("guest write operations (upload/reindex/delete) are 403; admin passes the gate", async () => {
    const g = await loginAs(base, "guest", "guest123");
    const a = await loginAs(base, "admin", "secret");
    expect(g.status).toBe(200);

    const up = await fetch(base + "/api/upload", { method: "POST", headers: { cookie: g.cookie } });
    expect(up.status).toBe(403);
    const del = await fetch(base + "/api/documents/some-id", { method: "DELETE", headers: { cookie: g.cookie } });
    expect(del.status).toBe(403);
    const reidx = await fetch(base + "/api/reindex/some-id", { method: "POST", headers: { cookie: g.cookie } });
    expect(reidx.status).toBe(403);
    const chg = await fetch(base + "/api/admin/guest-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: g.cookie },
      body: JSON.stringify({ password: "x12345" }),
    });
    expect(chg.status).toBe(403);

    // admin 通过鉴权进入 handler（mockStore 无 deleteDoc → 500；断言重点是不再 403）
    const aDel = await fetch(base + "/api/documents/some-id", { method: "DELETE", headers: { cookie: a.cookie } });
    expect(aDel.status).not.toBe(403);
  });

  it("token/new inherits the caller role (guest cannot mint an admin token)", async () => {
    const g = await loginAs(base, "guest", "guest123");
    const mint = await fetch(base + "/api/token/new", { method: "POST", headers: { cookie: g.cookie } });
    expect(mint.status).toBe(200);
    const guestMinted = (await mint.json()).token;
    // 继承 guest → 访问 /admin 仍是 403
    expect((await fetch(base + "/admin?token=" + guestMinted)).status).toBe(403);

    const a = await loginAs(base, "admin", "secret");
    const mint2 = await fetch(base + "/api/token/new", { method: "POST", headers: { cookie: a.cookie } });
    const adminMinted = (await mint2.json()).token;
    expect((await fetch(base + "/admin?token=" + adminMinted)).status).toBe(200);
  });

  it("admin /admin page renders; /admin.html static bypass redirects to gated route", async () => {
    const a = await loginAs(base, "admin", "secret");
    const page = await fetch(base + "/admin", { headers: { cookie: a.cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("账号管理");

    const bypass = await fetch(base + "/admin.html", { redirect: "manual", headers: { cookie: a.cookie } });
    expect(bypass.status).toBe(302);
    expect(bypass.headers.get("location")).toBe("/admin");
  });

  // 放在最后：重置密码后文件持久化，旧密码失效（后续用例依赖 guest123 的都在前面）
  it("admin can reset guest password; new password takes effect immediately, old one fails", async () => {
    const a = await loginAs(base, "admin", "secret");

    const info = await fetch(base + "/api/admin/guest", { headers: { cookie: a.cookie } });
    expect(info.status).toBe(200);
    expect((await info.json()).username).toBe("guest");

    const weak = await fetch(base + "/api/admin/guest-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: a.cookie },
      body: JSON.stringify({ password: "123" }),
    });
    expect(weak.status).toBe(400);

    const res = await fetch(base + "/api/admin/guest-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: a.cookie },
      body: JSON.stringify({ password: "newpass1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).username).toBe("guest");

    // 旧密码失效、新密码可登录
    expect((await loginAs(base, "guest", "guest123")).status).toBe(401);
    expect((await loginAs(base, "guest", "newpass1")).status).toBe(200);
    expect((await loginAs(base, "admin", "secret")).status).toBe(200);
  });
});
