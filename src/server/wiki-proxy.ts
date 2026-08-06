import http from "node:http";
import { tokenManager } from "./token.js";
import { AUTH_COOKIE, getCookie } from "./auth-helpers.js";

export interface WikiProxyOptions {
  port: number;
  target: string;      // 如 "http://localhost:8083"
  loginUrl: string;    // 如 "http://localhost:3001/login"
  proxyOrigin: string; // 如 "http://localhost:3003"（登录 next 白名单用）
  // wiki(zplayer-doc) 自动登录配置
  wikiUsername?: string;      // 默认 zyplayer
  wikiPassword?: string;      // 默认 123456
  wikiLoginMode?: "form" | "json"; // 默认 form（Spring Security 风格）
  wikiLoginPath?: string;     // 默认 /login
  wikiLoginCsrf?: boolean;    // form 模式是否从登录页提取 _csrf，默认 true
  wikiSessionTtlSec?: number; // 会话缓存 TTL，默认 600
}

const DEFAULT_LOGIN_PATH = "/login";
const DEFAULT_USERNAME = "zyplayer";
const DEFAULT_PASSWORD = "123456";

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

/** 把 Set-Cookie 头解析进 cookie 容器 */
function mergeSetCookie(jar: Map<string, string>, setCookieHeader: string | string[] | undefined): void {
  const list = setCookieHeader === undefined ? [] : Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const sc of list) {
    const first = sc.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

function jarToCookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 从登录页 HTML 提取 CSRF token（Spring Security 的 _csrf 常见写法） */
function extractCsrfToken(html: string): string | undefined {
  const patterns = [
    /<input[^>]*name=["']_csrf["'][^>]*value=["']([^"']+)["']/i,
    /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i,
    /name=["']_csrf["'][^>]*value=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * 执行 wiki 登录，返回上游会话 cookie 头；失败返回 undefined。
 * form 模式：GET 登录页（拿 cookie + _csrf）→ POST 表单凭据。
 * json 模式：直接 POST JSON 凭据。
 */
async function wikiLogin(opts: WikiProxyOptions): Promise<string | undefined> {
  const base = opts.target.replace(/\/+$/, "");
  const path = opts.wikiLoginPath || DEFAULT_LOGIN_PATH;
  const username = opts.wikiUsername || DEFAULT_USERNAME;
  const password = opts.wikiPassword || DEFAULT_PASSWORD;
  const jar = new Map<string, string>();

  if (opts.wikiLoginMode === "json") {
    try {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: jarToCookieHeader(jar) },
        body: JSON.stringify({ username, password }),
        redirect: "manual",
      });
      mergeSetCookie(jar, res.headers.get("set-cookie") ?? undefined);
    } catch (err) {
      console.error("[wiki-proxy] auto-login (json) error:", (err as Error).message);
    }
    return jar.size ? jarToCookieHeader(jar) : undefined;
  }

  try {
    const page = await fetch(base + path, { headers: { cookie: jarToCookieHeader(jar) }, redirect: "manual" });
    mergeSetCookie(jar, page.headers.get("set-cookie") ?? undefined);
    const html = await page.text();
    const csrf = opts.wikiLoginCsrf !== false ? extractCsrfToken(html) : undefined;

    const form = new URLSearchParams();
    form.set("username", username);
    form.set("password", password);
    if (csrf) form.set("_csrf", csrf);

    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: jarToCookieHeader(jar) },
      body: form.toString(),
      redirect: "manual",
    });
    mergeSetCookie(jar, res.headers.get("set-cookie") ?? undefined);
  } catch (err) {
    console.error("[wiki-proxy] auto-login (form) error:", (err as Error).message);
  }
  return jar.size ? jarToCookieHeader(jar) : undefined;
}

/** 上游会话缓存：自动登录、TTL 刷新、失效重登 */
class WikiSessionManager {
  private cookie: string | undefined;
  private expiresAt = 0;
  private inflight: Promise<string | undefined> | undefined;

  constructor(private opts: WikiProxyOptions) {}

  private get ttlMs(): number {
    return (this.opts.wikiSessionTtlSec || 600) * 1000;
  }

