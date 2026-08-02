# 固定 API key + MCP 服务 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 navigate 的 Express 服务上挂载一个受固定 API key 保护的 MCP 端点(`/mcp`),暴露 `search_documents` / `search_keyword` / `list_documents` / `get_stats` 四个工具;鉴权支持 Bearer(标准 MCP 客户端)与 HMAC 签名(程序化,防重放)双模式,多把 key 各带独立过期时间,可选 IP + CIDR 白名单。

**Architecture:** 新增 `ApiKeyStore`(多 key + 过期)、`NonceStore`(防重放缓存)、`createApiKeyAuth` 中间件(双模式鉴权)。`createMcpServer` 用 SDK `McpServer` 注册 4 个工具,处理函数直接调 `PgVectorStore`。`mountMcpRoutes` 把 `StreamableHTTPServerTransport` 挂到 `/mcp`,鉴权先于传输。现有 `/api/*` 动态 token 体系不动。

**Tech Stack:** TypeScript (ESM)、Express 5、`@modelcontextprotocol/sdk@^1.29.0`、zod、vitest(新增 devDependency)、Node 内置 `crypto`。

## Global Constraints

- Node >= 18(本机 24)。TypeScript ESM,import 一律带 `.js` 后缀(与现有代码一致)。
- 注释风格跟随现有代码(中文短注释)。日志走 `console`(现有体系)。
- `@modelcontextprotocol/sdk` 版本固定 ^1.29.0;新增 import 路径:`server/mcp.js`、`server/streamableHttp.js`、`client/index.js`、`client/streamableHttp.js`、`inMemory.js`。
- 鉴权失败统一 `401` + `WWW-Authenticate: Bearer` + JSON `{error: <reason>}`。reason 集合:`missing credentials` / `invalid key` / `key expired` / `timestamp expired` / `replay detected` / `signature mismatch` / `ip not allowed`。
- HMAC 模式 key 不上网,只传签名;HMAC 验证失败(逐把 key 均未验中)统一返回 `signature mismatch`,不泄露 key 是否存在。
- 签名规范(与 spec 一致):`HMAC-SHA256(key, METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256_HEX(rawBody))`,hex 输出。`PATH` 为不含 query string 的请求路径(`req.originalUrl.split("?")[0]`)。`rawBody` 通过 `express.json({ verify })` 捕获。

---

### Task 1: Vitest 测试框架

**Files:**
- Modify: `package.json`(加 devDependency + scripts)
- Create: `src/server/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` 运行 vitest(run 模式);vitest 已配置可跑 `src/**/*.test.ts`。

- [ ] **Step 1: 安装 vitest**

```bash
npm install -D vitest
```

- [ ] **Step 2: 加 test scripts**

在 `package.json` 的 `"scripts"` 里加:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: 写冒烟测试**

创建 `src/server/__tests__/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: 运行验证**

Run: `npm test`
Expected: 1 test passes,exit 0。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/server/__tests__/smoke.test.ts
git commit -m "test: add vitest harness"
```

---

### Task 2: ApiKeyStore(多 key + 独立过期)

**Files:**
- Create: `src/server/key-store.ts`
- Test: `src/server/__tests__/key-store.test.ts`

**Interfaces:**
- Produces:
  - `interface ApiKeyEntry { key: string; expiresAt?: number }`(`expiresAt` 为 epoch ms,`undefined` = 永不过期)
  - `class ApiKeyStore`
    - `static fromEnv(apiKeysRaw: string | undefined, legacyRaw: string | undefined): ApiKeyStore` — 解析 `API_KEYS`(`sk-a:2026-12-31T00:00:00Z,sk-b`)并合并 `API_KEY`(legacy,无过期)
    - `lookup(key: string): ApiKeyEntry | undefined`
    - `isExpired(entry: ApiKeyEntry, now?: number): boolean`
    - `activeKeys(now?: number): ApiKeyEntry[]` — 未过期的 key 列表
    - `get size(): number`

- [ ] **Step 1: 写失败测试**

创建 `src/server/__tests__/key-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ApiKeyStore } from "../key-store.js";

describe("ApiKeyStore", () => {
  it("parses API_KEYS with mixed expiry", () => {
    const s = ApiKeyStore.fromEnv("sk-aaa:2026-12-31T00:00:00Z,sk-bbb", undefined);
    expect(s.size).toBe(2);
    expect(s.lookup("sk-aaa")?.expiresAt).toBe(Date.parse("2026-12-31T00:00:00Z"));
    expect(s.lookup("sk-bbb")?.expiresAt).toBeUndefined();
  });

  it("treats expired keys as invalid and excludes them from activeKeys", () => {
    const s = ApiKeyStore.fromEnv("sk-old:2000-01-01T00:00:00Z,sk-new", undefined);
    const old = s.lookup("sk-old")!;
    expect(s.isExpired(old, Date.parse("2026-01-01T00:00:00Z"))).toBe(true);
    expect(s.activeKeys(Date.parse("2026-01-01T00:00:00Z")).map((e) => e.key)).toEqual(["sk-new"]);
  });

  it("merges legacy single key without expiry", () => {
    const s = ApiKeyStore.fromEnv(undefined, "sk-legacy");
    expect(s.lookup("sk-legacy")).toBeDefined();
    expect(s.lookup("sk-legacy")?.expiresAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/__tests__/key-store.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

创建 `src/server/key-store.ts`:

```ts
export interface ApiKeyEntry {
  key: string;
  /** epoch ms; undefined = never expires */
  expiresAt?: number;
}

