import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiKeyStore } from "./key-store.js";
import { NonceStore } from "./nonce-store.js";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function computeSignature(
  key: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer | string,
): string {
  const canonical = `${method}\n${path}\n${timestamp}\n${nonce}\n${sha256Hex(rawBody)}`;
  return createHmac("sha256", key).update(canonical).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifySignature(
  key: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer | string,
  signature: string,
): boolean {
  return safeEqual(computeSignature(key, method, path, timestamp, nonce, rawBody), signature);
}

export function normalizeIp(ip: string): string {
  const cleaned = ip.trim();
  if (cleaned.startsWith("::ffff:")) return cleaned.slice(7); // IPv4-mapped IPv6
  return cleaned;
}

export function ipMatchesWhitelist(ip: string, whitelist: string[]): boolean {
  const addr = normalizeIp(ip);
  const isV4 = addr.includes(".");
  for (const rule of whitelist) {
    if (rule.includes("/")) {
      const [base, bitsRaw] = rule.split("/");
      const bits = parseInt(bitsRaw, 10);
      // Skip malformed/out-of-range CIDR rules instead of matching or throwing.
      // Note: parseInt("24x") is 24, so validate the raw string too, not just the parsed value.
      if (!/^\d+$/.test(bitsRaw.trim()) || !Number.isInteger(bits) || bits < 0 || (isV4 ? bits > 32 : bits > 128)) {
        continue;
      }
      if (isV4 && base.includes(".") && ip4InCidr(addr, base, bits)) return true;
      if (!isV4 && !base.includes(".") && ip6InCidr(addr, base, bits)) return true;
    } else if (addr === normalizeIp(rule)) {
      return true;
    }
  }
  return false;
}

function ip4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ip4InCidr(ip: string, base: string, bits: number): boolean {
  const a = ip4ToInt(ip);
  const b = ip4ToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function ip6ToBigInt(ip: string): bigint | null {
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const parts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  if (parts.length !== 8) return null;
  let out = 0n;
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    out = (out << 16n) | BigInt(parseInt(p, 16));
  }
  return out;
}

function ip6InCidr(ip: string, base: string, bits: number): boolean {
  const a = ip6ToBigInt(ip);
  const b = ip6ToBigInt(base);
  if (a === null || b === null) return false;
  const mask = bits >= 128 ? (1n << 128n) - 1n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (a & mask) === (b & mask);
}

export interface ApiKeyAuthConfig {
  keyStore: ApiKeyStore;
  ipWhitelist?: string[];
  signatureWindowMs?: number;
  trustProxy?: boolean;
  /** 失败鉴权限流:窗口内同 IP 失败达到该次数后返回 429(默认 5) */
  failureLimit?: number;
  /** 失败鉴权限流窗口 ms(默认 60000) */
  failureWindowMs?: number;
}

/** 同 IP 失败鉴权限流(滑动窗口计数) */
export class FailureRateLimiter {
  private failures = new Map<string, number[]>(); // ip -> 失败时间戳列表

  constructor(
    private windowMs: number = 60_000,
    private limit: number = 5,
  ) {}

  /** 该 IP 在窗口内失败次数是否已达到上限 */
  isLimited(ip: string, now: number = Date.now()): boolean {
    const list = this.failures.get(ip);
    if (!list) return false;
    const fresh = list.filter((t) => now - t <= this.windowMs);
    if (fresh.length !== list.length) this.failures.set(ip, fresh);
    return fresh.length >= this.limit;
  }

  recordFailure(ip: string, now: number = Date.now()): void {
    const list = this.failures.get(ip) ?? [];
    list.push(now);
    this.failures.set(ip, list);
  }

  /** 成功鉴权后清零,避免合法用户被误锁 */
  clear(ip: string): void {
    this.failures.delete(ip);
  }
}

function deny(res: Response, reason: string, ip: string, extra?: Record<string, unknown>): void {
  console.log(`[mcp-auth] 401 reason=${reason} ip=${ip}${extra?.key ? ` key=${extra.key}` : ""}`);
  res.setHeader("WWW-Authenticate", "Bearer");
  res.status(401).json({ error: reason, ...extra });
}

export function createApiKeyAuth(config: ApiKeyAuthConfig): RequestHandler {
  const windowMs = config.signatureWindowMs ?? 300_000;
  const nonces = new NonceStore(windowMs);
  const limiter = new FailureRateLimiter(config.failureWindowMs ?? 60_000, config.failureLimit ?? 5);

  // 记录失败并返回 401
  const fail = (res: Response, reason: string, ip: string, extra?: Record<string, unknown>): void => {
    limiter.recordFailure(ip);
    deny(res, reason, ip, extra);
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? "";

    // 失败限流:窗口内同 IP 失败达到阈值 → 429,直接拒绝
    if (limiter.isLimited(ip)) {
      console.log(`[mcp-auth] 429 rate limited ip=${ip}`);
      res.status(429).json({ error: "too many requests" });
      return;
    }

    if (config.ipWhitelist && config.ipWhitelist.length > 0 && !ipMatchesWhitelist(ip, config.ipWhitelist)) {
      return fail(res, "ip not allowed", ip);
    }

    const signature = req.headers["x-signature"];
    if (typeof signature === "string" && signature.length > 0) {
      return verifyHmacRequest(req, res, next, config, nonces, windowMs, ip, signature, limiter);
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const key = authHeader.slice("Bearer ".length).trim();
      const entry = config.keyStore.lookup(key);
      if (!entry) return fail(res, "invalid key", ip);
      if (config.keyStore.isExpired(entry)) {
        console.warn(`[mcp-auth] WARNING: key ${key} expired`);
        return fail(res, "key expired", ip, { key });
      }
      limiter.clear(ip);
      return next();
    }

    return fail(res, "missing credentials", ip);
  };
}

function verifyHmacRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  config: ApiKeyAuthConfig,
  nonces: NonceStore,
  windowMs: number,
  ip: string,
  signature: string,
  limiter: FailureRateLimiter,
): void {
  const fail = (reason: string, extra?: Record<string, unknown>): void => {
    limiter.recordFailure(ip);
    deny(res, reason, ip, extra);
  };

  const ts = req.headers["x-timestamp"];
  const nonce = req.headers["x-nonce"];
  if (typeof ts !== "string" || typeof nonce !== "string") {
    return fail("invalid signature headers");
  }
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return fail("timestamp expired");
  if (Math.abs(Date.now() - tsNum) > windowMs) return fail("timestamp expired");

  const path = (req.originalUrl ?? "/").split("?")[0];
  const rawBody = (req as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const method = req.method ?? "GET";

  for (const entry of config.keyStore.activeKeys()) {
    if (verifySignature(entry.key, method, path, ts, nonce, rawBody, signature)) {
      if (!nonces.checkAndSet(entry.key, nonce)) return fail("replay detected");
      limiter.clear(ip);
      return next();
    }
  }
  return fail("signature mismatch");
}