  async get(): Promise<string | undefined> {
    if (this.cookie && Date.now() < this.expiresAt) return this.cookie;
    return this.refresh();
  }

  refresh(): Promise<string | undefined> {
    if (!this.inflight) {
      this.inflight = wikiLogin(this.opts)
        .then((c) => {
          this.cookie = c;
          this.expiresAt = Date.now() + this.ttlMs;
          this.inflight = undefined;
          return c;
        })
        .catch((err) => {
          console.error("[wiki-proxy] auto-login failed:", (err as Error).message);
          this.inflight = undefined;
          return undefined;
        });
    }
    return this.inflight;
  }

  invalidate(): void {
    this.cookie = undefined;
    this.expiresAt = 0;
  }
}

/** 构造上游请求头：剥掉 navigate_token，注入 wiki 会话 cookie */
function buildUpstreamHeaders(
  req: http.IncomingMessage,
  sessionCookie: string | undefined,
  target: URL,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
  const browserCookie = (req.headers.cookie || "").replace(/(?:^|;\s*)navigate_token=[^;]*(;|$)/gi, "$1");
  const combined = [sessionCookie, browserCookie].filter(Boolean).join("; ");
  if (combined) headers.cookie = combined;
  else delete headers.cookie;
  return headers;
}

/**
 * 转发一次。返回 "ok"（已写回响应）或 "login-required"（上游要求登录，未写回）。
 * 仅在 GET 且命中 302→登录页时判为 login-required（GET 无请求体，可安全重放）。
 */
function forwardOnce(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: URL,
  headers: http.OutgoingHttpHeaders,
  loginPath: string,
): Promise<"ok" | "login-required"> {
  return new Promise((resolve) => {
    const proxyReq = http.request(
      { hostname: target.hostname, port: target.port, method: req.method, path: req.url ?? "/", headers },
      (proxyRes) => {
        const loc = proxyRes.headers.location;
        if (proxyRes.statusCode === 302 && typeof loc === "string" && loc.includes(loginPath)) {
          proxyRes.resume(); // 释放上游连接
          resolve("login-required");
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        resolve("ok");
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("502 Bad Gateway — wiki upstream unavailable");
      resolve("ok");
    });
    req.pipe(proxyReq);
  });
}

/**
 * 独立端口鉴权反向代理：整站转发到 wiki。
 * 1) 校验 navigate_token（cookie 或 ?token=），未登录 302 到 Navigate 登录页。
 * 2) 用 .env 配置的 wiki 账号自动登录，把会话 cookie 注入上游请求（wiki 免二次登录）。
 * 3) 上游会话过期（302→wiki 登录页）时自动重新登录并重试一次。
 */
export function startWikiProxy(opts: WikiProxyOptions): http.Server {
  const target = new URL(opts.target);
  const loginPath = opts.wikiLoginPath || DEFAULT_LOGIN_PATH;
  const sessionManager = new WikiSessionManager(opts);

  const server = http.createServer((req, res) => {
    const token = extractToken(req);
    if (!token || !tokenManager.validate(token)) {
      const next = encodeURIComponent(`${opts.proxyOrigin}${req.url ?? "/"}`);
      res.writeHead(302, { Location: `${opts.loginUrl}?next=${next}` });
      res.end();
      return;
    }
    handleProxy(req, res, sessionManager, target, loginPath);
  });

  server.listen(opts.port, () => {
    console.log(`🔐 Wiki proxy: http://localhost:${opts.port} → ${opts.target}（需登录 + 自动登录 wiki）`);
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

async function handleProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionManager: WikiSessionManager,
  target: URL,
  loginPath: string,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();

  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await sessionManager.get();
    const headers = buildUpstreamHeaders(req, session, target);
    const outcome = await forwardOnce(req, res, target, headers, loginPath);
    if (outcome === "ok") return;
    // 上游要求登录 → 重新登录后重试（仅 GET 安全）
    if (method === "GET") {
      sessionManager.invalidate();
      continue;
    }
    break;
  }

  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("502 Bad Gateway — wiki session could not be established");
  }
}
