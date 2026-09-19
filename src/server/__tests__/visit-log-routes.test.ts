/**
 * 访客记录：登录埋点 + 管理接口 端到端
 *
 * 这里用真实 HTTP 请求（createRagServer 起临时端口 + 假 VisitLog 捕获入参），验证三件事：
 *
 *   ① **trust proxy 生效**：反代（Caddy）后面，Express 默认只认 socket 地址 —— 于是
 *      req.ip 恒为代理容器地址，访客记录里所有 IP 都是 172.x（「谁来过」无从分辨），
 *      登录防爆破也会把全网访客当同一个人。测试发 `X-Forwarded-For: 1.1.1.1, 203.0.113.9`
 *      并断言取到**最右**那项（= Caddy 写入的真实客户端地址，左侧是客户端可伪造的）。
 *   ② 游客入口与账号登录都埋点，kind 可区分（自己用 admin 登录不会混进游客名单）。
 *   ③ 管理接口只对管理员开放；params 解析（kind / bots）正确落到查询上。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRagServer } from "../index.js";
import type { PgVectorStore } from "../../storage/pg-vector-store.js";
import type {
  VisitEntry,
  VisitEvent,
  VisitLog,
  VisitQuery,
  VisitStats,
  VisitSummary,
} from "../visit-log.js";

const mockStore = {
  listDocs: async () => [],
  getCacheStats: () => ({ total: 0 }),
  search: async () => [],
  searchKeyword: async () => [],
} as unknown as PgVectorStore;

const STATS: VisitStats = { events: 7, ips: 3, recent24h: 2, pendingGeo: 1, selfIpsConfigured: true };

/** 假 VisitLog：只记下被写入的登录事件与查询参数，不碰 DB */
function stubVisitLog() {
  const entries: VisitEntry[] = [];
  const summary = vi.fn(async (_q?: VisitQuery) => [] as VisitSummary[]);
  const listRecent = vi.fn(async (_q?: VisitQuery) => [] as VisitEvent[]);
  const stats = vi.fn(async (_q?: VisitQuery) => STATS);
  const pendingGeoCount = vi.fn(async () => 4);
  const backfill = vi.fn(() => true);
  const log: VisitLog = {
    record: (e) => void entries.push(e),
    flush: async () => {},
    listRecent,
    summary,
    stats,
    pendingGeoCount,
    resolvePending: async () => ({ resolved: 0, failed: 0 }),
    backfill,
  };
  return { log, entries, summary, listRecent, stats, pendingGeoCount, backfill };
}

