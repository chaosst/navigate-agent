import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WikiSyncService, WikiPageItem } from "./service.js";

/**
 * WikiPoller: 定时轮询 Wiki.js 的页面变更，自动同步到 RAG。
 *
 * 因为 Wiki.js v2 没有内置 Webhook，所以通过此 Poller 定期检查
 * pages.list 的 updatedAt 字段，发现新/变更页面后自动同步。
 */
export class WikiPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastSyncTime: string | null = null;
  private statePath: string;

  constructor(
    private wikiSync: WikiSyncService,
    private intervalMs: number = 5 * 60 * 1000, // 默认 5 分钟
    private persistDir: string = "rag_data",
  ) {
    this.statePath = join(this.persistDir, "wiki-sync-state.json");
    this.loadState();
  }

  /** 从磁盘加载上次同步时间 */
  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        const raw = readFileSync(this.statePath, "utf-8");
        const data = JSON.parse(raw) as { lastSyncTime: string };
        if (data.lastSyncTime) {
          this.lastSyncTime = data.lastSyncTime;
          console.log(`[wiki-poller] Last sync time: ${this.lastSyncTime}`);
        }
      }
    } catch (err) {
      console.warn("[wiki-poller] Could not load sync state:", (err as Error).message);
    }
  }

  /** 将当前同步时间持久化到磁盘 */
  private saveState(): void {
    try {
      mkdirSync(this.persistDir, { recursive: true });
      writeFileSync(this.statePath, JSON.stringify({ lastSyncTime: this.lastSyncTime }), "utf-8");
    } catch (err) {
      console.warn("[wiki-poller] Could not save sync state:", (err as Error).message);
    }
  }

  /** 启动轮询（立即执行一次，然后按 interval 定时执行） */
  start(): void {
    if (this.intervalId) {
      console.log("[wiki-poller] Already running");
      return;
    }

    console.log(`[wiki-poller] Starting (interval: ${this.intervalMs}ms)`);
    // 立即执行一次
    this.tick().catch((err) =>
      console.error("[wiki-poller] Initial tick failed:", (err as Error).message)
    );
    // 定时执行
    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        console.error("[wiki-poller] Tick failed:", (err as Error).message)
      );
    }, this.intervalMs);
  }

  /** 停止轮询 */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[wiki-poller] Stopped");
    }
  }

  /** 执行一次检查：拉取页面列表，对比更新时间，同步变更页面 */
  async tick(): Promise<void> {
    let pages: WikiPageItem[];
    try {
      pages = await this.wikiSync.listPages();
    } catch (err) {
      console.warn("[wiki-poller] Failed to fetch page list:", (err as Error).message);
      return; // 获取列表失败，跳过本轮
    }

    if (pages.length === 0) {
      console.log("[wiki-poller] No pages found in Wiki.js");
      return;
    }

    // 如果没有上次同步时间，只记录当前时间为初始同步点，不同步已有内容
    if (!this.lastSyncTime) {
      this.lastSyncTime = new Date().toISOString();
      this.saveState();
      console.log(`[wiki-poller] Initial state recorded at ${this.lastSyncTime}. ${pages.length} pages available.`);
      return;
    }

    // 找出 updatedAt > lastSyncTime 的页面
    const changedPages = pages.filter((p) => p.updatedAt > this.lastSyncTime!);

    if (changedPages.length === 0) {
      // 没有变更，只更新时间戳
      this.lastSyncTime = new Date().toISOString();
      this.saveState();
      return;
    }

    console.log(`[wiki-poller] Found ${changedPages.length} changed page(s) since ${this.lastSyncTime}`);

    for (const page of changedPages) {
      try {
        const title = await this.wikiSync.syncPageToRag(page.id, page.path);
        console.log(`[wiki-poller] Synced "${title || page.title}" (page ${page.id})`);
      } catch (err) {
        console.error(`[wiki-poller] Failed to sync page ${page.id} (${page.path}):`, (err as Error).message);
        // 继续同步下一页，不中断
      }
    }

    this.lastSyncTime = new Date().toISOString();
    this.saveState();
    console.log(`[wiki-poller] Sync cycle complete at ${this.lastSyncTime}`);
  }
}