export function parseExpiresAt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

export class ApiKeyStore {
  private byKey = new Map<string, ApiKeyEntry>();

  private constructor() {}

  /** Parse "sk-a:2026-12-31T00:00:00Z,sk-b" (API_KEYS) plus legacy single key (API_KEY). */
  static fromEnv(apiKeysRaw: string | undefined, legacyRaw: string | undefined): ApiKeyStore {
    const store = new ApiKeyStore();
    if (apiKeysRaw) {
      for (const part of apiKeysRaw.split(",")) {
        const item = part.trim();
        if (!item) continue;
        const [key, ...rest] = item.split(":");
        if (!key) continue;
        store.add(key, parseExpiresAt(rest.join(":")));
      }
    }
    if (legacyRaw && legacyRaw.trim()) {
      store.add(legacyRaw.trim(), undefined);
    }
    return store;
  }

  private add(key: string, expiresAt: number | undefined): void {
    this.byKey.set(key, { key, expiresAt });
  }

  lookup(key: string): ApiKeyEntry | undefined {
    return this.byKey.get(key);
  }

  isExpired(entry: ApiKeyEntry, now: number = Date.now()): boolean {
    return entry.expiresAt !== undefined && now > entry.expiresAt;
  }

  /** Keys that are still valid — used for HMAC trial verification. */
  activeKeys(now: number = Date.now()): ApiKeyEntry[] {
    return [...this.byKey.values()].filter((e) => !this.isExpired(e, now));
  }

