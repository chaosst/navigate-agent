import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startWikiProxy } from "./wiki-proxy.js";
import { tokenManager } from "./token.js";
import { AUTH_COOKIE, serializeCookie } from "./auth-helpers.js";

describe("wiki proxy auth", () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let proxyUrl: string;
  let token: string;

  beforeAll(async () => {
    token = tokenManager.generate();
    // 模拟 zyplayer-doc 上游
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>wiki</h1>");
    });
    upstream.listen(0);
    await new Promise<void>((r) => upstream.once("listening", () => r()));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    proxy = startWikiProxy({
      port: 0,
      target: `http://localhost:${upstreamPort}`,
      loginUrl: "http://localhost:3001/login",
      proxyOrigin: "http://localhost:3002",
    });
    await new Promise<void>((r) => proxy.once("listening", () => r()));
    proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(() => { proxy?.close(); upstream?.close(); });

  it("redirects to login when no valid token/cookie", async () => {
    const res = await fetch(proxyUrl + "/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?next=");
  });

  it("proxies upstream content when cookie is valid", async () => {
    const res = await fetch(proxyUrl + "/", { headers: { cookie: serializeCookie(AUTH_COOKIE, token) } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>wiki</h1>");
  });

  it("supports ?token= query param auth", async () => {
    const res = await fetch(proxyUrl + "/page/1?token=" + token);
    expect(res.status).toBe(200);
  });
});
