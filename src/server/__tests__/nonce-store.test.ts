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
