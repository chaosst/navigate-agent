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
