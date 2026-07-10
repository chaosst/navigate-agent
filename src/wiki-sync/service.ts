import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { Document } from "@langchain/core/documents";
import type { RagVectorStore } from "../rag/vectorstore.js";

/**
 * WikiSyncService: 监听 Wiki.js webhook 事件，通过 GraphQL API 获取页面内容
 * 并同步到 RagVectorStore 以实现 RAG 检索。
 */
export class WikiSyncService {
  constructor(
    private wikiUrl: string,
    private apiToken: string,
    private ragStore: RagVectorStore,
  ) {}

  /**
   * 处理 Wiki.js webhook 事件
   * - page:created / page:updated → 同步页面到 RAG
   * - page:deleted → 从 RAG 删除对应索引
   * - 其他事件 → 打印日志忽略
   */
  async handleEvent(event: string, pageId: number, slug: string): Promise<void> {
    switch (event) {
      case "page:created":
      case "page:updated": {
        try {
          const title = await this.syncPageToRag(pageId, slug);
          console.log(`[wiki-sync] Synced "${title}" (${slug}) to RAG`);
        } catch (err) {
          console.error(`[wiki-sync] Failed to sync page ${pageId} (${slug}):`, (err as Error).message);
          throw err;
        }
        break;
      }
      case "page:deleted": {
        try {
          await this.ragStore.deleteDoc(`wiki:${pageId}`);
          console.log(`[wiki-sync] Removed wiki:${pageId} from RAG`);
        } catch (err) {
          console.error(`[wiki-sync] Failed to delete doc wiki:${pageId}:`, (err as Error).message);
          throw err;
        }
        break;
      }
      default:
        console.log(`[wiki-sync] Ignoring unknown event: ${event}`);
    }
  }

  /**
   * 通过 Wiki.js GraphQL API 获取页面内容并同步到 RAG。
   * 返回页面标题（从第一个 "# " 行提取）。
   */
  async syncPageToRag(pageId: number, slug: string): Promise<string> {
    const content = await this.fetchPageContent(pageId);
    const wikiDocId = `wiki:${pageId}`;

    // 先清理旧索引（幂等操作）
    await this.ragStore.deleteDoc(wikiDocId);

    // 分块处理
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
    const docs = await splitter.splitDocuments([
      new Document({
        pageContent: content,
        metadata: {
          filename: `${slug}.md`,
          source: `wiki/${slug}`,
        },
      }),
    ]);

    const chunks = docs.map((d) => ({
      content: d.pageContent,
      metadata: { ...d.metadata },
    }));

    await this.ragStore.addChunks(chunks, wikiDocId);

    // 从第一个 "# " 行提取标题
    const titleLine = content.split("\n").find((line) => line.startsWith("# "));
    return titleLine ? titleLine.replace(/^#\s+/, "") : "";
  }

  /**
   * 调用 Wiki.js GraphQL API 获取页面渲染内容。
   */
  private async fetchPageContent(pageId: number): Promise<string> {
    const query = `
      query ($id: Int!) {
        pages {
          single(id: $id) {
            id
            title
            content
            path
          }
        }
      }
    `;

    const res = await fetch(`${this.wikiUrl}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({
        query,
        variables: { id: pageId },
      }),
    });

    if (!res.ok) {
      throw new Error(`Wiki.js API error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json() as {
      data?: {
        pages?: {
          single?: {
            content: string;
          };
        };
      };
      errors?: unknown;
    };

    // GraphQL 业务错误（如查询语法错误、页面不存在等）
    if (json.errors) {
      throw new Error(`Wiki.js GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    const content = json.data?.pages?.single?.content;
    if (typeof content !== "string") {
      throw new Error(`Wiki.js API: unexpected response structure — missing pages.single.content`);
    }

    return content;
  }
}
