import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import type { AddressInfo } from "node:net";
import { startWikiProxy } from "./wiki-proxy.js";
import { tokenManager } from "./token.js";
import { AUTH_COOKIE, serializeCookie } from "./auth-helpers.js";

// 生成真实 RSA 密钥对，模拟 zyplayer-doc 的 rsa 登录
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
const pubDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");

function createRsaWiki(): { server: http.Server; revoke: () => void } {
  const sessions = new Set<string>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const cookie = req.headers.cookie || "";
    const at = /(?:^|;\s*)accessToken=([^;]+)/.exec(cookie)?.[1];

    if (url.pathname === "/loginConfig" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { publicKey: pubDer, sessionId: "s1", loginTypes: [] }, errCode: 200 }));
      return;
    }
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const p = new URLSearchParams(body);
        let ok = false;
        try {
          const dec = privateDecrypt(
            { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
            Buffer.from(p.get("password") || "", "base64"),
          ).toString("utf8");
          ok = dec === "123456" && p.get("username") === "zyplayer" && p.get("sessionId") === "s1";
        } catch { /* 解密失败 = 密码格式不对 */ }
        if (ok) {
          sessions.add("AT_OK");
          res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "accessToken=AT_OK; Path=/" });
          res.end(JSON.stringify({ errCode: 200 }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ errCode: 300, errMsg: "用户名或密码错误" }));
        }
      });
      return;
    }
    if (at && sessions.has(at)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>wiki</h1>");
    } else {
      res.writeHead(302, { Location: "/login" });
      res.end();
    }
  });
  return { server, revoke: () => sessions.clear() };
}

describe("wiki proxy auto-login (rsa + loginConfig)", () => {
  let wiki: ReturnType<typeof createRsaWiki>;
  let proxy: http.Server;
  let proxyUrl: string;
  let token: string;

  beforeAll(async () => {
    token = tokenManager.generate();
    wiki = createRsaWiki();
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
      wikiLoginMode: "rsa",
    });
    await new Promise<void>((r) => proxy.once("listening", () => r()));
    proxyUrl = `http://localhost:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(() => { proxy?.close(); wiki.server.close(); });

  const authHeaders = () => ({ cookie: serializeCookie(AUTH_COOKIE, token) });

  it("auto-logs in via RSA-encrypted password and serves wiki content", async () => {
    const res = await fetch(proxyUrl + "/", { headers: authHeaders(), redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>wiki</h1>");
  });

  it("re-logs in when the wiki session is revoked", async () => {
    const first = await fetch(proxyUrl + "/", { headers: authHeaders(), redirect: "manual" });
    expect(first.status).toBe(200);
    wiki.revoke();
    const second = await fetch(proxyUrl + "/", { headers: authHeaders(), redirect: "manual" });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("<h1>wiki</h1>");
  });
});
