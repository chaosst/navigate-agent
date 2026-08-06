import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startWikiProxy } from "./wiki-proxy.js";
import { tokenManager } from "./token.js";
import { AUTH_COOKIE, serializeCookie } from "./auth-helpers.js";

/** 模拟 Spring-Security 风格登录的 zyplayer-doc 上游 */
function createMockWiki(): { server: http.Server; revokeSession: () => void } {
  const sessions = new Set<string>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const cookie = req.headers.cookie || "";
    const session = /(?:^|;\s*)SESSION=([^;]+)/.exec(cookie)?.[1];

    if (url.pathname === "/login" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "JSESSIONID=abc123; Path=/" });
      res.end('<form><input name="_csrf" value="tok123">'
        + '<input name="username"><input type="password" name="password"></form>');
      return;
    }
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const p = new URLSearchParams(body);
        if (p.get("_csrf") === "tok123" && p.get("username") === "zyplayer" && p.get("password") === "123456") {
          const sid = `SESSION_valid_${Math.floor(Math.random() * 1e9)}`;
          sessions.add(sid);
          res.writeHead(302, { Location: "/", "Set-Cookie": `SESSION=${sid}; Path=/` });
        } else {
          res.writeHead(401, { "Content-Type": "text/plain" });
        }
        res.end();
      });
      return;
    }
    if (session && sessions.has(session)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>wiki</h1>");
    } else {
      res.writeHead(302, { Location: "/login" });
      res.end();
    }
  });
  return {
    server,
    revokeSession: () => sessions.clear(),
  };
}

describe("wiki proxy auto-login (form + csrf)", () => {
  let wiki: ReturnType<typeof createMockWiki>;
  let proxy: http.Server;
  let proxyUrl: string;
  let token: string;

  beforeAll(async () => {
    token = tokenManager.generate();
    wiki = createMockWiki();
    wiki.server.listen(0);
    await new Promise<void>((r) => wiki.server.once("listening", () => r()));
    const wikiPort = (wiki.server.address() as AddressInfo).port;

    proxy = startWikiProxy({
      port: 0,
      target: `http://localhost:${wikiPort}`,
      loginUrl: "http://localhost:3001/login",
      proxyOrigin: "http://localhost:3003",
      wikiUsername: "zyplayer",
      wikiPassword: "123456",
      wikiLoginMode: "form",
      wikiLoginPath: "/login",
    });
    await new Promise<void>((r) => proxy.once("listening", () => r()));
    proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(() => { proxy?.close(); wiki.server.close(); });

  const authHeaders = () => ({ cookie: serializeCookie(AUTH_COOKIE, token) });

  it("auto-logs in and serves wiki content without a second login", async () => {
    const res = await fetch(proxyUrl + "/", { headers: authHeaders(), redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>wiki</h1>");
  });

  it("re-logs in transparently when the wiki session expires", async () => {
    // 先建立会话
    const first = await fetch(proxyUrl + "/", { headers: authHeaders(), redirect: "manual" });
    expect(first.status).toBe(200);
    // wiki 端会话失效
    wiki.revokeSession();
    // 下次 GET 应触发自动重新登录并仍拿到内容
    const second = await fetch(proxyUrl + "/", { headers: authHeaders(), redirect: "manual" });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("<h1>wiki</h1>");
  });

  it("still redirects to Navigate login without a valid token", async () => {
    const res = await fetch(proxyUrl + "/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?next=");
  });
});

describe("wiki proxy pass-through (auto-login disabled)", () => {
  let wiki: ReturnType<typeof createMockWiki>;
  let proxy: http.Server;
  let proxyUrl: string;
  let token: string;

  beforeAll(async () => {
    token = tokenManager.generate();
    wiki = createMockWiki();
    wiki.server.listen(0);
    await new Promise<void>((r) => wiki.server.once("listening", () => r()));
    const wikiPort = (wiki.server.address() as AddressInfo).port;

    // 不配置 wikiUsername → 自动登录关闭，纯透传
    proxy = startWikiProxy({
      port: 0,
      target: `http://localhost:${wikiPort}`,
      loginUrl: "http://localhost:3001/login",
      proxyOrigin: "http://localhost:3003",
    });
    await new Promise<void>((r) => proxy.once("listening", () => r()));
    proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(() => { proxy?.close(); wiki.server.close(); });

  it("forwards the wiki's own login redirect (302) instead of 502", async () => {
    const res = await fetch(proxyUrl + "/", {
      headers: { cookie: serializeCookie(AUTH_COOKIE, token) },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });
});