  get size(): number {
    return this.byKey.size;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/__tests__/key-store.test.ts`
Expected: 3 tests pass。

- [ ] **Step 5: Commit**

```bash
git add src/server/key-store.ts src/server/__tests__/key-store.test.ts
git commit -m "feat: add ApiKeyStore with per-key expiry"
```

---

### Task 3: NonceStore(防重放缓存)

**Files:**
- Create: `src/server/nonce-store.ts`
- Test: `src/server/__tests__/nonce-store.test.ts`

**Interfaces:**
- Produces: `class NonceStore`
  - `constructor(windowMs?: number, maxEntriesPerKey?: number)`
  - `checkAndSet(key: string, nonce: string, now?: number): boolean` — 窗口期内首次见返回 `true`,重放返回 `false`

- [ ] **Step 1: 写失败测试**

创建 `src/server/__tests__/nonce-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NonceStore } from "../nonce-store.js";

describe("NonceStore", () => {
  it("accepts a fresh nonce and rejects a replay for the same key", () => {
    const ns = new NonceStore(300_000);
    expect(ns.checkAndSet("sk-aaa", "n1", 1_000)).toBe(true);
    expect(ns.checkAndSet("sk-aaa", "n1", 1_001)).toBe(false);
  });

  it("accepts the same nonce for different keys", () => {
    const ns = new NonceStore(300_000);
    expect(ns.checkAndSet("sk-aaa", "n1", 1_000)).toBe(true);
    expect(ns.checkAndSet("sk-bbb", "n1", 1_000)).toBe(true);
  });

  it("forgets nonces after the window elapses", () => {
    const ns = new NonceStore(300_000);
    expect(ns.checkAndSet("sk-aaa", "n1", 1_000)).toBe(true);
    expect(ns.checkAndSet("sk-aaa", "n1", 400_000)).toBe(true); // past 300s window
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/__tests__/nonce-store.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

创建 `src/server/nonce-store.ts`:

```ts
export class NonceStore {
  private seen = new Map<string, Map<string, number>>(); // key -> (nonce -> timestampMs)

  constructor(
    private windowMs: number = 300_000,
    private maxEntriesPerKey: number = 100_000,
  ) {}

  /** Returns true if (key, nonce) is new within the window; false if it is a replay. */
  checkAndSet(key: string, nonce: string, now: number = Date.now()): boolean {
    let perKey = this.seen.get(key);
    if (!perKey) {
      perKey = new Map();
      this.seen.set(key, perKey);
    } else {
      for (const [n, ts] of perKey) {
        if (now - ts > this.windowMs) perKey.delete(n);
      }
    }
    if (perKey.has(nonce)) return false;
    perKey.set(nonce, now);
    if (perKey.size > this.maxEntriesPerKey) {
      const oldest = [...perKey.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) perKey.delete(oldest[0]);
    }
    return true;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/__tests__/nonce-store.test.ts`
Expected: 3 tests pass。

- [ ] **Step 5: Commit**

```bash
git add src/server/nonce-store.ts src/server/__tests__/nonce-store.test.ts
git commit -m "feat: add NonceStore for anti-replay"
```

---

### Task 4: 签名与 IP 白名单纯函数

**Files:**
- Create: `src/server/api-key-auth.ts`(本任务只加纯函数;中间件 Task 5 加)
- Test: `src/server/__tests__/api-key-auth.test.ts`(本任务写纯函数部分;中间件部分 Task 5 追加)

**Interfaces:**
- Produces:
  - `sha256Hex(data: Buffer | string): string`
  - `computeSignature(key, method, path, timestamp, nonce, rawBody: Buffer | string): string`
  - `safeEqual(a: string, b: string): boolean`(常量时间比较)
  - `verifySignature(key, method, path, timestamp, nonce, rawBody, signature): boolean`
  - `normalizeIp(ip: string): string`(去 IPv4-mapped IPv6 前缀 `::ffff:`)
  - `ipMatchesWhitelist(ip: string, whitelist: string[]): boolean`

- [ ] **Step 1: 写失败测试(纯函数部分)**

创建 `src/server/__tests__/api-key-auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeSignature, verifySignature, ipMatchesWhitelist, normalizeIp } from "../api-key-auth.js";

const BODY = Buffer.from(JSON.stringify({ query: "hello" }));

describe("HMAC signature helpers", () => {
  it("computes and verifies a correct signature", () => {
    const sig = computeSignature("sk-secret", "POST", "/mcp", "1700000000000", "n1", BODY);
    expect(verifySignature("sk-secret", "POST", "/mcp", "1700000000000", "n1", BODY, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = computeSignature("sk-secret", "POST", "/mcp", "1700000000000", "n1", BODY);
    const tampered = Buffer.from(JSON.stringify({ query: "evil" }));
    expect(verifySignature("sk-secret", "POST", "/mcp", "1700000000000", "n1", tampered, sig)).toBe(false);
  });

  it("rejects a different key", () => {
    const sig = computeSignature("sk-secret", "POST", "/mcp", "1700000000000", "n1", BODY);
    expect(verifySignature("sk-other", "POST", "/mcp", "1700000000000", "n1", BODY, sig)).toBe(false);
  });
});

describe("IP whitelist", () => {
  it("matches exact IP", () => {
    expect(ipMatchesWhitelist("10.0.0.5", ["10.0.0.5"])).toBe(true);
    expect(ipMatchesWhitelist("10.0.0.6", ["10.0.0.5"])).toBe(false);
  });

  it("matches IPv4 CIDR", () => {
    expect(ipMatchesWhitelist("10.0.1.9", ["10.0.0.0/8"])).toBe(true);
    expect(ipMatchesWhitelist("11.0.1.9", ["10.0.0.0/8"])).toBe(false);
  });

  it("normalizes IPv4-mapped IPv6", () => {
    expect(normalizeIp("::ffff:10.0.0.5")).toBe("10.0.0.5");
    expect(ipMatchesWhitelist("::ffff:10.0.0.5", ["10.0.0.5"])).toBe(true);
  });

  it("matches IPv6 CIDR", () => {
    expect(ipMatchesWhitelist("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipMatchesWhitelist("2001:db9::1", ["2001:db8::/32"])).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/__tests__/api-key-auth.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现纯函数**

创建 `src/server/api-key-auth.ts`:

```ts
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/__tests__/api-key-auth.test.ts`
Expected: 7 tests pass。

- [ ] **Step 5: Commit**

```bash
git add src/server/api-key-auth.ts src/server/__tests__/api-key-auth.test.ts
git commit -m "feat: add HMAC signature and IP whitelist helpers"
```

---

### Task 5: createApiKeyAuth 中间件(双模式)

**Files:**
- Modify: `src/server/api-key-auth.ts`(追加中间件)
- Modify: `src/server/__tests__/api-key-auth.test.ts`(追加中间件测试)

**Interfaces:**
- Consumes: `ApiKeyStore`(Task 2)、`NonceStore`(Task 3)、`computeSignature`/`verifySignature`/`ipMatchesWhitelist`(Task 4)
- Produces:
  - `interface ApiKeyAuthConfig { keyStore: ApiKeyStore; ipWhitelist?: string[]; signatureWindowMs?: number; trustProxy?: boolean }`
  - `createApiKeyAuth(config: ApiKeyAuthConfig): express.RequestHandler`
  - 依赖 `req.rawBody`(由 `express.json({ verify })` 提供)、`req.originalUrl`、`req.ip`、`req.socket?.remoteAddress`

- [ ] **Step 1: 追加失败测试**

在 `src/server/__tests__/api-key-auth.test.ts` 末尾追加:

```ts
import { vi } from "vitest";
import { createApiKeyAuth } from "../api-key-auth.js";
import { ApiKeyStore } from "../key-store.js";

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    originalUrl: "/mcp",
    headers: {} as Record<string, string>,
    socket: { remoteAddress: "127.0.0.1" },
    rawBody: Buffer.alloc(0),
    ...overrides,
  } as any;
}

function makeRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  return res;
}

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    keyStore: ApiKeyStore.fromEnv("sk-secret:2099-01-01T00:00:00Z", undefined),
    signatureWindowMs: 300_000,
    ...overrides,
  } as any;
}

