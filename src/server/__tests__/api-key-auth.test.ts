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

  it("ignores malformed CIDR rules instead of throwing", () => {
    expect(() => ipMatchesWhitelist("2001:db8::1", ["2001:db8::/24x"])).not.toThrow();
    expect(ipMatchesWhitelist("2001:db8::1", ["2001:db8::/24x"])).toBe(false);
    expect(ipMatchesWhitelist("2001:db8::1", ["2001:db8::/-1"])).toBe(false);
  });
});

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

  it("returns 429 after too many failed attempts from the same IP", () => {
    const mw = createApiKeyAuth(cfg({ failureLimit: 5, failureWindowMs: 60_000 }));
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      mw(makeReq({ headers: { authorization: "Bearer sk-wrong" } }), res, vi.fn());
      expect(res.statusCode).toBe(401);
    }
    // 第 6 次:已达阈值,即使 key 正确也返回 429
    const res = makeRes();
    mw(makeReq({ headers: { authorization: "Bearer sk-secret" } }), res, vi.fn());
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe("too many requests");
  });

  it("clears the failure count on a successful auth", () => {
    const mw = createApiKeyAuth(cfg({ failureLimit: 3, failureWindowMs: 60_000 }));
    mw(makeReq({ headers: { authorization: "Bearer sk-wrong" } }), makeRes(), vi.fn());
    mw(makeReq({ headers: { authorization: "Bearer sk-wrong" } }), makeRes(), vi.fn());
    const ok = vi.fn();
    mw(makeReq({ headers: { authorization: "Bearer sk-secret" } }), makeRes(), ok); // 未达阈值,成功并清零
    expect(ok).toHaveBeenCalled();
    const res = makeRes();
    mw(makeReq({ headers: { authorization: "Bearer sk-wrong" } }), res, vi.fn()); // 已清零,不触发 429
    expect(res.statusCode).toBe(401);
  });

  it("rate-limits per IP independently", () => {
    const mw = createApiKeyAuth(cfg({ failureLimit: 2, failureWindowMs: 60_000 }));
    const ipA = { socket: { remoteAddress: "192.168.1.1" }, headers: { authorization: "Bearer sk-wrong" } };
    const ipB = { socket: { remoteAddress: "10.0.0.1" }, headers: { authorization: "Bearer sk-wrong" } };
    const r1 = makeRes(); mw(makeReq(ipA), r1, vi.fn()); expect(r1.statusCode).toBe(401);
    const r2 = makeRes(); mw(makeReq(ipA), r2, vi.fn()); expect(r2.statusCode).toBe(401);
    const r3 = makeRes(); mw(makeReq(ipB), r3, vi.fn()); expect(r3.statusCode).toBe(401); // 不同 IP 独立计数
    const r4 = makeRes(); mw(makeReq(ipA), r4, vi.fn()); expect(r4.statusCode).toBe(429); // A 已达阈值
  });
});
