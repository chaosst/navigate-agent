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
