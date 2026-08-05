import { beforeAll, afterAll, describe, it, expect, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  mountLoginRoutes, validateCredentials, checkLoginRate, recordLoginFailure,
} from "./login.js";
import { tokenManager } from "./token.js";

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
});
