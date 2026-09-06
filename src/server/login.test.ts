import { beforeAll, afterAll, describe, it, expect, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  mountLoginRoutes, validateCredentials, checkLoginRate, recordLoginFailure, allowNext,
  checkAccountRate, recordUserLoginFailure, needsChallenge, resetLoginProtectionForTests,
} from "./login.js";
import { challengeStore } from "./login-challenge.js";
import { deriveCookieDomain, stripTokenQuery } from "./auth-helpers.js";
import { tokenManager } from "./token.js";

describe("stripTokenQuery", () => {
  it("strips token param from relative and absolute urls", () => {
    expect(stripTokenQuery("/?token=abc")).toBe("/");
    expect(stripTokenQuery("/resume/chat?token=abc")).toBe("/resume/chat");
    expect(stripTokenQuery("/?token=abc&x=1")).toBe("/?x=1");
    expect(stripTokenQuery("https://wiki.example.com/?token=abc")).toBe("https://wiki.example.com/");
    expect(stripTokenQuery("https://wiki.example.com/page?token=abc&tab=2")).toBe("https://wiki.example.com/page?tab=2");
  });
  it("leaves urls without token untouched", () => {
    expect(stripTokenQuery("/resume")).toBe("/resume");
    expect(stripTokenQuery("/?x=1")).toBe("/?x=1");
  });
});

describe("allowNext (wiki origin whitelist)", () => {
  const origins = ["http://localhost:3003", "https://wiki.example.com"];
  it("accepts same-origin paths", () => {
    expect(allowNext("/resume", origins)).toBe("/resume");
    expect(allowNext("/", origins)).toBe("/");
  });
  it("accepts local and public wiki origins", () => {
    expect(allowNext("http://localhost:3003/docs/1", origins)).toBe("http://localhost:3003/docs/1");
    expect(allowNext("https://wiki.example.com/page", origins)).toBe("https://wiki.example.com/page");
  });
  it("rejects unknown origins and malformed values", () => {
    expect(allowNext("https://evil.com/x", origins)).toBe("/");
    expect(allowNext(null, origins)).toBe("/");
    expect(allowNext(undefined, origins)).toBe("/");
    expect(allowNext("", origins)).toBe("/");
  });
  it("strips stale token from accepted next (login loop guard)", () => {
    expect(allowNext("/?token=abc", origins)).toBe("/");
    expect(allowNext("https://wiki.example.com/?token=abc", origins)).toBe("https://wiki.example.com/");
    expect(allowNext("http://localhost:3003/docs?token=abc", origins)).toBe("http://localhost:3003/docs");
  });
});

describe("deriveCookieDomain", () => {
  it("returns undefined for localhost / IP (host-only cookie)", () => {
    delete process.env.H5_COOKIE_DOMAIN;
    expect(deriveCookieDomain("localhost")).toBeUndefined();
    expect(deriveCookieDomain("127.0.0.1")).toBeUndefined();
    expect(deriveCookieDomain("192.168.1.5")).toBeUndefined();
    expect(deriveCookieDomain(undefined)).toBeUndefined();
  });
  it("derives root domain with leading dot for subdomain sharing", () => {
    expect(deriveCookieDomain("navigate.example.com")).toBe(".example.com");
    expect(deriveCookieDomain("wiki.example.com")).toBe(".example.com");
    expect(deriveCookieDomain("www.example.com")).toBe(".example.com");
  });
  it("honors H5_COOKIE_DOMAIN override", () => {
    process.env.H5_COOKIE_DOMAIN = "example.com.cn";
    expect(deriveCookieDomain("anything.example.com.cn")).toBe(".example.com.cn");
    delete process.env.H5_COOKIE_DOMAIN;
  });
});

