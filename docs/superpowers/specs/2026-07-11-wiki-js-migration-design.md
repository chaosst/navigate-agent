# Wiki 知识库迁移：自建系统 → Wiki.js

**日期**: 2026-07-11
**状态**: 设计稿（待审批）
**版本**: 1.0

---

## 1. 概述

将现有自建的 Wiki 知识库（SQLite + 内联 HTML 页面）替换为 **Wiki.js**——GitHub 上最成熟的开源 Wiki 系统（Node.js + Vue.js 技术栈）。

### 为什么要换

| 对比维度 | 当前自建 Wiki | Wiki.js |
|---------|-------------|---------|
| 编辑器 | 简陋的正则 Markdown 渲染 | WYSIWYG + Markdown 双模式 |
| 目录组织 | 单层分类 | 无限层级树形目录 |
| 全文搜索 | SQL LIKE 搜索 | 内置 Elasticsearch 级搜索 |
| 版本管理 | 基础的 revision 记录 | 完整的版本对比/回滚 |
| 附件 | 不支持 | 拖拽上传图片/文件 |
| 权限 | 无 | 群组/角色/页面级权限 |
| 多语言 | 仅中文 | 支持 30+ 语言 |
| 维护成本 | 自己维护全部代码 | 社区成熟，持续更新 |

---

## 2. 架构

```
┌──────────────────────────────────────┐
│    Navigate App (localhost:3001)     │
│  ┌────────────────────────────────┐  │
│  │ 导航栏                         │  │
│  │ 📄 文档管理 | 📚 Wiki ↗ | 👤 简历 │  │
│  │   (链接到 Wiki.js)             │  │
│  └──────┬─────────────────────────┘  │
│         │                             │
│  ┌──────▼─────────────────────────┐  │
│  │ Webhook 端点 /api/wiki-sync     │  │
│  │ → 同步文章到 RAG 向量库         │  │
│  └────────────────────────────────┘  │
│  RAG · Resume · Chat · Skills        │
└─────────────┬────────────────────────┘
              │ webhook (page:created/updated/deleted)
┌─────────────▼────────────────────────┐
│  Wiki.js (localhost:3003)            │
│  ┌────────────────────────────────┐  │
│  │ WYSIWYG / Markdown 编辑器      │  │
│  │ 树形目录 · 全文搜索 · 版本管理   │  │
│  │ 权限控制 · 附件上传 · 标签系统   │  │
│  │ GraphQL API + Webhook 引擎     │  │
│  └────────────────────────────────┘  │
│  Storage: SQLite / data/             │
└──────────────────────────────────────┘
```

### 架构要点

- Wiki.js 运行在独立端口 **3003**，独立 Node.js 进程
- 两者通过 **导航栏链接** 和 **Webhook 回调** 集成
- RAG 同步通过 Wiki.js 的 Webhook 机制触发，不依赖定时轮询

---

## 3. Wiki.js 安装与配置

### 安装方式

官方发布包下载到项目子目录 `wiki-js/`：

```
D:\develop\navigate\
  ├── wiki-js/                 ← Wiki.js 安装目录
  │   ├── server/              ← 服务器代码
  │   ├── node_modules/        ← 自带依赖
  │   ├── config.yml           ← 配置文件
  │   └── data/                ← SQLite DB + 上传文件
  ├── package.json
  └── ...
```

### 配置 (config.yml)

```yaml
port: 3003
host: 'localhost'
db:
  type: sqlite
  file: ./data/wiki.db
  storage:
    engine: 'sqlite'
uploads:
  mode: local
  path: ./data/uploads
auth:
  autoLogin: true
  local:
    enabled: true
offline: false
seeding: false
```

### 启动脚本

在 `package.json` 中增加：

```json
{
  "scripts": {
    "dev": "tsx src/index.ts & cd wiki-js && node server",
    "dev:wiki": "cd wiki-js && node server start"
  }
}
```

### 初始化配置

首次启动 Wiki.js 后，通过浏览器访问 `http://localhost:3003` 完成：
1. 管理员账号设置
2. 勾选启用 **Webhook** 功能
3. 关闭不必要的功能（如邮件通知、远程存储等）

---

## 4. 导航栏集成

所有现有页面的导航栏中，**📚 Wiki** 链接改为指向 Wiki.js：

| 文件 | 修改内容 |
|------|---------|
| `src/server/public/index.html` | Wiki 链接 → `http://localhost:3003`，新标签页打开 |
| `src/server/public/resume.html` | 同上 |
| `src/server/public/resume-chat.html` | 同上 |
| `src/server/public/wiki.html` | **删除**（不再需要） |
| `src/server/public/wiki-edit.html` | **删除** |
| `src/server/public/wiki-article.html` | **删除** |

