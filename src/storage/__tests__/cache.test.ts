import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HotCache } from "../cache.js";

describe("HotCache", () => {
  let cache: HotCache;

  beforeEach(() => {
    cache = new HotCache({ maxEntries: 2 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns value on hit and null on miss", () => {
    cache.set("a", 1);
    expect(cache.get<number>("a")).toBe(1);
    expect(cache.get("missing")).toBeNull();
  });

  it("evicts the least-recently-used key when over capacity (move-to-end)", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // touch a → b becomes the LRU key
    cache.set("c", 3); // over maxEntries=2 → evict b
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe(3);
  });

  it("treats expired entries as a miss and removes them", () => {
    vi.useFakeTimers();
    const ttl = new HotCache({ maxEntries: 2, ttlMs: 1000 });
    ttl.set("k", "v");
    vi.advanceTimersByTime(1001);
    expect(ttl.get("k")).toBeNull();
    expect(ttl.size).toBe(0);
  });

  it("refreshes TTL on get", () => {
    vi.useFakeTimers();
    const ttl = new HotCache({ maxEntries: 2, ttlMs: 1000 });
    ttl.set("k", "v");
    vi.advanceTimersByTime(900);
    expect(ttl.get("k")).toBe("v"); // refresh
    vi.advanceTimersByTime(900); // 900+900=1800 > 1000，若未 refresh 应过期
    expect(ttl.get("k")).toBe("v");
  });

  it("remove and clear behave", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.remove("a");
    expect(cache.get("a")).toBeNull();
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
