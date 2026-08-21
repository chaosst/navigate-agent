/**
 * 内容同步适配器接口。
 * 定义了从外部知识库（Wiki.js / zyplayer-doc 等）同步内容到 RAG 所需的操作。
 */
export interface SyncAdapter {
  /** 获取自指定时间以来有变更的页面列表 */
  listChangedPages(since: string): Promise<{ pageId: number; updatedAt: string }[]>;
  /** 同步单个页面到 RAG 向量存储，返回页面标题 */
  syncPageToRag(pageId: number): Promise<string>;
  /** 从 RAG 中删除指定页面的索引 */
  deletePageFromRag(pageId: number): Promise<void>;
}
