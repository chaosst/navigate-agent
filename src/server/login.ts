import express from "express";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenManager, TOKEN_TTL_MS } from "./token.js";
import { AUTH_COOKIE, getCookie, serializeCookie, getToken, deriveCookieDomain, stripTokenQuery } from "./auth-helpers.js";
import { authenticate, type H5User } from "./users.js";
import { challengeStore, mountChallengeRoutes, SID_COOKIE } from "./login-challenge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 账号校验委托 users.ts（env 种子 / rag_data/h5-users.json 文件，详见该文件头注释） */
export function validateCredentials(username: unknown, password: unknown): boolean {
  return authenticate(username, password) !== undefined;
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

// ── 账号维度防撞库（与 IP 维度并行）：防分布式代理换 IP 对单账号撞库 ──────
// 校验码触发阈值：IP 或账号任一方累计失败 ≥2 后，登录需先通过条件式校验码
// （正常用户无感；脚本每次还要 OCR 图像，成本显著抬高）
const CHALLENGE_THRESHOLD = 2;
const userAttempts = new Map<string, { fails: number; lockedUntil: number }>();

export function checkAccountRate(username: string): { locked: boolean; retryAfterSec: number } {
  const rec = userAttempts.get(username);
  if (!rec) return { locked: false, retryAfterSec: 0 };
  if (Date.now() < rec.lockedUntil) return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  if (rec.fails >= FAIL_LIMIT) userAttempts.delete(username); // 锁已过，重置
  return { locked: false, retryAfterSec: 0 };
}

export function recordUserLoginFailure(username: string): void {
  if (!username) return; // 空用户名无账号可锁，交给 IP 维度
  const now = Date.now();
  const rec = userAttempts.get(username) ?? { fails: 0, lockedUntil: 0 };
  if (now < rec.lockedUntil) return;
  rec.fails += 1;
  if (rec.fails >= FAIL_LIMIT) { rec.fails = 0; rec.lockedUntil = now + LOCK_MS; }
  userAttempts.set(username, rec);
}

/** 本次登录是否要求条件式校验码：IP 或账号任一方累计失败 ≥ 阈值 */
export function needsChallenge(ip: string, username: string): boolean {
  const ipHits = attempts.get(ip)?.fails ?? 0;
  const userHits = username ? userAttempts.get(username)?.fails ?? 0 : 0;
  return ipHits >= CHALLENGE_THRESHOLD || userHits >= CHALLENGE_THRESHOLD;
}

/** 登录成功：清双维失败计数 */
function clearAttempts(ip: string, username: string): void {
  attempts.delete(ip);
  if (username) userAttempts.delete(username);
}

/** 测试隔离：清空全部内存防护状态（防 127.0.0.1 等共享 key 跨用例污染） */
export function resetLoginProtectionForTests(): void {
  attempts.clear();
  userAttempts.clear();
  challengeStore.clear();
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

  // 条件式校验码：GET 挑战 / GET 图片（见 login-challenge.ts，答案不下发）
  mountChallengeRoutes(app);

  // 校验码状态探测（免登录、无副作用）：登录页加载/输入用户名时预判该会话是否已处于
  // "需校验码"状态。服务端失败计数在内存——用户失败 2 次后即使刷新/重开登录页，
  // 提交仍会被强制校验码；此接口让前端提前展示输入区，避免"看不到校验码"的错位体验。
  // 仅返回布尔，不泄露账号是否存在；与 /api/login 的 needChallenge 判定完全同源。
  app.get("/api/login/challenge-needed", (req, res) => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const username = typeof req.query.username === "string" ? req.query.username.trim() : "";
    res.setHeader("Cache-Control", "no-store");
    res.json({ needChallenge: needsChallenge(ip, username) });
  });

  // 登录：校验账号 → 发携带身份（username/role）的 token + 种 httpOnly cookie
  // 防爆破顺序：① 双维锁定(429) → ② 可疑流量需条件式校验码 → ③ 账号校验 → ④ 成功清计数
  app.post("/api/login", (req, res) => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const { username, password, next, challengeId, code } = (req.body ?? {}) as {
      username?: unknown; password?: unknown; next?: unknown; challengeId?: unknown; code?: unknown;
    };
    const userKey = typeof username === "string" ? username.trim() : "";

    // ① IP / 账号双维锁定（429 + Retry-After）
    const rate = checkLoginRate(ip);
    const acct = userKey ? checkAccountRate(userKey) : { locked: false, retryAfterSec: 0 };
    const lock = rate.locked ? rate : acct;
    if (lock.locked) {
      res.setHeader("Retry-After", String(lock.retryAfterSec));
      return res.status(429).json({ error: "尝试过于频繁，请稍后再试", needChallenge: false, retryAfterSec: lock.retryAfterSec });
    }

    // ② 条件式校验码（仅可疑流量触发；一次性消费，答案在服务端）
    if (needsChallenge(ip, userKey)) {
      const verdict = challengeStore.consume(getCookie(req.headers, SID_COOKIE), challengeId, code);
      if (verdict !== "ok") {
        if (verdict === "wrong") recordLoginFailure(ip); // 校验码答错按失败重权计 IP
        return res.status(401).json({
          error: verdict === "wrong" ? "校验码错误，请重新输入" : "校验码缺失或已失效，请刷新重试",
          needChallenge: true,
        });
      }
    }

    // ③ 账号校验
    const user: H5User | undefined = authenticate(username, password);
    if (!user) {
      recordLoginFailure(ip);
      if (userKey) recordUserLoginFailure(userKey);
      return res.status(401).json({ error: "用户名或密码错误", needChallenge: needsChallenge(ip, userKey) });
    }

    // ④ 成功：清双维失败计数 + 发 token + cookie
    clearAttempts(ip, userKey);
    const token = tokenManager.generate({ username: user.username, role: user.role });
    const domain = deriveCookieDomain(req.hostname);
    res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE, token, {
      maxAgeSec: TOKEN_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.H5_COOKIE_SECURE === "true",
      domain,
    }));
    res.json({ token, role: user.role, expiresIn: Math.floor(TOKEN_TTL_MS / 1000), next: allowNext(next, proxyOrigins) });
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
