import http from "node:http";
import crypto from "node:crypto";
import { tokenManager } from "./token.js";
import { AUTH_COOKIE, getCookie } from "./auth-helpers.js";

export interface WikiProxyOptions {
  port: number;
  target: string;      // 如 "http://localhost:8083"
  loginUrl: string;    // 如 "http://localhost:3001/login"
  proxyOrigin: string; // 如 "http://localhost:3003"（登录 next 白名单用）
  // wiki 自动登录（可选）：配置了 wikiUsername 才启用。
  // zyplayer-doc 前端 SPA 登录态存在浏览器 localStorage，cookie 注入无效，
  // 默认请直接在 3003 手动登录一次 wiki，浏览器会记住。
  wikiUsername?: string;       // 配置后启用自动登录
  wikiPassword?: string;       // 默认 123456
  wikiLoginMode?: "form" | "json" | "rsa"; // 默认 form；rsa = 前端 RSA-PKCS1 加密密码（zyplayer-doc）
  wikiLoginPath?: string;      // 默认 /login（json/rsa 模式也用；rsa 模式还需 /loginConfig）
  wikiLoginCsrf?: boolean;     // form 模式是否提取 _csrf，默认 true
  wikiSessionTtlSec?: number;  // 会话缓存 TTL，默认 600
}

const DEFAULT_LOGIN_PATH = "/login";
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
 * 仅适用于 cookie 会话型 wiki；前端 SPA + localStorage token 的 wiki 无法用此方式。
 */
async function wikiLogin(opts: WikiProxyOptions): Promise<string | undefined> {
  const base = opts.target.replace(/\/+$/, "");
  const path = opts.wikiLoginPath || DEFAULT_LOGIN_PATH;
  const username = opts.wikiUsername!;
  const password = opts.wikiPassword || DEFAULT_PASSWORD;
  const jar = new Map<string, string>();

  if (opts.wikiLoginMode === "rsa") {
    // zyplayer-doc 前端登录：POST /loginConfig 拿公钥+sessionId → RSA-PKCS1 加密密码 → POST /login
    try {
      const cfg = await fetch(base + "/loginConfig", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: jarToCookieHeader(jar) },
        body: "{}",
        redirect: "manual",
      }).then((r) => r.json());
      const publicKey = cfg?.data?.publicKey as string | undefined;
      const sessionId = cfg?.data?.sessionId as string | undefined;
      if (!publicKey || !sessionId) return undefined;

      const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
      const enc = crypto.publicEncrypt(
        { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(password),
      ).toString("base64");

      const form = new URLSearchParams();
      form.set("username", username);
      form.set("password", enc);
      form.set("verificationCode", "");
      form.set("termsChecked", "false");
      form.set("sessionId", sessionId);
      form.set("loginClient", "pc");
      form.set("_", `${base}/`);
      form.set("_lang", "zh-CN");

      const res = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: jarToCookieHeader(jar) },
        body: form.toString(),
        redirect: "manual",
      });
      mergeSetCookie(jar, res.headers.get("set-cookie") ?? undefined);
      // 登录失败（errCode != 200）时不要留下假会话
      if (res.headers.get("content-type")?.includes("json")) {
        const text = await res.text();
        try {
          const j = JSON.parse(text) as { errCode?: number };
          if (j.errCode !== undefined && j.errCode !== 200) return undefined;
        } catch { /* 非 JSON 忽略 */ }
      }
    } catch (err) {
      console.error("[wiki-proxy] auto-login (rsa) error:", (err as Error).message);
    }
    return jar.size ? jarToCookieHeader(jar) : undefined;
  }

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

/** 构造上游请求头：剥掉 navigate_token，可选注入 wiki 会话 cookie */
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
 * detectLoginRedirect 为 true（自动登录模式）时才会拦截 302→登录页；否则原样转发。
 */
function forwardOnce(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: URL,
  headers: http.OutgoingHttpHeaders,
  loginPath: string,
  detectLoginRedirect: boolean,
): Promise<"ok" | "login-required"> {
  return new Promise((resolve) => {
    const proxyReq = http.request(
      { hostname: target.hostname, port: target.port, method: req.method, path: req.url ?? "/", headers },
      (proxyRes) => {
        const loc = proxyRes.headers.location;
        if (detectLoginRedirect && proxyRes.statusCode === 302 && typeof loc === "string" && loc.includes(loginPath)) {
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
 * 2) 默认透传：浏览器携带的 wiki 登录态（cookie / 手动登录过的 localStorage）直接生效，
 *    在 wiki 是前端 SPA + localStorage token 时，用户在 3003 手动登录一次即可长期免登录。
 * 3) 可选自动登录：配置 H5_WIKI_USERNAME 后，代理用该账号登录 wiki 并注入会话 cookie
 *    （仅对 cookie 会话型 wiki 有效），会话过期（302→wiki 登录页）时自动重登一次。
 */
export function startWikiProxy(opts: WikiProxyOptions): http.Server {
  const target = new URL(opts.target);
  const loginPath = opts.wikiLoginPath || DEFAULT_LOGIN_PATH;
  const autoLogin = Boolean(opts.wikiUsername);
  const sessionManager = new WikiSessionManager(opts);

  const server = http.createServer((req, res) => {
    const token = extractToken(req);
    if (!token || !tokenManager.validate(token)) {
      const next = encodeURIComponent(`${opts.proxyOrigin}${req.url ?? "/"}`);
      res.writeHead(302, { Location: `${opts.loginUrl}?next=${next}` });
      res.end();
      return;
    }
    handleProxy(req, res, sessionManager, target, loginPath, autoLogin);
  });

  server.listen(opts.port, () => {
    const mode = autoLogin ? "自动登录 wiki" : "手动登录 wiki 一次";
    console.log(`🔐 Wiki proxy: http://localhost:${opts.port} → ${opts.target}（需登录；${mode}）`);
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
  autoLogin: boolean,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const maxAttempts = autoLogin ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const session = autoLogin ? await sessionManager.get() : undefined;
    const headers = buildUpstreamHeaders(req, session, target);
    const outcome = await forwardOnce(req, res, target, headers, loginPath, autoLogin);
    if (outcome === "ok") return;
    // 自动登录模式下，上游要求登录 → 重新登录后重试（仅 GET 安全）
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
