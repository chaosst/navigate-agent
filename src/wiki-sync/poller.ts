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
    const since = this.lastSyncTime;

    // 如果没有上次同步时间，只记录当前时间为初始同步点
    if (!since) {
      this.lastSyncTime = new Date().toISOString();
      this.saveState();
      console.log(`[content-poller] Initial state recorded at ${this.lastSyncTime}`);
      return;
    }

    let changedPages: { pageId: number; updatedAt: string; deleted?: boolean }[];
    try {
      changedPages = await this.adapter.listChangedPages(since);
    } catch (err) {
      console.warn("[content-poller] Failed to fetch changed pages:", (err as Error).message);
      return; // 获取列表失败：水位不动，下一轮仍从同一时刻重查
    }

    if (changedPages.length === 0) {
      // 没有变更 —— 水位保持不动，不要写 new Date()。
      //
      // 水位必须一直待在「数据库自己的时钟域」里：zyplayer-doc 容器 TZ=Asia/Shanghai
      // （它写 wiki_page.update_time 用的是北京时间），而 app / mysql 容器跑在 UTC，
      // 同一个库里两条时间轴差 8 小时。拿本机墙钟当游标，要么反复重同步，要么成段漏同步。
      // 窗口保持打开是安全的：下一轮还是用同一个 since 再查一遍，只是白查一次 SQL。
      return;
    }

    console.log(`[content-poller] Found ${changedPages.length} changed page(s) since ${since}`);

    for (const page of changedPages) {
      try {
        if (page.deleted) {
          // 页面进了回收站 → 清掉 RAG 里的旧索引，避免回答里还能翻出已删除的文档
          await this.adapter.deletePageFromRag(page.pageId);
          console.log(`[content-poller] Removed page ${page.pageId} from RAG (in trash)`);
          continue;
        }
        const title = await this.adapter.syncPageToRag(page.pageId);
        console.log(`[content-poller] Synced "${title}" (page ${page.pageId})`);
      } catch (err) {
        console.error(`[content-poller] Failed to sync page ${page.pageId}:`, (err as Error).message);
        // 继续同步下一页，不中断
      }
    }

    // 水位推进到「本轮看到的最后一个变更时间」—— 取数据里的刻度，而不是本机墙钟。
    // listChangedPages 按 update_time 升序返回，最后一条即最大值。
    let next = since;
    for (const page of changedPages) {
      if (page.updatedAt > next) next = page.updatedAt;
    }
    this.lastSyncTime = next;
    this.saveState();
    console.log(`[content-poller] Sync cycle complete, watermark -> ${this.lastSyncTime}`);
  }
}