导航栏其他链接保持不动。

---

## 5. RAG 同步机制

### 整体流程

```
用户编辑/创建/删除 Wiki 页面
        │
        ▼
  Wiki.js 保存到 SQLite
        │
        ├── 触发 Webhook POST
        │    URL: http://localhost:3001/api/wiki-sync
        │    Payload: { event, pageId, slug, title, ... }
        │
        ▼
  Navigate App 接收 Webhook
        │
        ├── page:created  → 通过 GraphQL API 获取内容 → 分块 → 注入 RAG
        ├── page:updated  → 删除旧索引 → 获取新内容 → 分块 → 注入 RAG
        └── page:deleted  → 从 RAG 删除对应索引
```

### 新增文件：`src/wiki-sync/service.ts`

```typescript
/**
 * Wiki.js → RAG 同步服务
 * 
 * 职责：
 * 1. 接收 Wiki.js Webhook 事件
 * 2. 通过 Wiki.js GraphQL API 获取页面内容
 * 3. 分块后同步到 RagVectorStore
 */

export class WikiSyncService {
  private wikiApiUrl: string;
  private wikiApiToken: string;
  private ragStore: RagVectorStore;

  constructor(config: { wikiUrl: string; apiToken: string; ragStore: RagVectorStore }) {
    this.wikiApiUrl = config.wikiUrl;       // http://localhost:3003
    this.wikiApiToken = config.apiToken;
    this.ragStore = ragStore;
  }

  /** 处理 Wiki.js webhook 事件 */
  async handleEvent(event: 'page:created' | 'page:updated' | 'page:deleted', pageId: number, slug: string): Promise<void> {
    switch (event) {
      case 'page:created':
      case 'page:updated': {
        const title = await this.syncPageToRag(pageId, slug);
        console.log(`[wiki-sync] Synced "${title}" (${slug}) to RAG`);
        break;
      }
      case 'page:deleted': {
        await this.ragStore.deleteDoc(`wiki:${pageId}`);
        console.log(`[wiki-sync] Removed wiki:${pageId} from RAG`);
        break;
      }
    }
  }

  /** 通过 Wiki.js GraphQL API 获取页面内容并同步到 RAG */
  async syncPageToRag(pageId: number, slug: string): Promise<string> {
    const content = await this.fetchPageContent(pageId);
    // 分块和注入逻辑，复用现有 syncToRag 的核心思路
    const wikiDocId = `wiki:${pageId}`;
    await this.ragStore.deleteDoc(wikiDocId);

    const { RecursiveCharacterTextSplitter } = await import("langchain/text_splitter");
    const { Document } = await import("@langchain/core/documents");
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
    const docs = await splitter.splitDocuments([
      new Document({ pageContent: content, metadata: { filename: `${slug}.md`, source: `wiki/${slug}` } })
    ]);
    const chunks = docs.map(d => ({
      content: d.pageContent,
      metadata: { ...d.metadata },
    }));
    await this.ragStore.addChunks(chunks, wikiDocId);
    return content.split('\n')[0].replace(/^#\s+/, '');
  }

  /** 调用 Wiki.js GraphQL API 获取页面渲染内容 */
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
    const res = await fetch(`${this.wikiApiUrl}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.wikiApiToken}`,
      },
      body: JSON.stringify({ query, variables: { id: pageId } }),
    });
    if (!res.ok) throw new Error(`Wiki.js API error: ${res.status}`);
    const data = await res.json() as { data: { pages: { single: { title: string; content: string; path: string } } } };
    return data.data.pages.single.content;
  }
}
```

### 新增 Webhook 端点：`src/server/index.ts`

在现有 Express 服务器中增加：

```typescript
// Wiki.js webhook receiver
app.post("/api/wiki-sync", async (req, res) => {
  try {
    const { event, pageId, slug } = req.body;
    if (!event || !pageId) {
      return res.status(400).json({ error: "Missing event or pageId" });
    }
    // 可选：验证 Wiki.js 签名
    await wikiSyncService.handleEvent(event, pageId, slug || "");
    res.json({ ok: true });
  } catch (err) {
    console.error("[wiki-sync] Error:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

### Wiki.js Webhook 配置

在 Wiki.js 管理后台 → **Webhooks** → 新增全局 Webhook：

| 字段 | 值 |
|------|-----|
| 名称 | Navigate RAG Sync |
| 触发事件 | `page:created`, `page:updated`, `page:deleted` |
| URL | `http://localhost:3001/api/wiki-sync` |
| 签名密钥 | (可选) 设置一个密钥，服务端验证 |

### Webhook 数据格式

Wiki.js 发送的 webhook payload 结构：

