/**
 * HotCache — L1 LRU 热数据缓存
 *
 * 有上限的内存缓存，按 cache-aside 模式工作：
 *   读：先查缓存 → 命中返回 → 未命中查 PostgreSQL → 回填缓存
 *   写：直接写 PostgreSQL → 使对应缓存失效
 *
 * 淘汰策略：LRU，超出上限时淘汰最久未访问的条目
 * TTL：默认 30 分钟，过期自动失效
 */

export interface CacheConfig {
  maxChunks: number;    // 默认 5000
  maxSessions: number;  // 默认 50
  ttlMs: number;        // 默认 30 分钟
}

interface CacheEntry<T> {
  value: T;
  lastAccess: number;
}

export class HotCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private config: CacheConfig;

  constructor(config?: Partial<CacheConfig>) {
    this.config = {
      maxChunks: 5000,
      maxSessions: 50,
      ttlMs: 30 * 60 * 1000,
      ...config,
    };
  }

  // ── 文档元数据缓存 ──

  getDocMeta(id: string): unknown | null {
    return this.get(`doc:${id}`);
  }

  setDocMeta(id: string, value: unknown): void {
    this.set(`doc:${id}`, value, this.config.maxChunks);
  }

  invalidateDoc(docId: string): void {
    this.store.delete(`doc:${docId}`);
    // 清理所有以 docId 为前缀的 chunk 缓存
    const prefix = `chunk:${docId}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  // ── 会话缓存 ──

  getSession(id: string): unknown | null {
    return this.get(`session:${id}`);
  }

  setSession(id: string, value: unknown): void {
    this.set(`session:${id}`, value, this.config.maxSessions);
  }

  invalidateSession(id: string): void {
    this.store.delete(`session:${id}`);
  }

  // ── 统计 ──

  get stats() {
    return { entries: this.store.size };
  }

  clear(): void {
    this.store.clear();
  }

  // ── 内部方法 ──

  private get(key: string): unknown | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.lastAccess > this.config.ttlMs) {
      this.store.delete(key);
      return null;
    }
    entry.lastAccess = Date.now();
    return entry.value;
  }

  private set(key: string, value: unknown, max: number): void {
    const entry: CacheEntry<unknown> = { value, lastAccess: Date.now() };

    if (this.store.size >= max) {
      // LRU 淘汰
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.store) {
        if (v.lastAccess < oldestTime) {
          oldestTime = v.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, entry);
  }
}
