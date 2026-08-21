import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { createHash } from "node:crypto";
import type { PgVectorStore } from "../storage/pg-vector-store.js";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";

/** 从任意字符串确定性派生一个合法 UUID（md5 → UUID 格式），保证同一页面 ID 恒定 */
function deterministicUuid(seed: string): string {
  const h = createHash("md5").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * zyplayer-doc 页面项（从 MySQL 查询得到）
 */
export interface ZyplayerPageItem {
  pageId: number;
  title: string;
  content: string;
  updatedAt: string;
  spaceName: string;
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
 * 依据实际运行的 zyplayer-doc schema:
 *   wiki_page:          id, name, space_id, parent_id, node_type(0目录/1文档),
 *                       editor_type(1=HTML/2=Markdown), del_flag(0有效), update_time
 *   wiki_page_content:  id, page_id, content(markdown), update_time
 *   wiki_space:         id, name
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
    });
  }

  /** 将 ISO 时间戳转换为 MySQL datetime 格式（YYYY-MM-DD HH:MM:SS） */
  private toMySQLDate(iso: string): string {
    return iso.replace("T", " ").slice(0, 19);
  }

  /**
   * 查询自指定时间以来有过更新的有效页面。
   * 只在数据库层面做过滤，避免全量拉取。
   */
  async listChangedPages(since: string): Promise<ZyplayerPageItem[]> {
    const sinceDate = this.toMySQLDate(since);
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT p.id, p.name, c.content, p.update_time, s.name AS space_name
       FROM wiki_page p
       LEFT JOIN wiki_page_content c ON c.page_id = p.id
       LEFT JOIN wiki_space s ON s.id = p.space_id
       WHERE p.del_flag = 0
         AND p.node_type = 1
         AND p.update_time > ?
       ORDER BY p.update_time ASC`,
      [sinceDate],
    );

    return rows.map((r) => ({
      pageId: r.id as number,
      title: r.name as string,
      content: r.content as string,
      updatedAt: r.update_time as string,
      spaceName: r.space_name as string,
    }));
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

    // 先清理旧索引（幂等）
    await this.ragStore.deleteDoc(docId);

    // 分块处理
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
    const slug = title
      .toLowerCase()
      .replace(/[^\w一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const docs = await splitter.splitDocuments([
      new Document({
        pageContent: content,
        metadata: {
          filename: `${slug}.md`,
          source: `zyplayer/${slug}`,
        },
      }),
    ]);

    const chunks = docs.map((d) => ({
      content: d.pageContent,
      metadata: { ...d.metadata },
    }));

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
