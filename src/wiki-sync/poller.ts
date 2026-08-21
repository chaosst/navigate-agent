import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SyncAdapter } from "./types.js";

/**
 * ContentPoller: 定时轮询外部知识库（zyplayer-doc / Wiki.js 等）的页面变更，
 * 自动同步到 RAG 向量存储。
 *
 * 通过 SyncAdapter 接口替换了旧版对 Wiki.js GraphQL 的直接依赖。
 */
export class ContentPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastSyncTime: string | null = null;
  private statePath: string;

  constructor(
    private adapter: SyncAdapter,
    private intervalMs: number = 5 * 60 * 1000, // 默认 5 分钟
    private persistDir: string = "rag_data",
  ) {
    this.statePath = join(this.persistDir, "content-sync-state.json");
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
          console.log(`[content-poller] Last sync time: ${this.lastSyncTime}`);
        }
      }
    } catch (err) {
      console.warn("[content-poller] Could not load sync state:", (err as Error).message);
    }
  }

  /** 将当前同步时间持久化到磁盘 */
  private saveState(): void {
    try {
      mkdirSync(this.persistDir, { recursive: true });
      writeFileSync(this.statePath, JSON.stringify({ lastSyncTime: this.lastSyncTime }), "utf-8");
    } catch (err) {
      console.warn("[content-poller] Could not save sync state:", (err as Error).message);
    }
  }

  /** 启动轮询（立即执行一次，然后按 interval 定时执行） */
  start(): void {
    if (this.intervalId) {
      console.log("[content-poller] Already running");
      return;
    }

    console.log(`[content-poller] Starting (interval: ${this.intervalMs}ms)`);
    // 立即执行一次
    this.tick().catch((err) =>
      console.error("[content-poller] Initial tick failed:", (err as Error).message)
    );
    // 定时执行
    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        console.error("[content-poller] Tick failed:", (err as Error).message)
      );
    }, this.intervalMs);
  }

  /** 停止轮询 */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[content-poller] Stopped");
    }
  }

  /** 执行一次检查：通过适配器获取变更页面并同步到 RAG */
  async tick(): Promise<void> {
    // 如果没有上次同步时间，只记录当前时间为初始同步点
    if (!this.lastSyncTime) {
      this.lastSyncTime = new Date().toISOString();
      this.saveState();
      console.log(`[content-poller] Initial state recorded at ${this.lastSyncTime}`);
      return;
    }

    let changedPages: { pageId: number; updatedAt: string }[];
    try {
      changedPages = await this.adapter.listChangedPages(this.lastSyncTime);
    } catch (err) {
      console.warn("[content-poller] Failed to fetch changed pages:", (err as Error).message);
      return; // 获取列表失败，跳过本轮
    }

    if (changedPages.length === 0) {
      // 没有变更，只更新时间戳
      this.lastSyncTime = new Date().toISOString();
      this.saveState();
      return;
    }

    console.log(`[content-poller] Found ${changedPages.length} changed page(s) since ${this.lastSyncTime}`);

    for (const page of changedPages) {
      try {
        const title = await this.adapter.syncPageToRag(page.pageId);
        console.log(`[content-poller] Synced "${title}" (page ${page.pageId})`);
      } catch (err) {
        console.error(`[content-poller] Failed to sync page ${page.pageId}:`, (err as Error).message);
        // 继续同步下一页，不中断
      }
    }

    this.lastSyncTime = new Date().toISOString();
    this.saveState();
    console.log(`[content-poller] Sync cycle complete at ${this.lastSyncTime}`);
  }
}
