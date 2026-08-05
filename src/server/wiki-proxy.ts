import http from "node:http";
import { tokenManager } from "./token.js";
import { AUTH_COOKIE, getCookie } from "./auth-helpers.js";

export interface WikiProxyOptions {
  port: number;
  target: string;      // 如 "http://localhost:8083"
  loginUrl: string;    // 如 "http://localhost:3001/login"
  proxyOrigin: string; // 如 "http://localhost:3002"（登录 next 白名单用）
}

/** 从 query(?token=) 或 cookie 取 token */
function extractToken(req: http.IncomingMessage): string | undefined {
  if (req.url) {
    try {
      const q = new URL(req.url, "http://localhost").searchParams.get("token");
      if (q) return q;
    } catch { /* ignore malformed url */ }
  }
  return getCookie(req.headers, AUTH_COOKIE);
}

/**
 * 独立端口鉴权反向代理：整站转发到 zyplayer-doc。
 * 每个请求先校验 navigate_token（cookie 或 ?token=），未登录 302 到登录页。
 * cookie 按 host 隔离、跨端口共享 → wiki 内部跳转无需带 token。
 */
export function startWikiProxy(opts: WikiProxyOptions): http.Server {
  const target = new URL(opts.target);

  const server = http.createServer((req, res) => {
    const token = extractToken(req);
    if (!token || !tokenManager.validate(token)) {
      const next = encodeURIComponent(`${opts.proxyOrigin}${req.url ?? "/"}`);
      res.writeHead(302, { Location: `${opts.loginUrl}?next=${next}` });
      res.end();
      return;
    }

    const proxyReq = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url ?? "/",
        headers: { ...req.headers, host: target.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("502 Bad Gateway — wiki upstream unavailable");
    });
    req.pipe(proxyReq);
  });

  server.listen(opts.port, () => {
    console.log(`🔐 Wiki proxy: http://localhost:${opts.port} → ${opts.target}（需登录）`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`❌ Wiki 代理端口 ${opts.port} 已被占用，wiki 代理未启动`);
    } else {
      console.error(`Wiki proxy error: ${err.message}`);
    }
  });
  return server;
}
