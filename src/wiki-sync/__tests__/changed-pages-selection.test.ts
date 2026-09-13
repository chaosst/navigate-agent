import { describe, it, expect } from "vitest";
import * as adapterModule from "../zyplayer-doc-adapter.js";
import { ZyplayerDocAdapter } from "../zyplayer-doc-adapter.js";
import type { PgVectorStore } from "../../storage/pg-vector-store.js";

/**
 * 现场证据（2026-09-13 生产库实测）：
 *
 *   id  name                  nt  del  page_ut              content_ut            len
 *   25  self-provider-eval      0    0  2026-09-13 23:21:51  2026-09-13 23:21:51  5437
 *   24  Resume RAG              0    0  2026-09-13 23:21:04  2026-09-13 23:21:04  9129
 *   16  navigate Agent设计文档   0    0  2026-08-07 23:28:23  (null)                 0
 *    6  Resume RAG(回收站)       1    1  2026-09-13 23:20:18  2026-09-13 23:19:53  9129
 *
 * 结论：**通过 UI 建/改的页面 node_type=0**，只有当年迁移脚本写入的那批才是 1。
 * 旧实现 `AND p.node_type = 1` 于是把全部真实文档挡在门外 → 每轮 0 变更 →
 * 静默推进水位（生产日志里除启动外一行都没有）。
 *
 * 因此这里同时锁两件事：
 *   ① SQL 不得再依赖 node_type（枚举语义在实测数据里与注释相反）；
 *   ② 行的取舍改在 JS 侧做，且必须能被单测覆盖（无 MySQL 也能跑）。
 */

interface Row {
  id: number;
  name: string;
  del_flag: number;
  content: string | null;
  update_time: string;
  space_name: string | null;
}

/** 造一个不连 MySQL 的适配器：把 pool 换成回放固定行的桩 */
function adapterWithRows(rows: Row[]): ZyplayerDocAdapter {
  const store = {
    async deleteDoc(): Promise<void> {},
    async addChunks(): Promise<void> {},
  } as unknown as PgVectorStore;
  const adapter = new ZyplayerDocAdapter(
    { host: "localhost", port: 3307, user: "stub", password: "stub", database: "stub" },
    store,
  );
  (adapter as unknown as { pool: unknown }).pool = {
    execute: async () => [rows, []],
    end: async () => {},
  };
  return adapter;
}

/**
 * 注意：这里刻意用命名空间导入而不是具名导入。
 * 换回旧代码时具名导入会变成 ESM 链接错误（整个文件加载失败，红得不说明问题）；
 * 用命名空间导入才能让断言真正执行到、以「行为不对」的方式变红。
 */
const buildChangedPagesQuery = (adapterModule as unknown as { buildChangedPagesQuery?: () => string })
  .buildChangedPagesQuery;

describe("zyplayer 变更页筛选：不再依赖 node_type", () => {
  it("★ 回归锁：SQL 不得再用 node_type 过滤（实测 UI 建页 node_type=0，旧条件漏掉全部文档）", () => {
    expect(typeof buildChangedPagesQuery).toBe("function");
    const sql = buildChangedPagesQuery!();

    // 缺陷本身
    expect(sql).not.toMatch(/node_type/);
    // 但回收站页面必须仍能被查到（删除要反映到 RAG），所以 del_flag 不能写进 WHERE
    expect(sql).not.toMatch(/del_flag\s*=\s*0/);
    // 过滤条件仍在：按「行修改时间」增量拉取
    expect(sql).toMatch(/from\s+wiki_page/i);
    expect(sql).toMatch(/left\s+join\s+wiki_page_content/i);
    expect(sql).toMatch(/where[\s\S]*>\s*\?/i);
    expect(sql).toMatch(/order\s+by/i);
  });

  it("UI 建/改的页面（node_type=0）必须被选中，且 updatedAt 取页面与内容两表的较大值", async () => {
    const adapter = adapterWithRows([
      {
        id: 25,
        name: "self-provider-eval",
        del_flag: 0,
        content: "# self-provider-eval\n\n正文",
        update_time: "2026-09-13 23:21:51",
        space_name: "默认空间",
      },
    ]);

    const items = await adapter.listChangedPages("2026-09-13 15:36:13");
    await adapter.close();

    expect(items).toHaveLength(1);
    expect(items[0].pageId).toBe(25);
    expect(items[0].title).toBe("self-provider-eval");
    expect(items[0].updatedAt).toBe("2026-09-13 23:21:51");
    expect((items[0] as { deleted?: boolean }).deleted).toBe(false);
  });

  it("目录 / 空文档（无内容）不进 RAG：内容为空的行必须被丢掉", async () => {
    const adapter = adapterWithRows([
      {
        id: 16,
        name: "navigate Agent设计文档",
        del_flag: 0,
        content: null,
        update_time: "2026-08-07 23:28:23",
        space_name: "默认空间",
      },
      {
        id: 17,
        name: "新建文档",
        del_flag: 0,
        content: "   \n  ",
        update_time: "2026-08-07 23:28:32",
        space_name: "默认空间",
      },
      {
        id: 24,
        name: "Resume RAG",
        del_flag: 0,
        content: "# Resume RAG\n\n正文",
        update_time: "2026-09-13 23:21:04",
        space_name: "默认空间",
      },
    ]);

    const items = await adapter.listChangedPages("2026-09-13 15:00:00");
    await adapter.close();

    expect(items.map((i) => i.pageId)).toEqual([24]);
  });

  it("回收站页面（del_flag=1）必须被返回并标记 deleted=true，供 poller 清掉 RAG 里的旧索引", async () => {
    const adapter = adapterWithRows([
      {
        id: 6,
        name: "Resume RAG — 简历展示与问答系统",
        del_flag: 1,
        content: "# Resume RAG\n\n旧正文",
        update_time: "2026-09-13 23:20:18",
        space_name: "默认空间",
      },
      {
        id: 25,
        name: "self-provider-eval",
        del_flag: 0,
        content: "# self-provider-eval\n\n正文",
        update_time: "2026-09-13 23:21:51",
        space_name: "默认空间",
      },
    ]);

    const items = await adapter.listChangedPages("2026-09-13 15:00:00");
    await adapter.close();

    expect(items.map((i) => i.pageId)).toEqual([6, 25]);
    expect((items[0] as { deleted?: boolean }).deleted).toBe(true);
    expect((items[1] as { deleted?: boolean }).deleted).toBe(false);
  });
});
