import { createHash } from "node:crypto";
import type { PgVectorStore } from "../storage/pg-vector-store.js";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { chunkMarkdownText } from "../rag/md-chunker.js";

/** 从任意字符串确定性派生一个合法 UUID（md5 → UUID 格式），保证同一页面 ID 恒定 */
function deterministicUuid(seed: string): string {
  const h = createHash("md5").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 将指定页面内容映射为「待同步项」。
 *
 * 取舍规则（无 MySQL 也能单测，见 __tests__/changed-pages-selection.test.ts）：
 *   - 回收站页面（del_flag=1）→ deleted=true，交给 poller 去清 RAG 里的旧索引；
 *   - 目录 / 空文档（没有正文）→ 直接丢掉，没有可索引的内容；
 *   - 其余 → 正常同步。
 */
export function toChangedItems(rows: ZyplayerRow[]): ZyplayerPageItem[] {
  const items: ZyplayerPageItem[] = [];
  for (const r of rows) {
    const deleted = Number(r.del_flag) === 1;
    const content = r.content ?? "";
    if (!deleted && content.trim() === "") continue;
    items.push({
      pageId: r.id,
      title: r.name ?? "",
      content,
      updatedAt: String(r.update_time),
      spaceName: r.space_name ?? "",
      deleted,
    });
  }
  return items;
}

/**
 * zyplayer-doc 页面项（从 MySQL 查询得到）
 */
export interface ZyplayerPageItem {
  pageId: number;
  title: string;
  content: string;
  /** 该行的最后修改时间（数据库时钟域，取页面表与内容表的较大值） */
  updatedAt: string;
  spaceName: string;
  /** true = 在回收站里，应该从 RAG 删除而不是写入 */
  deleted: boolean;
}

/** wiki_page + wiki_page_content 联查出来的原始行 */
export interface ZyplayerRow {
  id: number;
  name: string | null;
  del_flag: number;
  content: string | null;
  update_time: string;
  space_name: string | null;
}

/**
 * 增量拉取「变更页」的 SQL。
 *
 * UPDATE_TS = max(wiki_page.update_time, wiki_page_content.update_time)，
 * 表示这一行真正的最后修改时间，也是 poller 用来推进水位的刻度。
 * 两边都用 COALESCE 兜底，避免其中一张表缺失行时 GREATEST 返回 NULL 而整行被吞掉。
 */
const UPDATE_TS =
  "GREATEST(COALESCE(p.update_time, '1970-01-01 00:00:00'), " +
  "COALESCE(c.update_time, '1970-01-01 00:00:00'))";

export function buildChangedPagesQuery(): string {
  return `SELECT p.id, p.name, p.del_flag, c.content, ${UPDATE_TS} AS update_time, s.name AS space_name
       FROM wiki_page p
       LEFT JOIN wiki_page_content c ON c.page_id = p.id
       LEFT JOIN wiki_space s ON s.id = p.space_id
       WHERE ${UPDATE_TS} > ?
       ORDER BY update_time ASC`;
}

/**
 * ZyplayerDocAdapter: 通过直接读取 zyplayer-doc 的 MySQL 数据库，
 * 获取页面内容并同步到 PgVectorStore。
 *
 * 替代了旧的 WikiSyncService（通过 GraphQL 读写 Wiki.js）。
 *
 * 因为 zyplayer-doc v1.x 开源版没有文档 CRUD 的 REST API，
 * 所以采用 MySQL 数据库直读方式获取内容变更。
 *
 * 依据实际运行的 zyplayer-doc schema（2026-09-13 生产库实测）:
 *   wiki_page:          id, name, space_id, parent_id, node_type,
 *                       editor_type(1=HTML/2=Markdown), del_flag(0有效/1回收站), update_time
 *   wiki_page_content:  id, page_id, content(markdown), update_time
 *   wiki_space:         id, name
 *
 * ⚠️ 不要用 node_type 判断“是不是文档”。实测：通过 UI 新建/编辑的页面 node_type=0，
 *    只有早期迁移脚本 scripts/migrate-wikijs-to-zyplayer.ts 写入的那批是 1。
 *    旧实现按 `node_type = 1` 过滤，把 UI 建的所有页面都挡在门外 —— 每轮 0 变更，
 *    poller 只是静默推进水位，表面上“一切正常”但 RAG 里一页都没有。
 *    现在改用「有没有正文」来判定：目录节点没有 wiki_page_content 行（或内容为空）。
 */
export class ZyplayerDocAdapter {
  private pool: Pool;

  constructor(
    private mysqlConfig: {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
    },
    private ragStore: PgVectorStore,
  ) {
    this.pool = createPool({
      ...this.mysqlConfig,
      waitForConnections: true,
      connectionLimit: 3,
      charset: "utf8mb4",
      // 关键：DATETIME 原样返回 'YYYY-MM-DD HH:MM:SS' 字符串。
      // 不让 mysql2 把它转成 JS Date —— 那会用「本进程的时区」重新解释一遍，
      // 而 zyplayer-doc 容器是 TZ=Asia/Shanghai、app 容器是 UTC，一转就错 8 小时。
      // 时间戳要一路保持在“数据库自己的时钟域”里（也用它当增量水位）。
      dateStrings: true,
    });
  }

  /**
   * 归一化成 MySQL datetime 文本（YYYY-MM-DD HH:MM:SS）。
   * 水位现在直接来自库里的 update_time，本来就是该格式；这里只兜底 ISO 入参。
   */
  private toMySQLDate(iso: string): string {
    return iso.replace("T", " ").slice(0, 19);
  }

  /**
   * 查询自指定时间以来有过更新的页面。
   * 只在数据库层面做过滤，避免全量拉取。
   *
   * “一行有更新”的判定 = max(wiki_page.update_time, wiki_page_content.update_time)：
   * 保存正文时两表都会刷新，但只改标题/移动节点时只有页面表动，取较大值才不漏。
   *
   * 刻意 **不** 在 WHERE 里过滤 del_flag：回收站页面也是一次“变更”，
   * 需要被返回（deleted=true）才能把 RAG 里的旧索引清掉。
   */
  async listChangedPages(since: string): Promise<ZyplayerPageItem[]> {
    const sinceDate = this.toMySQLDate(since);
    const [rows] = await this.pool.execute<RowDataPacket[]>(buildChangedPagesQuery(), [sinceDate]);
    return toChangedItems(rows as unknown as ZyplayerRow[]);
  }

  /**
   * 获取单个页面的标题和内容。
   */
  async fetchPageContent(pageId: number): Promise<{ title: string; content: string }> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT p.name, c.content
       FROM wiki_page p
       LEFT JOIN wiki_page_content c ON c.page_id = p.id
       WHERE p.id = ?`,
      [pageId],
    );
    if (rows.length === 0) {
      throw new Error(`zyplayer-doc: page ${pageId} not found`);
    }
    const r = rows[0];
    return { title: r.name as string, content: (r.content as string) || "" };
  }

  /**
   * 将指定 zyplayer-doc 页面同步到 RAG 向量库。
   * RAG 文档 ID 格式: zyplayer:{pageId}
   */
  async syncPageToRag(pageId: number): Promise<string> {
    const { title, content } = await this.fetchPageContent(pageId);
    // documents.id 是 UUID 列，用确定性 UUID 保证幂等
    const docId = deterministicUuid(`zyplayer:${pageId}`);

    // 分块处理 —— 与 loader.ts 的 .md 路径共用同一个标题感知切块器。
    // 页面内容本身就是 markdown（`# 标题` + 正文），因此同样吃标题分节、代码块保护。
    // 注意：`src/wiki/store.ts` 的 syncToRag 用的是同一个入口，两条 wiki 路径必须保持一致。
    const slug = title
      .toLowerCase()
      .replace(/[^\w一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const chunks = await chunkMarkdownText(content, {
      chunkSize: 1000,
      chunkOverlap: 200,
      filename: `${slug}.md`,
      source: `zyplayer/${slug}`,
    });

    // 先切块、再清旧索引（幂等）。顺序不能反：切块阶段抛错时旧索引还在，
    // 不会出现「旧的删了、新的没写」的空窗（与 /api/reindex 同一处理）。
    // 空正文页面已由 toChangedItems 挡掉，这里 0 片只可能是异常，PgVectorStore 会告警。
    await this.ragStore.deleteDoc(docId);
    await this.ragStore.addChunks(chunks, docId);

    // 从第一个 "# " 行提取标题
    const titleLine = content.split("\n").find((line) => line.startsWith("# "));
    return titleLine ? titleLine.replace(/^#\s+/, "") : title;
  }

  /**
   * 从 RAG 中删除指定页面的索引。
   */
  async deletePageFromRag(pageId: number): Promise<void> {
    await this.ragStore.deleteDoc(deterministicUuid(`zyplayer:${pageId}`));
  }

  /**
   * 关闭 MySQL 连接池。
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