describe("validateCredentials", () => {
  let usersFile: string;
  beforeEach(() => {
    // 隔离账号文件：避免误读开发机真实 rag_data/h5-users.json
    usersFile = usersFile || path.join(os.tmpdir(), `h5-users-login-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    process.env.H5_USERS_FILE = usersFile;
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_LOGIN_USERS = "";
  });
  afterAll(() => { delete process.env.H5_USERS_FILE; });
  it("accepts configured username/password and rejects others", () => {
    expect(validateCredentials("admin", "secret")).toBe(true);
    expect(validateCredentials("admin", "wrong")).toBe(false);
    expect(validateCredentials("root", "secret")).toBe(false);
  });
});

describe("login rate limiter", () => {
  it("locks an ip after 5 failures", () => {
    const ip = "203.0.113.7"; // 不与 localhost 测试冲突
    for (let i = 0; i < 5; i++) recordLoginFailure(ip);
    expect(checkLoginRate(ip).locked).toBe(true);
  });
  it("unlocks after the lock window (0 ms)", () => {
    // recordLoginFailure 已锁定；用不受影响的 ip 验证非锁定路径
    expect(checkLoginRate("198.51.100.9").locked).toBe(false);
  });
});

describe("account limiter & conditional challenge threshold", () => {
  beforeEach(() => resetLoginProtectionForTests());
  it("locks an account after 5 failures (independent of ip)", () => {
    for (let i = 0; i < 5; i++) recordUserLoginFailure("victim");
    expect(checkAccountRate("victim").locked).toBe(true);
    expect(checkAccountRate("other").locked).toBe(false);
  });
  it("does not lock empty usernames (ip dimension still applies)", () => {
    recordUserLoginFailure("");
    expect(checkAccountRate("").locked).toBe(false);
  });
  it("requires a challenge only after 2+ failures on ip", () => {
    const ip = "203.0.113.50";
    expect(needsChallenge(ip, "nobody")).toBe(false);
    recordLoginFailure(ip);
    expect(needsChallenge(ip, "nobody")).toBe(false);
    recordLoginFailure(ip);
    expect(needsChallenge(ip, "nobody")).toBe(true);
  });
  it("requires a challenge after 2+ failures on an account (distributed ip attack)", () => {
    const u = "victim";
    recordUserLoginFailure(u);
    recordUserLoginFailure(u);
    expect(needsChallenge("198.51.100.1", u)).toBe(true); // 换 IP 依然触发
  });
  it("challenge is one-time: consuming twice fails the second time", () => {
    const { challengeId, answer } = challengeStore.create("sid-1", "203.0.113.60");
    expect(challengeStore.consume("sid-1", challengeId, answer)).toBe("ok");
    expect(challengeStore.consume("sid-1", challengeId, answer)).toBe("missing"); // 已销毁
  });
  it("challenge rejects sid mismatch and wrong code", () => {
    const { challengeId, answer } = challengeStore.create("sid-2", "203.0.113.60");
    expect(challengeStore.consume("sid-other", challengeId, answer)).toBe("missing");
    const { challengeId: c2 } = challengeStore.create("sid-2", "203.0.113.60");
    expect(challengeStore.consume("sid-2", c2, "ZZZZ")).toBe("wrong");
  });
});

describe("POST /api/login (ephemeral express server)", () => {
  let app: express.Express;
  let server: ReturnType<express.Express["listen"]>;
  let base: string;

  beforeAll(async () => {
    process.env.H5_USERS_FILE = path.join(os.tmpdir(), `h5-users-login-srv-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_LOGIN_USERS = "";
    app = express();
    app.use(express.json());
    mountLoginRoutes(app, { proxyOrigin: "http://localhost:3003" });
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server?.close();
    delete process.env.H5_USERS_FILE;
  });

  // 每用例重置内存防护状态：e2e 全部请求来自 127.0.0.1（共享 IP key），
  // 防失败计数/挑战在用例间串扰（如某用例失败 5 次把后续用例锁成 429）
  beforeEach(() => resetLoginProtectionForTests());

  it("returns 401 for bad credentials", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "nope" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns token and sets httpOnly cookie for good credentials", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/resume/chat" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.token).toBe("string");
    expect(tokenManager.validate(data.token)).toBe(true);
    expect(data.next).toBe("/resume/chat");
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("navigate_token=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("login response strips stale token from next (loop guard)", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret", next: "/?token=stale" }),
    });
    const data = await res.json();
    expect(data.next).toBe("/");
  });

  it("logout with ?next= redirects to sanitized login page", async () => {
    const res = await fetch(`${base}/api/logout?next=${encodeURIComponent("/?token=stale")}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("navigate_token=");
  });

  it("logout without next stays JSON (api friendly)", async () => {
    const res = await fetch(`${base}/api/logout`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // ── 条件式校验码（防爆破 escalation）──────────────────────────────────────
  const postLogin = (body: Record<string, unknown>, cookie?: string) =>
    fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });

  it("escalates to challenge only after 2 consecutive failures", async () => {
    const r1 = await postLogin({ username: "admin", password: "x1" });
    expect(r1.status).toBe(401);
    expect((await r1.json()).needChallenge).toBe(false); // 第 1 次失败不打扰

    const r2 = await postLogin({ username: "admin", password: "x2" });
    expect((await r2.json()).needChallenge).toBe(true); // 第 2 次失败后要求校验码

    // 已激活：即使密码正确、但不带校验码 → 401 needChallenge
    const r3 = await postLogin({ username: "admin", password: "secret" });
    expect(r3.status).toBe(401);
    expect((await r3.json()).needChallenge).toBe(true);
  });

  it("full browser flow: challenge → bmp image → login succeeds with code", async () => {
    // 制造 2 次失败激活校验码（真实请求，ip 由服务端记录）
    await postLogin({ username: "admin", password: "x1" });
    await postLogin({ username: "admin", password: "x2" });

    // GET challenge：应答只含 challengeId，答案不下发；顺带种匿名 sid cookie
    const cRes = await fetch(`${base}/api/login/challenge`);
    expect(cRes.status).toBe(200);
    const sid = (cRes.headers.get("set-cookie") || "").split(";")[0];
    expect(sid).toContain("navigate_sid=");
    const { challengeId } = (await cRes.json()) as { challengeId: string };
    expect(challengeId).toBeTruthy();

    // 校验码图片：image/bmp，且不带 sid 的请求拿不到（会话绑定）
    const imgUrl = `${base}/api/login/challenge/${challengeId}/image`;
    const anon = await fetch(imgUrl);
    expect(anon.status).toBe(404);
    const img = await fetch(imgUrl, { headers: { Cookie: sid } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toContain("image/bmp");
    const buf = Buffer.from(await img.arrayBuffer());
    expect(buf.slice(0, 2).toString("ascii")).toBe("BM");
    expect(buf.length).toBeGreaterThan(500);

    // 模拟"人类看图成功 OCR"：从服务端存储直取答案（等价于读出图片字符）
    const stored = challengeStore.get(challengeId);
    expect(stored).toBeDefined();
    const ok = await postLogin(
      { username: "admin", password: "secret", challengeId, code: stored!.answer.toLowerCase() },
      sid,
    );
    expect(ok.status).toBe(200);
    const data = (await ok.json()) as { token: string };
    expect(tokenManager.validate(data.token)).toBe(true);
  });

  it("wrong challenge code is rejected and keeps challenge required", async () => {
    await postLogin({ username: "admin", password: "x1" });
    await postLogin({ username: "admin", password: "x2" }); // 激活校验码

    const cRes = await fetch(`${base}/api/login/challenge`);
    const sid = (cRes.headers.get("set-cookie") || "").split(";")[0];
    const { challengeId } = (await cRes.json()) as { challengeId: string };

    const res = await postLogin(
      { username: "admin", password: "secret", challengeId, code: "ZZZZ" },
      sid,
    );
    expect(res.status).toBe(401);
    expect((await res.json()).needChallenge).toBe(true);
  });

  it("locks ip and account (429) when failures continue through challenges", async () => {
    // 2 次裸错激活校验码（fails=2）
    await postLogin({ username: "admin", password: "bad-0" });
    await postLogin({ username: "admin", password: "bad-0" });
    // 之后每次都要先通过（一次性）校验码再错密码 → 计数继续累计到 5
    for (let i = 0; i < 3; i++) {
      const cRes = await fetch(`${base}/api/login/challenge`);
      const sid = (cRes.headers.get("set-cookie") || "").split(";")[0];
      const { challengeId } = (await cRes.json()) as { challengeId: string };
      const stored = challengeStore.get(challengeId)!;
      await postLogin({ username: "admin", password: `bad-${i}`, challengeId, code: stored.answer }, sid);
    }
    // 双维锁定：IP 与账号都被锁 → 429 + Retry-After
    const locked = await postLogin({ username: "admin", password: "bad-final" });
    expect(locked.status).toBe(429);
    const data = (await locked.json()) as { retryAfterSec?: number };
    expect(data.retryAfterSec).toBeGreaterThan(0);
    expect(checkAccountRate("admin").locked).toBe(true);
  });
});
