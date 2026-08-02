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
