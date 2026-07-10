export interface WikiArticle {
  id: string;
  title: string;
  slug: string;
  contentMd: string;
  summary: string;
  categoryId: string | null;
  tags: string[];
  status: "draft" | "published";
  createdAt: Date;
  updatedAt: Date;
}

export interface WikiCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  parentId: string | null;
  sortOrder: number;
}

export interface WikiRevision {
  id: string;
  articleId: string;
  contentMd: string;
  summary: string;
  editorNote: string;
  createdAt: Date;
}

export interface WikiArticleListItem {
  id: string;
  title: string;
  slug: string;
  summary: string;
  categoryId: string | null;
  categoryName?: string;
  tags: string[];
  status: "draft" | "published";
  createdAt: string;
  updatedAt: string;
}

export interface WikiArticleListResponse {
  items: WikiArticleListItem[];
  total: number;
  page: number;
  limit: number;
}
