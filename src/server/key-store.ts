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
