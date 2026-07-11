import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { Document } from "@langchain/core/documents";
import type { RagVectorStore } from "../rag/vectorstore.js";

/**
 * Wiki.js 页面列表项（来自 pages.list GraphQL 查询）
 */
export interface WikiPageItem {
  id: number;
  path: string;
  title: string | null;
  description: string | null;
  contentType: string;
  isPublished: boolean;
  updatedAt: string;
}

/**
 * WikiSyncService: 通过 Wiki.js GraphQL API 获取页面内容并同步到 RagVectorStore。
 */
export class WikiSyncService {
  constructor(
    private wikiUrl: string,
    private apiToken: string,
    private ragStore: RagVectorStore,
  ) {}

  /**
   * 获取 Wiki.js 中所有已发布页面的列表。
   */
  async listPages(): Promise<WikiPageItem[]> {
    const query = `
      query {
        pages {
          list(orderBy: UPDATED, orderByDirection: DESC) {
            id
            path
            title
            description
            contentType
            isPublished
            updatedAt
          }
        }
      }
    `;

    const data = await this.graphqlRequest<{
      pages: { list: WikiPageItem[] };
    }>(query, {});

    if (!data.pages?.list) {
      throw new Error("Wiki.js API: unexpected response — missing pages.list");
    }

    return data.pages.list.filter((p) => p.isPublished);
  }

  /**
   * 在 Wiki.js 中创建一篇新页面。
   * 返回创建后的 pageId。
   */
  async createPage(title: string, content: string, description = ""): Promise<number> {
    const mutation = `
      mutation ($content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!) {
        pages {
          create(content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale, path: $path, tags: $tags, title: $title) {
            responseResult { succeeded errorCode slug message }
            page { id }
          }
        }
      }
    `;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-").slice(0, 80);
    const path = `/uploads/${slug}`;

    const data = await this.graphqlRequest<{
      pages: { create: { responseResult: { succeeded: boolean; errorCode: number; slug: string; message?: string }; page: { id: number } | null } };
    }>(mutation, {
      content,
      description,
      editor: "markdown",
      isPublished: true,
      isPrivate: false,
      locale: "en",
      path,
      tags: ["upload"],
      title,
    });

    const result = data.pages.create.responseResult;
    if (!result.succeeded) {
      throw new Error(`Wiki.js create page failed: ${result.message || `errorCode ${result.errorCode}`}`);
    }
    return data.pages.create.page?.id ?? 0;
  }

  /**
   * 通用的 GraphQL 请求方法。
   */
  private async graphqlRequest<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.wikiUrl}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      throw new Error(`Wiki.js API error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json() as {
      data?: T;
      errors?: unknown;
    };

    if (json.errors) {
      throw new Error(`Wiki.js GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    if (json.data === undefined) {
      throw new Error("Wiki.js API: empty response data");
    }

    return json.data;
  }

  /**
   * 处理 Wiki.js webhook 事件
   * - page:created / page:updated → 同步页面到 RAG
   * - page:deleted → 从 RAG 删除对应索引
   * - 其他事件 → 打印日志忽略
   */
  async handleEvent(event: "page:created" | "page:updated" | "page:deleted", pageId: number, slug: string): Promise<void> {
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

    const data = await this.graphqlRequest<{
      pages: { single: { content: string } };
    }>(query, { id: pageId });

    if (!data.pages?.single?.content) {
      throw new Error(`Wiki.js API: page ${pageId} not found or has no content`);
    }

    return data.pages.single.content;
  }
}
