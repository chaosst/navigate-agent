import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentPoller } from "../poller.js";
import type { SyncAdapter } from "../types.js";

/**
 * 现场证据（2026-09-13 生产）：
 *   - app / mysql 容器是 UTC：`SELECT NOW()` → 15:39，而 zyplayer-doc 容器带 TZ=Asia/Shanghai，
 *     写进 wiki_page.update_time 的是北京时间 23:21 → **同一个库里两条时间轴差 8 小时**。
 *   - 旧 poller 把 `new Date().toISOString()`（本机 UTC 墙钟）当水位，等于拿「落后 8 小时」的
 *     刻度去卡「库里超前 8 小时」的数据；且空轮也照样推进水位。
 *
 * 新语义（本测试锁定）：
 *   ① 有变更 → 水位推进到本轮看到的 **最大 update_time**（数据库自己的时钟域），而不是墙钟；
 *   ② 无变更 → 水位不动，窗口保持打开（下一次仍用同一个 since 查，不会漏）；
 *   ③ 回收站页面 → 走 deletePageFromRag，不写 RAG。
 */

interface StubPage {
  pageId: number;
  updatedAt: string;
  deleted?: boolean;
}

function makeAdapter(rounds: StubPage[][]): {
  adapter: SyncAdapter;
  sinceCalls: string[];
  synced: number[];
  deleted: number[];
} {
  const sinceCalls: string[] = [];
  const synced: number[] = [];
  const deleted: number[] = [];
  let round = 0;

  const adapter: SyncAdapter = {
    async listChangedPages(since: string): Promise<StubPage[]> {
      sinceCalls.push(since);
      const pages = rounds[Math.min(round, rounds.length - 1)] ?? [];
      round++;
      return pages;
    },
    async syncPageToRag(pageId: number): Promise<string> {
      synced.push(pageId);
      return `title-${pageId}`;
    },
    async deletePageFromRag(pageId: number): Promise<void> {
      deleted.push(pageId);
    },
  };
  return { adapter, sinceCalls, synced, deleted };
}

describe("ContentPoller 水位语义", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "poller-state-"));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  /** 预置一个「数据库时钟域」的水位文件，模拟 app 重启后读盘 */
  function seedState(lastSyncTime: string): void {
    writeFileSync(join(dir, "content-sync-state.json"), JSON.stringify({ lastSyncTime }), "utf-8");
  }

  function readState(): { lastSyncTime: string } {
    return JSON.parse(readFileSync(join(dir, "content-sync-state.json"), "utf-8")) as {
      lastSyncTime: string;
    };
  }

  it("★ 回归锁：空轮不得把墙钟写进水位（旧实现会把 8 小时时差塞进游标，导致漏同步）", async () => {
    seedState("2026-09-13 15:00:00");
    const { adapter, sinceCalls, synced } = makeAdapter([
      [],
      [{ pageId: 25, updatedAt: "2026-09-13 23:21:51" }],
    ]);
    const poller = new ContentPoller(adapter, 300_000, dir);

    await poller.tick(); // 无变更
    expect(sinceCalls[0]).toBe("2026-09-13 15:00:00");
    expect(readState().lastSyncTime).toBe("2026-09-13 15:00:00"); // 水位不动

    await poller.tick(); // 同一个窗口再查一次 → 必须能捞到这一页
    expect(sinceCalls[1]).toBe("2026-09-13 15:00:00");
    expect(synced).toEqual([25]);
  });

  it("★ 回归锁：有变更时水位=本轮最大 update_time（数据库时钟域），不是本机 now()", async () => {
    seedState("2026-09-13 15:00:00");
    const { adapter, sinceCalls } = makeAdapter([
      [
        { pageId: 24, updatedAt: "2026-09-13 23:21:04" },
        { pageId: 25, updatedAt: "2026-09-13 23:21:51" },
      ],
      [],
    ]);
    const poller = new ContentPoller(adapter, 300_000, dir);

    await poller.tick();
    expect(readState().lastSyncTime).toBe("2026-09-13 23:21:51");

    await poller.tick();
    expect(sinceCalls[1]).toBe("2026-09-13 23:21:51");
  });

  it("回收站页面 → 清 RAG 索引，不写 RAG", async () => {
    seedState("2026-09-13 15:00:00");
    const { adapter, synced, deleted } = makeAdapter([
      [
        { pageId: 6, updatedAt: "2026-09-13 23:20:18", deleted: true },
        { pageId: 25, updatedAt: "2026-09-13 23:21:51", deleted: false },
      ],
    ]);
    const poller = new ContentPoller(adapter, 300_000, dir);

    await poller.tick();

    expect(deleted).toEqual([6]);
    expect(synced).toEqual([25]);
    expect(readState().lastSyncTime).toBe("2026-09-13 23:21:51");
  });

  it("拉取失败（抛错）时不推进水位，下一轮继续用原窗口重试", async () => {
    seedState("2026-09-13 15:00:00");
    let calls = 0;
    const sinceCalls: string[] = [];
    const adapter: SyncAdapter = {
      async listChangedPages(since: string): Promise<StubPage[]> {
        sinceCalls.push(since);
        calls++;
        if (calls === 1) throw new Error("connect ETIMEDOUT");
        return [];
      },
      async syncPageToRag(): Promise<string> {
        return "t";
      },
      async deletePageFromRag(): Promise<void> {},
    };
    const poller = new ContentPoller(adapter, 300_000, dir);

    await poller.tick();
    await poller.tick();

    expect(sinceCalls).toEqual(["2026-09-13 15:00:00", "2026-09-13 15:00:00"]);
    expect(readState().lastSyncTime).toBe("2026-09-13 15:00:00");
  });
});
