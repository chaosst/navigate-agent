/**
 * HotCache — 通用有界 LRU + TTL 内存缓存（cache-aside 的 L1）。
 *
 * 读：先查缓存 → 命中返回 → 未命中由调用方查 L2(PostgreSQL) → set 回填。
 * 淘汰：LRU，O(1) —— Map 迭代序即「最近访问序」，每次 get 命中 / set 都把
 *       key 先 delete 再 set 移到尾部；超限时删除头部（最久未用）。
 * TTL：惰性失效，过期条目在下次 get 时判 miss 并删除。
 *
 * 本类不感知 key 的命名空间（如 `session:${id}`、`hybrid:${k}:${q}` 由调用方拼接）。
 * maxEntries / ttlMs 为每实例统一配置；如需不同容量，构造不同实例。
 */

export interface CacheConfig {
  /** 最大条目数，超出按 LRU 淘汰最久未用的 key */
  maxEntries: number;
  /** 单条目存活时间（毫秒），过期后下一次 get 视为 miss */
  ttlMs: number;
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
      maxEntries: 5000,
      ttlMs: 30 * 60 * 1000,
      ...config,
    };
  }

  get<T = unknown>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.lastAccess > this.config.ttlMs) {
      this.store.delete(key);
      return null;
    }
    entry.lastAccess = Date.now();
    // move-to-end：让 Map 迭代序 = 最近访问序，头部恒为最久未用（O(1) 淘汰前提）
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set(key: string, value: unknown): void {
    if (this.store.has(key)) {
      this.store.delete(key); // 已存在则先移除，保证插入后位于尾部（最新）
    } else if (this.store.size >= this.config.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, lastAccess: Date.now() });
  }

  remove(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
