import { beforeAll, describe, it, expect } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { startWikiProxy } from "./wiki-proxy.js";
import { tokenManager } from "./token.js";
import { AUTH_COOKIE, serializeCookie } from "./auth-helpers.js";
import { DEFAULT_BRAND } from "./wiki-inject.js";

/**
 * 端到端验证 wiki 代理的品牌名 + 主题色注入（方案 A）：
 * 开启 htmlInject 时，HTML 页面同时注入主题 <style> + 品牌名 <script>；
 * gzip 压缩响应也能正确解压注入；未开启时纯透传。
 */
describe("wiki proxy html inject", () => {
  const UPSTREAM_HTML = "<html><head><title>zyplayer-doc</title></head>"
    + "<body><header>zyplayer-doc</header><h1>wiki content</h1></body></html>";

  function createMockWiki(): http.Server {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://x");
      if (url.pathname === "/html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(UPSTREAM_HTML);
        return;
      }
      if (url.pathname === "/gzip") {
        const gz = zlib.gzipSync(Buffer.from(UPSTREAM_HTML, "utf8"));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Encoding": "gzip",
        });
        res.end(gz);
        return;
      }
      if (url.pathname === "/js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("console.log('nope');");
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    return server;
  }

  /** 启动 mock wiki + 代理，等待两者监听完成（startWikiProxy 内部已 listen） */
  async function startProxy(htmlInject: { enabled: boolean; brand: string } | undefined) {
    const wiki = createMockWiki();
    wiki.listen(0);
    await new Promise<void>((r) => wiki.once("listening", () => r()));
    const wikiPort = (wiki.address() as AddressInfo).port;
    const proxy = startWikiProxy({
      port: 0,
      target: "http://localhost:" + wikiPort,
      loginUrl: "http://localhost:3001/login",
      proxyOrigin: "http://localhost:3003",
      htmlInject,
    });
    await new Promise<void>((r) => proxy.once("listening", () => r()));
    const proxyPort = (proxy.address() as AddressInfo).port;
    return { wiki, proxy, proxyPort } as { wiki: http.Server; proxy: http.Server; proxyPort: number };
  }

  let token: string;
  beforeAll(() => { token = tokenManager.generate(); });

  it("注入开启：HTML 页面被注入品牌名与主题（含 gzip 响应）", async () => {
    const { wiki, proxy, proxyPort } = await startProxy({ enabled: true, brand: DEFAULT_BRAND });
    try {
      const headers = { cookie: serializeCookie(AUTH_COOKIE, token) };
      const base = "http://localhost:" + proxyPort;
      // 1. 普通 HTML：同时注入主题样式（head 末尾）+ 品牌名脚本（body 末尾）
      const plain = await fetch(base + "/html", { headers });
      expect(plain.status).toBe(200);
      const plainText = await plain.text();
      expect(plainText).toContain("<style data-navigate-doc-inject>");
      expect(plainText).toContain("<script data-navigate-doc-inject>");
      // 默认主题色 #519670（柔绿）+ Element Plus / antd 关键覆盖
      expect(plainText).toContain("--navigate-brand: #519670");
      expect(plainText).toContain("--el-color-primary: #519670");
      expect(plainText).toContain(".ant-btn-primary");
      expect(plainText).toContain(".login-page-view.login-background[class*=\"linear-gradient\"]");
      // style 必须在 head 闭合前，script 必须在 body 闭合前
      expect(plainText.indexOf("<style")).toBeLessThan(plainText.indexOf("</head>"));
      expect(plainText.indexOf("<script")).toBeLessThan(plainText.indexOf("</body>"));
      expect(plainText).toContain("var brand = \"" + DEFAULT_BRAND + "\";");
      expect(plainText).toContain("<h1>wiki content</h1>");
      expect(plain.headers.get("content-encoding")).toBeNull();

      // 2. gzip 压缩 HTML：解压注入后 content-encoding 移除
      const gz = await fetch(base + "/gzip", { headers });
      expect(gz.status).toBe(200);
      expect(gz.headers.get("content-encoding")).toBeNull();
      const gzText = await gz.text();
      expect(gzText).toContain("<style data-navigate-doc-inject>");
      expect(gzText).toContain("<script data-navigate-doc-inject>");
      expect(gzText).toContain(DEFAULT_BRAND);
      expect(gzText).toContain("<h1>wiki content</h1>");

      // 3. 非 HTML（JS 资源）不注入
      const js = await fetch(base + "/js", { headers });
      expect(await js.text()).toBe("console.log('nope');");
    } finally {
      proxy.close();
      wiki.close();
    }
  });

  it("注入关闭（undefined）时纯透传，不改动响应体", async () => {
    const { wiki, proxy, proxyPort } = await startProxy(undefined);
    try {
      const res = await fetch("http://localhost:" + proxyPort + "/html", {
        headers: { cookie: serializeCookie(AUTH_COOKIE, token) },
      });
      const text = await res.text();
      expect(text).toBe(UPSTREAM_HTML);
      expect(text).not.toContain("data-navigate-doc-inject");
    } finally {
      proxy.close();
      wiki.close();
    }
  });

  it("注入 enabled:false 时同样纯透传", async () => {
    const { wiki, proxy, proxyPort } = await startProxy({ enabled: false, brand: DEFAULT_BRAND });
    try {
      const res = await fetch("http://localhost:" + proxyPort + "/html", {
        headers: { cookie: serializeCookie(AUTH_COOKIE, token) },
      });
      expect(await res.text()).toBe(UPSTREAM_HTML);
    } finally {
      proxy.close();
      wiki.close();
    }
  });
});