describe("createApiKeyAuth", () => {
  it("accepts a valid bearer token", () => {
    const next = vi.fn();
    const mw = createApiKeyAuth(cfg());
    mw(makeReq({ headers: { authorization: "Bearer sk-secret" } }), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects missing credentials", () => {
    const res = makeRes();
    createApiKeyAuth(cfg())(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("missing credentials");
  });

  it("rejects an unknown key", () => {
    const res = makeRes();
    createApiKeyAuth(cfg())(makeReq({ headers: { authorization: "Bearer sk-wrong" } }), res, vi.fn());
    expect(res.body.error).toBe("invalid key");
  });

  it("rejects an expired key", () => {
    const res = makeRes();
    createApiKeyAuth(cfg({ keyStore: ApiKeyStore.fromEnv("sk-old:2000-01-01T00:00:00Z", undefined) }))(
      makeReq({ headers: { authorization: "Bearer sk-old" } }),
      res,
      vi.fn(),
    );
    expect(res.body.error).toBe("key expired");
  });

  it("accepts a valid HMAC signature", () => {
    const ts = String(Date.now());
    const nonce = "n-ok";
    const body = Buffer.from(JSON.stringify({ query: "x" }));
    const sig = computeSignature("sk-secret", "POST", "/mcp", ts, nonce, body);
    const next = vi.fn();
    createApiKeyAuth(cfg())(
      makeReq({ headers: { "x-signature": sig, "x-timestamp": ts, "x-nonce": nonce }, rawBody: body }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it("rejects a stale timestamp", () => {
    const ts = String(Date.now() - 3_600_000); // 1h ago
    const nonce = "n-stale";
    const body = Buffer.from(JSON.stringify({ query: "x" }));
    const sig = computeSignature("sk-secret", "POST", "/mcp", ts, nonce, body);
    const res = makeRes();
    createApiKeyAuth(cfg())(
      makeReq({ headers: { "x-signature": sig, "x-timestamp": ts, "x-nonce": nonce }, rawBody: body }),
      res,
      vi.fn(),
    );
    expect(res.body.error).toBe("timestamp expired");
  });

  it("rejects a replayed nonce (same middleware instance)", () => {
    const ts = String(Date.now());
    const nonce = "n-replay";
    const body = Buffer.from(JSON.stringify({ query: "x" }));
    const sig = computeSignature("sk-secret", "POST", "/mcp", ts, nonce, body);
    const mw = createApiKeyAuth(cfg());
    const req = () => makeReq({ headers: { "x-signature": sig, "x-timestamp": ts, "x-nonce": nonce }, rawBody: body });
    const res1 = makeRes();
    mw(req(), res1, vi.fn()); // first → ok
    const res2 = makeRes();
    mw(req(), res2, vi.fn()); // replay
    expect(res2.body.error).toBe("replay detected");
  });

  it("rejects IP not in whitelist", () => {
    const res = makeRes();
    createApiKeyAuth(cfg({ ipWhitelist: ["10.0.0.0/8"] }))(
      makeReq({ socket: { remoteAddress: "192.168.1.1" }, headers: { authorization: "Bearer sk-secret" } }),
      res,
      vi.fn(),
    );
    expect(res.body.error).toBe("ip not allowed");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/__tests__/api-key-auth.test.ts`
Expected: FAIL(`createApiKeyAuth` 未定义)。

- [ ] **Step 3: 追加中间件实现**

在 `src/server/api-key-auth.ts` 末尾追加:

```ts
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiKeyStore } from "./key-store.js";
import { NonceStore } from "./nonce-store.js";

export interface ApiKeyAuthConfig {
  keyStore: ApiKeyStore;
  ipWhitelist?: string[];
  signatureWindowMs?: number;
  trustProxy?: boolean;
}

function deny(res: Response, reason: string, ip: string, extra?: Record<string, unknown>): void {
  console.log(`[mcp-auth] 401 reason=${reason} ip=${ip}${extra?.key ? ` key=${extra.key}` : ""}`);
  res.setHeader("WWW-Authenticate", "Bearer");
  res.status(401).json({ error: reason, ...extra });
}

export function createApiKeyAuth(config: ApiKeyAuthConfig): RequestHandler {
  const windowMs = config.signatureWindowMs ?? 300_000;
  const nonces = new NonceStore(windowMs);

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? "";

    if (config.ipWhitelist && config.ipWhitelist.length > 0 && !ipMatchesWhitelist(ip, config.ipWhitelist)) {
      return deny(res, "ip not allowed", ip);
    }

    const signature = req.headers["x-signature"];
    if (typeof signature === "string" && signature.length > 0) {
      return verifyHmacRequest(req, res, next, config, nonces, windowMs, ip, signature);
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const key = authHeader.slice("Bearer ".length).trim();
      const entry = config.keyStore.lookup(key);
      if (!entry) return deny(res, "invalid key", ip);
      if (config.keyStore.isExpired(entry)) {
        console.warn(`[mcp-auth] WARNING: key ${key} expired`);
        return deny(res, "key expired", ip, { key });
      }
      return next();
    }

    return deny(res, "missing credentials", ip);
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
): void {
  const ts = req.headers["x-timestamp"];
  const nonce = req.headers["x-nonce"];
  if (typeof ts !== "string" || typeof nonce !== "string") {
    return deny(res, "invalid signature headers", ip);
  }
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return deny(res, "timestamp expired", ip);
  if (Math.abs(Date.now() - tsNum) > windowMs) return deny(res, "timestamp expired", ip);

  const path = (req.originalUrl ?? "/").split("?")[0];
  const rawBody = (req as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const method = req.method ?? "GET";

  for (const entry of config.keyStore.activeKeys()) {
    if (verifySignature(entry.key, method, path, ts, nonce, rawBody, signature)) {
      if (!nonces.checkAndSet(entry.key, nonce)) return deny(res, "replay detected", ip);
      return next();
    }
  }
  return deny(res, "signature mismatch", ip);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/__tests__/api-key-auth.test.ts`
Expected: 14 tests pass(纯函数 7 + 中间件 7)。

- [ ] **Step 5: Commit**

```bash
git add src/server/api-key-auth.ts src/server/__tests__/api-key-auth.test.ts
git commit -m "feat: add dual-mode API key auth middleware (Bearer + HMAC)"
```

---

### Task 6: 配置接入(AppConfig + .env.example)

**Files:**
- Modify: `src/config/index.ts`
- Modify: `.env.example`
- Create: `src/config/__tests__/config.test.ts`

**Interfaces:**
- Produces: `AppConfig` 新增字段:
  - `apiKeys: string`(原始 `API_KEYS`)
  - `apiKeyLegacy: string`(原始 `API_KEY`)
  - `apiIpWhitelist: string`(原始 `API_IP_WHITELIST`)
  - `apiSignatureWindowMs: number`(默认 300000)
  - `apiTrustProxy: boolean`(默认 false)

- [ ] **Step 1: 写失败测试**

创建 `src/config/__tests__/config.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../index.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("loadConfig API key fields", () => {
  it("parses API_KEYS / API_IP_WHITELIST / window / trust proxy", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.API_KEYS = "sk-a:2026-12-31T00:00:00Z,sk-b";
    process.env.API_IP_WHITELIST = "10.0.0.0/8,192.168.1.1";
    process.env.API_SIGNATURE_WINDOW_MS = "60000";
    process.env.API_TRUST_PROXY = "true";
    const cfg = loadConfig();
    expect(cfg.apiKeys).toBe("sk-a:2026-12-31T00:00:00Z,sk-b");
    expect(cfg.apiIpWhitelist).toBe("10.0.0.0/8,192.168.1.1");
    expect(cfg.apiSignatureWindowMs).toBe(60000);
    expect(cfg.apiTrustProxy).toBe(true);
  });

  it("defaults window to 300000 and trust proxy to false", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    const cfg = loadConfig();
    expect(cfg.apiSignatureWindowMs).toBe(300000);
    expect(cfg.apiTrustProxy).toBe(false);
    expect(cfg.apiKeys).toBe("");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/config/__tests__/config.test.ts`
Expected: FAIL(`apiKeys` 等字段不存在)。

- [ ] **Step 3: 修改 `src/config/index.ts`**

在 `AppConfig` 接口追加字段,并在 `loadConfig()` 的 return 对象里追加:

```ts
export interface AppConfig {
  openAIApiKey: string;
  modelName: string;
  maxIterations: number;
  baseURL: string;
  mcpServers: McpServerConfig[];
  databaseUrl: string;
  databasePoolMin: number;
  databasePoolMax: number;
  apiKeys: string;
  apiKeyLegacy: string;
  apiIpWhitelist: string;
  apiSignatureWindowMs: number;
  apiTrustProxy: boolean;
}
```

在 `loadConfig()` 函数体内(其他 `process.env` 读取附近)追加解析:

```ts
const apiSignatureWindowRaw = parseInt(process.env.API_SIGNATURE_WINDOW_MS ?? "300000", 10);
```

在 return 对象中追加:

```ts
apiKeys: process.env.API_KEYS ?? "",
apiKeyLegacy: process.env.API_KEY ?? "",
apiIpWhitelist: process.env.API_IP_WHITELIST ?? "",
apiSignatureWindowMs: Number.isNaN(apiSignatureWindowRaw) ? 300000 : apiSignatureWindowRaw,
apiTrustProxy: (process.env.API_TRUST_PROXY ?? "").toLowerCase() === "true",
```

- [ ] **Step 4: 更新 `.env.example`**

在文件末尾追加:

```
# 固定 API key + MCP 端点鉴权
# API_KEYS=sk-aaa:2026-12-31T00:00:00Z,sk-bbb
# API_KEY=sk-legacy
# API_IP_WHITELIST=127.0.0.1,10.0.0.0/8
# API_SIGNATURE_WINDOW_MS=300000
# API_TRUST_PROXY=false
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run src/config/__tests__/config.test.ts`
Expected: 2 tests pass。

- [ ] **Step 6: Commit**

```bash
git add src/config/index.ts src/config/__tests__/config.test.ts .env.example
git commit -m "feat: add API key config fields"
```

---

### Task 7: createMcpServer(4 个 MCP 工具)

**Files:**
- Create: `src/server/mcp.ts`
- Test: `src/server/__tests__/mcp.test.ts`

**Interfaces:**
- Consumes: `PgVectorStore` 的 `search` / `searchKeyword` / `listDocs` / `getCacheStats`
- Produces:
  - `type RagStoreLike = Pick<PgVectorStore, "search" | "searchKeyword" | "listDocs" | "getCacheStats">`
  - `createMcpServer(store: RagStoreLike): McpServer`

- [ ] **Step 1: 写失败测试**

创建 `src/server/__tests__/mcp.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type RagStoreLike } from "../mcp.js";

function fakeStore(): RagStoreLike {
  return {
    async search(query: string, k = 5) {
      return [{ content: `result for ${query}`, score: 0.9, source: "a.pdf", docId: "d1", chunkIndex: 0 }];
    },
    async searchKeyword(query: string, k = 5) {
      return [{ content: `kw ${query}`, score: 1, source: "a.pdf", docId: "d1" }];
    },
    async listDocs() {
      return [{ id: "d1", filename: "a.pdf", pages: 0, chunkCount: 3, indexedAt: new Date("2026-01-01") }];
    },
    getCacheStats() {
      return { total: 1 };
    },
  };
}

describe("createMcpServer tools", () => {
  let client: Client;

  async function connect() {
    client = new Client({ name: "test-client", version: "1.0.0" });
    const server = createMcpServer(fakeStore());
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
  }

  afterEach(async () => {
    if (client) await client.close();
  });

  it("lists 4 tools", async () => {
    await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      "search_documents",
      "search_keyword",
      "list_documents",
      "get_stats",
    ]);
  });

  it("calls search_documents with args", async () => {
    await connect();
    const res = await client.callTool({ name: "search_documents", arguments: { query: "hello", topK: 3 } });
    const text = res.content?.[0] as { type: "text"; text: string };
    expect(JSON.parse(text.text)[0].content).toBe("result for hello");
  });

  it("applies threshold filter in search_documents", async () => {
    await connect();
    const res = await client.callTool({ name: "search_documents", arguments: { query: "x", threshold: 0.95 } });
    const text = res.content?.[0] as { type: "text"; text: string };
    expect(JSON.parse(text.text)).toEqual([]); // fake score 0.9 < 0.95
  });

  it("calls search_keyword", async () => {
    await connect();
    const res = await client.callTool({ name: "search_keyword", arguments: { query: "doc", topK: 2 } });
    const text = res.content?.[0] as { type: "text"; text: string };
    expect(JSON.parse(text.text)[0].score).toBe(1);
  });

  it("calls list_documents and get_stats", async () => {
    await connect();
    const docs = await client.callTool({ name: "list_documents" });
    const docsText = docs.content?.[0] as { type: "text"; text: string };
    expect(JSON.parse(docsText.text)[0].filename).toBe("a.pdf");

    const stats = await client.callTool({ name: "get_stats" });
    const statsText = stats.content?.[0] as { type: "text"; text: string };
    expect(JSON.parse(statsText.text).total).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/__tests__/mcp.test.ts`
Expected: FAIL(`createMcpServer` 未定义)。

- [ ] **Step 3: 实现**

创建 `src/server/mcp.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PgVectorStore } from "../storage/pg-vector-store.js";

export type RagStoreLike = Pick<PgVectorStore, "search" | "searchKeyword" | "listDocs" | "getCacheStats">;

export function createMcpServer(store: RagStoreLike): McpServer {
  const mcp = new McpServer({ name: "navigate-rag", version: "0.1.0" });

  mcp.registerTool(
    "search_documents",
    {
      title: "Search documents",
      description:
        "Hybrid semantic + keyword search over the RAG knowledge base. Returns ranked chunks with scores.",
      inputSchema: {
        query: z.string().describe("Search query"),
        topK: z.number().int().min(1).max(50).optional().describe("Number of results (default 5)"),
        threshold: z.number().min(0).max(1).optional().describe("Minimum score threshold filter"),
      },
    },
    async ({ query, topK = 5, threshold }) => {
      let results = await store.search(query, topK);
      if (threshold !== undefined) results = results.filter((r) => r.score >= threshold);
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    },
  );

  mcp.registerTool(
    "search_keyword",
    {
      description: "Keyword substring search (full-text) over indexed document chunks.",
      inputSchema: {
        query: z.string().describe("Keyword query"),
        topK: z.number().int().min(1).max(50).optional().describe("Number of results (default 5)"),
      },
    },
    async ({ query, topK = 5 }) => {
      const results = await store.searchKeyword(query, topK);
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    },
  );

  mcp.registerTool(
    "list_documents",
    { description: "List all documents indexed in the knowledge base." },
    async () => {
      const docs = await store.listDocs();
      return { content: [{ type: "text", text: JSON.stringify(docs) }] };
    },
  );

  mcp.registerTool(
    "get_stats",
    { description: "Get RAG cache statistics." },
    async () => {
      const stats = store.getCacheStats();
      return { content: [{ type: "text", text: JSON.stringify(stats) }] };
    },
  );

  return mcp;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/__tests__/mcp.test.ts`
Expected: 5 tests pass。

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp.ts src/server/__tests__/mcp.test.ts
git commit -m "feat: add MCP server with 4 RAG tools"
```

---

### Task 8: Express 挂载(mountMcpRoutes + 接线)

**Files:**
- Create: `src/server/mcp-http.ts`
- Modify: `src/server/index.ts`(`express.json` verify + 挂载 + 可选参数)
- Modify: `src/server-entry.ts`(构造 `apiAuth` 并传入)
- Create: `src/server/__tests__/mcp-http.test.ts`

**Interfaces:**
- Consumes: `createMcpServer` + `RagStoreLike`(Task 7)、`createApiKeyAuth` + `ApiKeyAuthConfig`(Task 5)、`AppConfig` 新字段(Task 6)
- Produces: `mountMcpRoutes(app: Express, store: RagStoreLike, apiAuth: ApiKeyAuthConfig): void`
- 新增 express 依赖:所有 /mcp 请求体通过 `express.json({ verify })` 捕获到 `req.rawBody`。

- [ ] **Step 1: 写失败测试**

创建 `src/server/__tests__/mcp-http.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mountMcpRoutes } from "../mcp-http.js";
import { ApiKeyStore } from "../key-store.js";
import { computeSignature } from "../api-key-auth.js";

const AUTH = { keyStore: ApiKeyStore.fromEnv("sk-test:2099-01-01T00:00:00Z", undefined) };

const store = {
  async search(query: string, k = 5) {
    return [{ content: `r:${query}`, score: 0.9, source: "a.pdf", docId: "d1" }];
  },
  async searchKeyword(query: string, k = 5) {
    return [{ content: `kw:${query}`, score: 1, source: "a.pdf", docId: "d1" }];
  },
  async listDocs() {
    return [{ id: "d1", filename: "a.pdf", pages: 0, chunkCount: 1, indexedAt: new Date("2026-01-01") }];
  },
  getCacheStats() {
    return { total: 1 };
  },
} as any;

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

describe("MCP HTTP endpoint", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
    mountMcpRoutes(app, store, AUTH);
    server = app.listen(0);
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server.close());

  it("rejects an unauthenticated initialize with 401", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing credentials");
  });

  it("rejects an invalid bearer key", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-wrong" },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid key");
  });

  it("accepts a valid bearer key and lists tools via the SDK client", async () => {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer sk-test" } },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("search_documents");
    await client.close();
  });

  it("accepts a valid HMAC-signed initialize", async () => {
    const ts = String(Date.now());
    const nonce = `n-init-${ts}`;
    const body = JSON.stringify(INIT);
    const sig = computeSignature("sk-test", "POST", "/mcp", ts, nonce, Buffer.from(body));
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": sig, "X-Timestamp": ts, "X-Nonce": nonce },
      body,
    });
    expect([200, 201]).toContain(res.status);
  });

  it("rejects a replayed HMAC request", async () => {
    const ts = String(Date.now());
    const nonce = `n-replay-${ts}`;
    const body = JSON.stringify(INIT);
    const sig = computeSignature("sk-test", "POST", "/mcp", ts, nonce, Buffer.from(body));
    const headers = { "Content-Type": "application/json", "X-Signature": sig, "X-Timestamp": ts, "X-Nonce": nonce };
    const first = await fetch(`${base}/mcp`, { method: "POST", headers, body });
    const second = await fetch(`${base}/mcp`, { method: "POST", headers, body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect((await second.json()).error).toBe("replay detected");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/__tests__/mcp-http.test.ts`
Expected: FAIL(`mountMcpRoutes` 未定义)。

- [ ] **Step 3: 实现 `src/server/mcp-http.ts`**

> 重要:SDK 的 `Server`/`McpServer` 一次只能连接**一个** transport(并发连接第二个会抛 `Already connected to a transport`)。本设计采用**无状态单 transport**(`sessionIdGenerator: undefined` + `enableJsonResponse: true`),每个请求独立处理、无会话状态,满足 4 个只读查询工具的请求/响应场景,且可直接用 curl 验证。若将来需要并发会话,再改为"每会话一个 server"的模式。

创建 `src/server/mcp-http.ts`:

```ts
import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createApiKeyAuth, type ApiKeyAuthConfig } from "./api-key-auth.js";
import { createMcpServer, type RagStoreLike } from "./mcp.js";

export function mountMcpRoutes(app: Express, store: RagStoreLike, apiAuth: ApiKeyAuthConfig): void {
  if (apiAuth.trustProxy) app.set("trust proxy", true);

  const require = createApiKeyAuth(apiAuth);
  const mcp = createMcpServer(store);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // 无状态模式
    enableJsonResponse: true,      // 直接返回 JSON 而非 SSE,便于 curl 验证
  });
  void mcp.connect(transport);

  const handle = (req: Request, res: Response): void => {
    void transport.handleRequest(req, res, req.body).catch((err) => {
      console.error("[mcp] transport error:", (err as Error)?.message);
      if (!res.headersSent) res.status(500).json({ error: "mcp transport error" });
    });
  };

  app.post("/mcp", require, (req, res) => handle(req, res));
  app.get("/mcp", require, (req, res) => handle(req, res));
  app.delete("/mcp", require, (req, res) => handle(req, res));
}
```

- [ ] **Step 4: 修改 `src/server/index.ts`**

4a. 顶部 import 追加:

```ts
import { mountMcpRoutes } from "./mcp-http.js";
import type { ApiKeyAuthConfig } from "./api-key-auth.js";
```

4b. `app.use(express.json());`(第 107 行附近)替换为:

```ts
app.use(express.json({
  verify: (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  },
}));
```

4c. 函数签名 `createRagServer` 追加最后一个可选参数:

```ts
export function createRagServer(
  store: PgVectorStore,
  port: number = 3001,
  executor?: AgentExecutor,
  resumeStore?: ResumeStore,
  resumeData?: ResumeData,
  apiAuth?: ApiKeyAuthConfig,
) {
```

4d. 在 zyplayer 适配器初始化之后(约第 128 行,`// === Token management ===` 之前)插入:

```ts
// === 固定 API key + MCP 端点(可选,未配置则 /mcp 不启用) ===
if (apiAuth) {
  mountMcpRoutes(app, store, apiAuth);
}
```

- [ ] **Step 5: 修改 `src/server-entry.ts`**

5a. import 追加:

```ts
import { ApiKeyStore } from "./server/key-store.js";
import type { ApiKeyAuthConfig } from "./server/api-key-auth.js";
```

5b. 在 `const config = loadConfig();` 之后追加:

```ts
const apiAuth: ApiKeyAuthConfig | undefined =
  config.apiKeys || config.apiKeyLegacy
    ? {
        keyStore: ApiKeyStore.fromEnv(config.apiKeys, config.apiKeyLegacy),
        ipWhitelist: config.apiIpWhitelist
          ? config.apiIpWhitelist.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        signatureWindowMs: config.apiSignatureWindowMs,
        trustProxy: config.apiTrustProxy,
      }
    : undefined;
```

5c. 调用改为:

```ts
createRagServer(ragStore, 3001, executor, resumeStore, resumeData, apiAuth);
```

- [ ] **Step 6: 运行集成测试**

Run: `npx vitest run src/server/__tests__/mcp-http.test.ts`
Expected: 5 tests pass。

- [ ] **Step 7: tsc 编译检查**

Run: `npm run build`
Expected: exit 0,无类型错误。

- [ ] **Step 8: Commit**

```bash
git add src/server/mcp-http.ts src/server/__tests__/mcp-http.test.ts src/server/index.ts src/server-entry.ts
git commit -m "feat: mount MCP endpoint on Express with API key auth"
```

---

### Task 9: 签名生成脚本 + 端到端验证

**Files:**
- Create: `scripts/gen-signature.ts`

**Interfaces:**
- Produces: CLI 打印 `X-Timestamp` / `X-Nonce` / `X-Signature` 三个头,供 curl 手动验证 HMAC 请求。

- [ ] **Step 1: 实现脚本**

创建 `scripts/gen-signature.ts`:

```ts
#!/usr/bin/env node
import { createHmac, createHash } from "node:crypto";

/**
 * 为一次请求生成 HMAC 签名头,便于 curl 手动验证。
 * 用法:
 *   tsx scripts/gen-signature.ts --key sk-xxx --method POST --path /mcp \
 *     --body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
 * 输出 X-Timestamp / X-Nonce / X-Signature 三行,直接拼到 curl 请求头。
 */
const args = process.argv.slice(2);
function get(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const key = get("key");
if (!key) {
  console.error("Missing --key");
  process.exit(1);
}
const method = get("method") ?? "POST";
const path = get("path") ?? "/mcp";
const body = get("body") ?? "";
const bodyHash = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
const timestamp = String(Date.now());
const nonce = `n-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const canonical = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
const signature = createHmac("sha256", key).update(canonical).digest("hex");

console.log(`X-Timestamp: ${timestamp}`);
console.log(`X-Nonce: ${nonce}`);
console.log(`X-Signature: ${signature}`);
```

- [ ] **Step 2: 单元验证脚本输出格式**

Run: `npx tsx scripts/gen-signature.ts --key sk-test --method POST --path /mcp --body '{}'`
Expected: 打印三行,每行 `头名: 值` 且值非空。

- [ ] **Step 3: 端到端验证(起真实服务)**

在 `.env` 配置一把测试 key 后启动服务:

```bash
# 临时把下面几行加进 .env(或直接 export):
# export API_KEYS=sk-test:2099-01-01T00:00:00Z
npm run server
```

另一个终端,先验证 Bearer:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://localhost:3001/mcp \
  -H "Authorization: Bearer sk-test" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
# 期望: 200
```

再验证 HMAC 签名:

```bash
BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
npx tsx scripts/gen-signature.ts --key sk-test --method POST --path /mcp --body "$BODY"
# 复制输出的三个 X-* 头,拼到 curl 里再发一次 → 期望 200
# 原样重发同一请求 → 期望 401 {"error":"replay detected"}
```

- [ ] **Step 4: 全量测试 + 提交**

Run: `npm test` 和 `npm run build`
Expected: 全部测试通过,tsc 无错误。

```bash
git add scripts/gen-signature.ts
git commit -m "feat: add HMAC signature generation script"
```

---

## Self-Review 记录

- **Spec 覆盖**:多 key 注册表(Task 2)、per-key 过期(Task 2/5)、HMAC 签名(Task 4/5)、防重放(Task 3/5)、IP 白名单 IP+CIDR(Task 4/5)、trust proxy(Task 8)、rawBody verify(Task 8)、4 个 MCP 工具(Task 7)、`/mcp` Streamable HTTP(Task 8)、`gen-signature` 脚本(Task 9)、`.env.example`(Task 6)、错误码与日志(散落各 Task)。全部覆盖。
- **签名一致性**:`computeSignature` 的 canonical 串、`verifyHmacRequest` 的 `path = originalUrl.split("?")[0]`、`rawBody` 来源(express.json verify)、HMAC 失败统一 `signature mismatch`——与 spec 一致。
- **类型一致性**:`ApiKeyStore.fromEnv(apiKeysRaw, legacyRaw)`、`NonceStore.checkAndSet(key, nonce)`、`createApiKeyAuth(config)`、`mountMcpRoutes(app, store, apiAuth)`、`RagStoreLike`——各 Task 间的名字与签名完全一致。
- **已知取舍**:
  - HMAC 重放测试在 HTTP 层用 `initialize` 作为请求体(确定性,因为鉴权先于 transport 执行);中间件层的重放测试在 Task 5 已覆盖。
  - **transport 单实例约束(已实证)**:SDK `Server` 一次只能 connect 一个 transport,并发连接第二个会抛 `Already connected to a transport`。因此 `mountMcpRoutes` 用无状态单 transport + `enableJsonResponse`(见 Task 8 Step 3 注释),不用 session-map。若未来要并发多客户端会话,再改"每会话一个 server"。
