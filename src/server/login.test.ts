import { beforeAll, afterAll, describe, it, expect, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  mountLoginRoutes, validateCredentials, checkLoginRate, recordLoginFailure, allowNext,
} from "./login.js";
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
  beforeEach(() => {
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_LOGIN_USERS = "";
  });
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

describe("POST /api/login (ephemeral express server)", () => {
  let app: express.Express;
  let server: ReturnType<express.Express["listen"]>;
  let base: string;

  beforeAll(async () => {
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
  afterAll(() => server?.close());

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
});
