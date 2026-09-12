import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WikiStore } from "../store.js";
import type { PgVectorStore } from "../../storage/pg-vector-store.js";

interface Captured {
  docId: string;
  chunks: { content: string; metadata: Record<string, unknown> }[];
}

/** 假 ragStore：只记录 addChunks 的入参，不碰 PG */
function fakeRag(): { store: PgVectorStore; calls: Captured[] } {
  const calls: Captured[] = [];
  const store = {
    async deleteDoc(): Promise<void> {},
    async addChunks(chunks: { content: string; metadata: Record<string, unknown> }[], docId: string): Promise<void> {
      calls.push({ docId, chunks });
    },
  };
  return { store: store as unknown as PgVectorStore, calls };
}

/** createArticle 里的 syncToRag 是 fire-and-forget，等一个宏任务让它跑完 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

async function makeStore(): Promise<{ wiki: WikiStore; calls: Captured[] }> {
  const { store, calls } = fakeRag();
  const dir = mkdtempSync(path.join(tmpdir(), "wiki-sync-"));
  const wiki = await WikiStore.create(path.join(dir, "wiki.db"), store);
  return { wiki, calls };
}

describe("wiki 同步切块与 loader 共用同一策略", () => {
  it("有标题的文章 → strategy=md-heading，headingPath 非空，source 仍为 wiki/<slug>", async () => {
    const { wiki, calls } = await makeStore();
    const article = await wiki.createArticle({
      title: "切块策略",
      contentMd: "## 第一节\n正文内容。\n\n## 第二节\n更多内容。",
    });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].docId).toBe(`wiki:${article.id}`);

    const chunks = calls[0].chunks;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.metadata.strategy === "md-heading")).toBe(true);
    expect(chunks.some((c) => (c.metadata.headingPath as string[])?.length > 0)).toBe(true);

    // source / filename 取值保持不变（下游引用展示依赖它）
    expect(chunks[0].metadata.source).toBe(`wiki/${article.slug}`);
    expect(chunks[0].metadata.filename).toBe(`${article.slug}.md`);
  });

  it("正文自身没有标题时，`# 文章标题` 前缀仍让它走结构化切块", async () => {
    const { wiki, calls } = await makeStore();
    const article = await wiki.createArticle({
      title: "无小节文章",
      contentMd: "一段平铺直叙的正文，没有任何 markdown 标题。",
    });
    await flush();

    const chunks = calls[0].chunks;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].metadata.strategy).toBe("md-heading");
    expect(chunks[0].metadata.headingPath).toEqual([article.title]);
    expect(chunks[0].content.startsWith(article.title)).toBe(true);
  });
});
