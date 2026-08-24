import type { Request } from "express";

/** 登录会话 cookie 名（httpOnly，供页面门槛与 wiki 代理使用） */
export const AUTH_COOKIE = "navigate_token";

/** 从 Cookie 头读取指定名字的值（不引入 cookie-parser） */
export function getCookie(headers: { cookie?: string }, name: string): string | undefined {
  const header = headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); }
      catch { return part.slice(eq + 1).trim(); }
    }
  }
  return undefined;
}

/**
 * 生成 Set-Cookie 头值（Path=/ 固定）。
 * domain 传入如 ".example.com" 时，cookie 在主域与所有子域共享
 * （wiki 子域名方案需要 navigate_token 同时作用于 wiki.xxx.com）。
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeSec?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" | "Strict" | "None"; domain?: string } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/"];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeSec)}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}

/**
 * 从请求 Host 推导 cookie 根域（带前导 "."，如 "wiki.example.com" → ".example.com"）。
 * localhost / IP 直连不设 Domain（host-only，保持本地行为）；复杂后缀域名（如 .com.cn）
 * 推导可能不准，可用 H5_COOKIE_DOMAIN 显式覆盖。
 */
export function deriveCookieDomain(host: string | undefined): string | undefined {
  const override = process.env.H5_COOKIE_DOMAIN?.trim();
  if (override) return override.startsWith(".") ? override : `.${override}`;
  if (!host) return undefined;
  const h = host.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  if (h === "localhost" || h === "127.0.0.1" || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return undefined;
  const parts = h.split(".");
  if (parts.length < 2) return undefined;
  return `.${parts.slice(-2).join(".")}`;
}

/** 统一 token 提取：?token= → body.token → 登录 cookie */
export function getToken(req: Request): string | undefined {
  if (req.query?.token) return req.query.token as string;
  if (req.body?.token) return req.body.token;
  return getCookie(req.headers, AUTH_COOKIE);
}

/**
 * 剥离 URL 里的 token 查询参数。
 * 旧 token（如已吊销/过期的 ?token=）会覆盖 cookie 登录态（getToken 优先 query），
 * 若被带进登录页 next 会造成「登录成功 → 跳回带旧 token 的 URL → 又被踢回登录页」死循环。
 */
export function stripTokenQuery(url: string): string {
  if (!url.includes("token=")) return url;
  try {
    const u = new URL(url, "http://localhost");
    u.searchParams.delete("token");
    const target = `${u.pathname}${u.search}${u.hash}`;
    // 绝对 URL 保留 origin；相对 URL（/ 开头）保持相对
    return /^https?:\/\//i.test(url) ? `${u.origin}${target}` : target;
  } catch {
    return url;
  }
}
