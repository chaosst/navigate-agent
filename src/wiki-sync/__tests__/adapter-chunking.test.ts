import { describe, it, expect } from "vitest";
import { ZyplayerDocAdapter } from "../zyplayer-doc-adapter.js";
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

/**
 * 造一个不连 MySQL 的适配器：构造函数的 createPool 是懒连接，
 * 再把 fetchPageContent 换成桩，即可只测「取到内容之后怎么切块」。
 */
function makeAdapter(page: { title: string; content: string }): { adapter: ZyplayerDocAdapter; calls: Captured[] } {
  const { store, calls } = fakeRag();
  const adapter = new ZyplayerDocAdapter(
    { host: "localhost", port: 3307, user: "stub", password: "stub", database: "stub" },
    store,
  );
  (adapter as unknown as { fetchPageContent: () => Promise<{ title: string; content: string }> }).fetchPageContent =
    async () => page;
  return { adapter, calls };
}

describe("zyplayer wiki 同步：切块与 loader 共用同一策略", () => {
  it("有标题的页面 → strategy=md-heading，headingPath 非空，source 仍为 zyplayer/<slug>", async () => {
    const { adapter, calls } = makeAdapter({
      title: "Cut Strategy",
      content: "# Cut Strategy\n\n## Section One\nbody one.\n\n## Section Two\nbody two.",
    });

    await adapter.syncPageToRag(42);
    await adapter.close();

    expect(calls).toHaveLength(1);
    const chunks = calls[0].chunks;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.metadata.strategy === "md-heading")).toBe(true);
    expect(chunks.some((c) => (c.metadata.headingPath as string[])?.length > 0)).toBe(true);

    // source / filename 取值保持不变（下游引用展示依赖它）
    expect(chunks[0].metadata.source).toBe("zyplayer/cut-strategy");
    expect(chunks[0].metadata.filename).toBe("cut-strategy.md");
  });

  it("★ 回归锁：超预算的代码块整体落在一个 chunk 内（旧的字符切块必拦腰切断）", async () => {
    // 关键：代码块必须 **大于 chunkSize(1000)**。
    // 否则旧实现也会因为「整块正好塞得下」而侥幸不切，回归锁就形同虚设
    // （第一版就是这么写的，换回旧代码跑仍然全绿 —— 已实测证伪）。
    const longBody = Array.from({ length: 40 }, (_, i) => `第 ${i} 行正文，用于把节撑到远超 chunkSize。`).join("\n");
    const codeLines = Array.from({ length: 80 }, (_, i) => `const valueNumber${i} = compute(${i});`);
    const codeBlock = ["```ts", ...codeLines, "```"].join("\n");
    expect(codeBlock.length).toBeGreaterThan(1000); // 前提自检

    const { adapter, calls } = makeAdapter({
      title: "Fence",
      content: `# Fence\n\n## 代码节\n\n${longBody}\n\n${codeBlock}\n\n尾注。`,
    });

    await adapter.syncPageToRag(7);
    await adapter.close();

    const chunks = calls[0].chunks;
    // ① 每个 chunk 内的 ``` 计数必须是偶数（奇数即落单围栏）
    for (const c of chunks) {
      const fences = (c.content.match(/```/g) || []).length;
      expect(fences % 2, `chunk 出现落单围栏:\n${c.content.slice(0, 200)}`).toBe(0);
    }
    // ② 更强的断言：存在某个 chunk 完整包含首行围栏、中间某行、以及收尾围栏
    const holdsWholeFence = chunks.some(
      (c) => c.content.includes("```ts") && c.content.includes("const valueNumber40 =") && c.content.includes("\n```"),
    );
    expect(holdsWholeFence).toBe(true);
  });

  it("同一页面重复同步 → docId 恒定（幂等），且每次都先删旧索引", async () => {
    const deletes: string[] = [];
    const { store, calls } = fakeRag();
    (store as unknown as { deleteDoc: (id: string) => Promise<void> }).deleteDoc = async (id: string) => {
      deletes.push(id);
    };
    const adapter = new ZyplayerDocAdapter(
      { host: "localhost", port: 3307, user: "stub", password: "stub", database: "stub" },
      store,
    );
    (adapter as unknown as { fetchPageContent: () => Promise<{ title: string; content: string }> }).fetchPageContent =
      async () => ({ title: "Idem", content: "# Idem\n\n## A\nx" });

    await adapter.syncPageToRag(99);
    await adapter.syncPageToRag(99);
    await adapter.close();

    expect(calls).toHaveLength(2);
    expect(calls[0].docId).toBe(calls[1].docId);
    expect(calls[0].docId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deletes).toEqual([calls[0].docId, calls[0].docId]);
  });
});