describe("访客记录（登录埋点 + 管理接口）", () => {
  let server: import("node:http").Server;
  let base: string;
  let stub: ReturnType<typeof stubVisitLog>;

  beforeAll(async () => {
    process.env.H5_USERS_FILE = path.join(
      os.tmpdir(),
      `h5-users-visit-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_LOGIN_USERS = "";
    process.env.H5_GUEST_USERNAME = "guest";
    process.env.H5_GUEST_PASSWORD = "guest123";
    process.env.H5_WIKI_PROXY_PORT = "0";

    stub = stubVisitLog();
    // 位置参数：store, port, resumeStore, resumeData, apiAuth, resumeExecutor, jdAnalyzer, deps
    const app = createRagServer(
      mockStore,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { visitLog: stub.log },
    );
    server = (app as unknown as { httpServer: import("node:http").Server }).httpServer;
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.closeAllConnections?.();
    server?.close();
    for (const k of ["H5_USERS_FILE", "H5_LOGIN_USERNAME", "H5_LOGIN_PASSWORD", "H5_LOGIN_USERS", "H5_GUEST_USERNAME", "H5_GUEST_PASSWORD", "H5_WIKI_PROXY_PORT"]) {
      delete process.env[k];
    }
  });

  function lastEntry(): VisitEntry {
    return stub.entries[stub.entries.length - 1];
  }

  it("反代后取 X-Forwarded-For 最右一项（Caddy 写入的真实 IP），不是最左的可伪造值", async () => {
    stub.entries.length = 0;
    const res = await fetch(base + "/api/login/guest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "1.1.1.1, 203.0.113.9",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Referer: "https://www.zhipin.com/job_detail/xxx",
      },
      body: JSON.stringify({ next: "/resume", src: "boss-zhipin" }),
    });
    expect(res.status).toBe(200);

    expect(stub.entries).toHaveLength(1);
    expect(lastEntry().ip).toBe("203.0.113.9");
    expect(lastEntry().kind).toBe("guest");
    expect(lastEntry().username).toBe("guest");
    expect(lastEntry().src).toBe("boss-zhipin");
    expect(lastEntry().landing).toBe("/resume");
    expect(lastEntry().referer).toBe("https://www.zhipin.com/job_detail/xxx");
    expect(lastEntry().ua).toContain("Chrome/128");
  });

  it("直连（无 XFF）时记 socket 地址，并归一化 ::ffff: 前缀", async () => {
    stub.entries.length = 0;
    await fetch(base + "/api/login/guest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next: "/" }),
    });
    // localhost 在双栈下可能给出 ::1（IPv6 回环）或 ::ffff:127.0.0.1 —— 归一化后不带 mapped 前缀
    expect(["127.0.0.1", "::1"]).toContain(lastEntry().ip);
  });

  it("账号密码登录记为 kind=login（自己的 admin 记录不会混进游客名单）", async () => {
    stub.entries.length = 0;
    const res = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
    });
    expect(res.status).toBe(200);
    expect(lastEntry().kind).toBe("login");
    expect(lastEntry().username).toBe("admin");
    expect(lastEntry().role).toBe("admin");
    expect(["127.0.0.1", "::1"]).toContain(lastEntry().ip);
  });

  it("登录失败不产生访客记录", async () => {
    stub.entries.length = 0;
    const res = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong-password", next: "/" }),
    });
    expect(res.status).toBe(401);
    expect(stub.entries).toHaveLength(0);
  });

  it("渠道标识也可走 query（?src=，链路分享直接用这个形式）", async () => {
    stub.entries.length = 0;
    await fetch(base + "/api/login/guest?src=tencent-hr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next: "/" }),
    });
    expect(lastEntry().src).toBe("tencent-hr");
  });

  it("GET /api/admin/visits：无 token 403、游客 403、管理员 200 且默认只看游客", async () => {
    const anon = await fetch(base + "/api/admin/visits");
    expect(anon.status).toBe(403);

    const guestLogin = await fetch(base + "/api/login/guest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next: "/" }),
    });
    const guestCookie = (guestLogin.headers.get("set-cookie") || "").split(";")[0];
    const asGuest = await fetch(base + "/api/admin/visits", { headers: { cookie: guestCookie } });
    expect(asGuest.status).toBe(403);

    const adminLogin = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
    });
    const adminCookie = (adminLogin.headers.get("set-cookie") || "").split(";")[0];

    stub.summary.mockClear();
    const res = await fetch(base + "/api/admin/visits", { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.stats).toEqual(STATS);
    // 默认口径：只看游客、排除脚本
    expect(stub.summary.mock.calls[0][0]).toMatchObject({ kind: "guest", includeBots: false, limit: 200 });
  });

  it("GET /api/admin/visits?kind=all&bots=1 解析成对应查询", async () => {
    const adminLogin = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
    });
    const adminCookie = (adminLogin.headers.get("set-cookie") || "").split(";")[0];

    stub.listRecent.mockClear();
    const res = await fetch(base + "/api/admin/visits?kind=all&bots=1", { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    expect(stub.listRecent.mock.calls[0][0]).toMatchObject({ kind: "all", includeBots: true, limit: 100 });

    // 非法 kind 回退到默认（只看游客），避免拼错参数就悄悄看到全部记录
    stub.listRecent.mockClear();
    const odd = await fetch(base + "/api/admin/visits?kind=../../etc/passwd", { headers: { cookie: adminCookie } });
    expect(odd.status).toBe(200);
    expect(stub.listRecent.mock.calls[0][0]).toMatchObject({ kind: "guest" });
  });

  it("POST /api/admin/visits/resolve：后台补全，返回待补数量", async () => {
    const adminLogin = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
    });
    const adminCookie = (adminLogin.headers.get("set-cookie") || "").split(";")[0];

    stub.backfill.mockClear();
    const res = await fetch(base + "/api/admin/visits/resolve", { method: "POST", headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: 4, started: true });
    expect(stub.backfill).toHaveBeenCalledWith(20);

    const anon = await fetch(base + "/api/admin/visits/resolve", { method: "POST" });
    expect(anon.status).toBe(403);
  });

  it("未装配 visitLog 时接口仍可用：enabled=false，不 500", async () => {
    const app = createRagServer(mockStore, 0);
    const s = (app as unknown as { httpServer: import("node:http").Server }).httpServer;
    await new Promise<void>((r) => s.once("listening", () => r()));
    const p = (s.address() as AddressInfo).port;
    try {
      const adminLogin = await fetch(`http://localhost:${p}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
      });
      const cookie = (adminLogin.headers.get("set-cookie") || "").split(";")[0];
      const res = await fetch(`http://localhost:${p}/api/admin/visits`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
      expect(body.reason).toContain("未装配");
    } finally {
      s.closeAllConnections?.();
      s.close();
    }
  });
});
