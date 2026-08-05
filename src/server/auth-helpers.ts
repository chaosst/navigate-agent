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

/** 生成 Set-Cookie 头值（Path=/ 固定） */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeSec?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" | "Strict" | "None" } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/"];
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeSec)}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}

/** 统一 token 提取：?token= → body.token → 登录 cookie */
export function getToken(req: Request): string | undefined {
  if (req.query?.token) return req.query.token as string;
  if (req.body?.token) return req.body.token;
  return getCookie(req.headers, AUTH_COOKIE);
}