```json
{
  "event": "page:updated",
  "pageId": 3,
  "slug": "my-article",
  "title": "My Article",
  "editor": "admin",
  "description": "",
  "tags": [],
  "locale": "zh_CN"
}
```

---

## 6. 数据迁移

### 迁移脚本：`scripts/migrate-wiki-to-wikijs.ts`

执行流程：

```
1. 读取旧 SQLite 库 (navigate.db)
   - 获取所有 wiki_articles
   - 获取所有 wiki_categories

2. 通过 Wiki.js GraphQL API 创建文章
   - 每篇文章使用 pages.create mutation
   - path: /{category-slug}/{article-slug}（无分类 → /uncategorized/）
   - editor: "markdown", locale: "zh_CN", isPublished: true
   - 无需预先创建 namespace（Wiki.js 通过 path 自动管理层级）

3. 验证
   - 对比文章数量
   - 抽样检查内容完整性

4. 输出报告
   - 成功: N 篇
   - 失败: N 篇（列出详情）
```

> **注意:** Wiki.js v2 的 GraphQL API 没有独立的 namespaces.create mutation。
> 页面通过 `path` 参数组织（如 `/guide/getting-started`），层级由路径结构自动管理。

### GraphQL 接口

```
mutation ($content: String!, $description: String!, $editor: String!,
         $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!,
         $path: String!, $tags: [String]!, $title: String!) {
  pages {
    create(content: $content, description: $description, editor: $editor,
           isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale,
           path: $path, tags: $tags, title: $title) {
      responseResult { succeeded errorCode slug message }
    }
  }
}
```

### 边界情况

| 场景 | 处理 |
|------|------|
| 文章标题含特殊字符 | Wiki.js 自动处理 URL 编码 |
| 已有同名页面 | 跳过并记录到迁移报告 |
| 迁移中途失败 | 幂等设计，可重新执行 |
| 旧库为空 | 迁移脚本输出 "无数据" 后终止 |

---

## 7. 旧代码清理

### 移除的文件

| 文件 | 说明 |
|------|------|
| `src/server/public/wiki.html` | 由 Wiki.js 仪表盘替代 |
| `src/server/public/wiki-edit.html` | 由 Wiki.js 编辑器替代 |
| `src/server/public/wiki-article.html` | 由 Wiki.js 阅读页替代 |

### 停用但保留的代码

| 文件 | 处理方式 |
|------|---------|
| `src/wiki/store.ts` | 不再挂载，核心分块逻辑已提取到 `wiki-sync/service.ts` |
| `src/wiki/router.ts` | 不再传入 `createRagServer()` |
| `src/wiki/types.ts` | 保留作为参考 |

### 修改的文件

| 文件 | 改动 |
|------|------|
| `src/server/index.ts` | 移除 `wikiStore` 参数，去除 wiki router 挂载，新增 `/api/wiki-sync` Webhook 端点 |
| `src/server/public/index.html` | 导航栏 Wiki 链接指向 `http://localhost:3003` |
| `src/server/public/resume.html` | 同上 |
| `src/server/public/resume-chat.html` | 同上 |
| `package.json` | 新增 `dev:wiki` 脚本 |

---

## 8. 实施顺序

1. **安装 Wiki.js** — 下载发布包到 `wiki-js/`，配置 `config.yml`，首次启动并设置管理员
2. **新建同步服务** — 编写 `src/wiki-sync/service.ts`
3. **新增 Webhook 端点** — 修改 `src/server/index.ts`
4. **配置 Wiki.js Webhook** — 管理后台设置 webhook 指向 `localhost:3001/api/wiki-sync`
5. **修改导航栏** — 更新 3 个 HTML 文件中的链接
6. **移除旧 wiki 路由** — 从 `createRagServer` 中去除 `wikiStore` 挂载
7. **数据迁移** — 编写并运行 `scripts/migrate-wiki-to-wikijs.ts`
8. **验证** — 确认 RAG 同步正常、文章可检索、导航链接跳转正确
9. **清理** — 删除 3 个旧的 wiki HTML 文件

---

## 9. 边界情况与错误处理

| 场景 | 处理 |
|------|------|
| Wiki.js 未启动 | Webhook 调用失败，打印 warning，不影响主应用 |
| Wiki.js GraphQL API 调用失败 | 捕获异常，记录日志，RAG 暂不同步（下次 webhook 重试） |
| Webhook 签名不匹配 | 拒绝请求，返回 401 |
| 迁移时旧库为空 | 提示无数据，终止迁移 |
| 同步重复文章 | `deleteDoc + addChunks` 是幂等的 |
| Wiki.js 页面路径变更 | Webhook 带最新 slug，索引自动更新 |
