import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenManager, TOKEN_TTL_MS } from "./token.js";
import { AUTH_COOKIE, serializeCookie, getToken, deriveCookieDomain, stripTokenQuery } from "./auth-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Credential { username: string; password: string; }

/** 每次调用读取 env，便于测试切换账号 */
function loadCredentials(): Credential[] {
  const raw = process.env.H5_LOGIN_USERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Credential[];
      if (Array.isArray(parsed) && parsed.length > 0 &&
          parsed.every((c) => c && typeof c.username === "string" && typeof c.password === "string")) {
        return parsed;
      }
    } catch { /* 格式错误则忽略，回退单账号 */ }
  }
  const u = process.env.H5_LOGIN_USERNAME;
  const p = process.env.H5_LOGIN_PASSWORD;
  return u && p ? [{ username: u, password: p }] : [];
}

/** timing-safe 字符串比较 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function validateCredentials(username: unknown, password: unknown): boolean {
  if (typeof username !== "string" || typeof password !== "string") return false;
  return loadCredentials().some((c) => safeEqual(c.username, username) && safeEqual(c.password, password));
}

// 防爆破：每 IP 5 次失败锁 60s
const FAIL_LIMIT = 5;
const LOCK_MS = 60_000;
const attempts = new Map<string, { fails: number; lockedUntil: number }>();

export function checkLoginRate(ip: string): { locked: boolean; retryAfterSec: number } {
  const rec = attempts.get(ip);
  if (!rec) return { locked: false, retryAfterSec: 0 };
  if (Date.now() < rec.lockedUntil) return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  if (rec.fails >= FAIL_LIMIT) attempts.delete(ip); // 锁已过，重置
  return { locked: false, retryAfterSec: 0 };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const rec = attempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
  if (now < rec.lockedUntil) return;
  rec.fails += 1;
  if (rec.fails >= FAIL_LIMIT) { rec.fails = 0; rec.lockedUntil = now + LOCK_MS; }
  attempts.set(ip, rec);
}

/**
 * next 白名单：同源路径，或 wiki 代理 origin（防开放重定向）。
 * proxyOrigins 兼容本地（http://localhost:3003）与公网 wiki（https://wiki.xxx.com）多个入口。
 * 返回前统一剥离 token 查询参数，避免旧 token 造成登录死循环。
 */
export function allowNext(next: unknown, proxyOrigins: string | string[] = []): string {
  if (typeof next !== "string" || !next) return "/";
  const cleaned = stripTokenQuery(next);
  if (cleaned.startsWith("/")) return cleaned;
  const origins = Array.isArray(proxyOrigins) ? proxyOrigins : [proxyOrigins];
  if (origins.some((o) => o && cleaned.startsWith(o))) return cleaned;
  return "/";
}

export function mountLoginRoutes(app: express.Express, opts: { proxyOrigin?: string; proxyOrigins?: string[] }): void {
  const proxyOrigins = [
    ...(opts.proxyOrigins ?? []),
    ...(opts.proxyOrigin ? [opts.proxyOrigin] : []),
  ];

  // 登录页（公开）
  app.get("/login", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
  });

  // 登录：校验账号 → 发 token + 种 httpOnly cookie
  app.post("/api/login", (req, res) => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const rate = checkLoginRate(ip);
    if (rate.locked) {
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      return res.status(429).json({ error: "尝试过于频繁，请稍后再试" });
    }
    const { username, password, next } = (req.body ?? {}) as { username?: unknown; password?: unknown; next?: unknown };
    if (!validateCredentials(username, password)) {
      recordLoginFailure(ip);
      return res.status(401).json({ error: "用户名或密码错误" });
    }
    attempts.delete(ip); // 登录成功，清失败计数
    const token = tokenManager.generate();
    const domain = deriveCookieDomain(req.hostname);
    res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE, token, {
      maxAgeSec: TOKEN_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.H5_COOKIE_SECURE === "true",
      domain,
    }));
    res.json({ token, expiresIn: Math.floor(TOKEN_TTL_MS / 1000), next: allowNext(next, proxyOrigins) });
  });

  // 登出：吊销 token + 清 cookie（带相同 domain 才能清掉跨子域 cookie）
  // 带 ?next= 时 302 跳转（H5 退出链接用）；否则返回 JSON（供 API 调用方）
  app.get("/api/logout", (req, res) => {
    const token = getToken(req);
    if (token) tokenManager.revoke(token);
    const domain = deriveCookieDomain(req.hostname);
    res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE, "", {
      maxAgeSec: 0, httpOnly: true, sameSite: "Lax",
      secure: process.env.H5_COOKIE_SECURE === "true",
      domain,
    }));
    if (req.query.next) {
      return res.redirect(302, allowNext(req.query.next, proxyOrigins));
    }
    res.json({ ok: true });
  });
}
