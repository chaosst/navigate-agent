---
title: Wiki 知识库 + OpenCode Skill 系统设计文档
date: 2026-07-10
status: draft
---

# Wiki 知识库 + OpenCode Skill 系统设计

## 概述

在现有的 Navigate Agent 项目中新增两个子系统：

1. **Wiki 知识库** — 支持在 Web 浏览器中编写/编辑 Markdown 文章，按分类组织，文章自动注入 RAG 索引，Agent 通过 `search_documents` 工具直接检索
2. **OpenCode Skill 系统** — 支持通过 YAML 文件定义可复用的技能（Skills），在运行时动态加载为 Agent 的 `StructuredTool`

---

## 一、Wiki 知识库

### 1. 架构

```
Web 编辑器 ←→ Express API ←→ WikiStore (SQLite)
                                    │
                             同步到 RAG
                                    ↓
                          RagVectorStore (现有)
                                    │
                     Agent: search_documents 工具
```

### 2. 数据模型

```typescript
// src/wiki/types.ts

export interface WikiArticle {
  id: string;              // UUID
  title: string;
  slug: string;            // URL 友好的唯一标识，如 "rag-intro"
  contentMd: string;       // Markdown 原文
  summary: string;         // 摘要（用于列表展示）
  categoryId: string | null;
  tags: string[];          // 标签列表
  status: "draft" | "published";
  createdAt: Date;
  updatedAt: Date;
}

export interface WikiCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  parentId: string | null; // 支持二级分类
  sortOrder: number;
}

export interface WikiRevision {
  id: string;
  articleId: string;
  contentMd: string;
  summary: string;
  editorNote: string;      // 编辑备注
  createdAt: Date;
}
```

### 3. SQLite 表结构

```sql
CREATE TABLE wiki_articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  content_md TEXT NOT NULL,
  summary TEXT DEFAULT '',
  category_id TEXT,
  tags TEXT DEFAULT '',       -- 逗号分隔
  status TEXT DEFAULT 'published',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE wiki_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  parent_id TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE wiki_revisions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  content_md TEXT NOT NULL,
  summary TEXT DEFAULT '',
  editor_note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (article_id) REFERENCES wiki_articles(id)
);
```

### 4. Web 页面

三个页面，位于 `src/server/public/`，均为纯内联 HTML/CSS/JS（不依赖 CDN）：

| 页面 | 路由 | 功能 |
|------|------|------|
| Wiki 仪表盘 | `/wiki` | 文章列表（分类筛选、关键词搜索）、新建按钮、分类管理侧栏 |
| 文章编辑器 | `/wiki/edit?id=xxx` | Markdown 编辑区 + 实时预览分栏、分类下拉、标签输入、保存/发布按钮 |
| 文章阅读页 | `/wiki/article?slug=xxx` | 渲染的 Markdown 内容、自动目录导航、编辑按钮、版本历史 |

编辑器支持：
- 分栏布局：左编辑 / 右预览
- 快捷键：`Ctrl+S` 保存
- 类别选择下拉（从 `wiki_categories` 加载）
- 标签输入（逗号分隔）

### 5. API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/wiki/articles?category=&search=&page=&limit=` | 文章列表（分页） |
| `POST` | `/api/wiki/articles` | 创建文章 |
| `GET` | `/api/wiki/articles/:id` | 获取单篇文章 |
| `PUT` | `/api/wiki/articles/:id` | 更新文章 |
| `DELETE` | `/api/wiki/articles/:id` | 删除文章（同时从 RAG 移除） |
| `GET` | `/api/wiki/articles/:id/revisions` | 版本历史 |
| `GET` | `/api/wiki/categories` | 分类列表（树形结构） |
| `POST` | `/api/wiki/categories` | 创建分类 |
| `PUT` | `/api/wiki/categories/:id` | 更新分类 |
| `DELETE` | `/api/wiki/categories/:id` | 删除分类 |

### 6. RAG 自动同步机制

```
保存/更新文章:
  WikiStore.save()
    ├── 写入 SQLite
    ├── 将 contentMd 通过 loadDocument() 分块
    ├── 若是更新 → 调用 RagVectorStore.deleteDoc(docId=wiki:articleId)
    ├── 调用 RagVectorStore.addChunks() 注入新索引
    └── 返回文章对象

删除文章:
  WikiStore.delete()
    ├── 从 SQLite 删除
    ├── 从 RagVectorStore 移除索引 (deleteDoc)
    └── 返回成功
```

需要为 `RagVectorStore` 补充 `deleteDoc(docId)` 方法。

### 7. 导航整合

在现有页面导航栏中增加 Wiki 入口：
- `/` (RAG 文档管理) → 增加「📚 Wiki」链接
- `/wiki` 页面 → 包含「📄 文档管理」「👤 简历」链接

---

## 二、OpenCode Skill 系统

### 1. 架构

```
skills/*.skill.yaml
        │
SkillRegistry.scan()
        │
  ┌─────┴─────┐
  │ YAML 解析  │
  │ Schema 校验 │
  └─────┬─────┘
        │
SkillFactory.toTool()
        │
  ┌─────┴─────┐
  │ SkillTool  │  (StructuredTool)
  │ action     │
  │  dispatch  │
  └─────┬─────┘
        │
 注入 AgentExecutor
```

### 2. Skill YAML 格式

```yaml
# skills/<name>.skill.yaml
name: string              # 工具名，如 greet_user
description: string       # Agent 理解的功能描述
schema:
  type: object
  properties:
    paramName:
      type: string | integer | boolean
      description: string
      enum?: string[]
      default?: any
  required: string[]      # 必填参数列表
action:
  type: "template" | "shell" | "http" | "code"
  # type=template 时
  template: string        # Nunjucks 模板
  # type=shell 时
  command: string         # Shell 命令，{{ param }} 为参数插值
  workdir?: string        # 工作目录
  timeout?: number        # 超时毫秒
  # type=http 时
  url: string             # URL，支持参数插值
  method: GET | POST
  headers?: object
  body?: string           # POST 请求体模板
  # type=code 时
  code: string            # 内联 JS 代码 (async (params) => any)
```

### 3. 动作类型执行方式

| 类型 | 实现方式 | 示例 |
|------|---------|------|
| `template` | Nunjucks 模板引擎渲染 | 问候语生成、格式化输出 |
| `shell` | `child_process.execSync/exec` | git 操作、文件操作、构建命令 |
| `http` | `fetch()` 调用 | 天气查询、API 调用 |
| `code` | `new AsyncFunction()` 沙箱执行 | 数据处理、计算、格式化 |

### 4. 核心组件

#### SkillDefinition（`src/skills/types.ts`）

```typescript
export type SkillActionType = "template" | "shell" | "http" | "code";

export interface SkillAction {
  type: SkillActionType;
  template?: string;
  command?: string;
  workdir?: string;
  timeout?: number;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  code?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  action: SkillAction;
}
```

#### SkillRegistry（`src/skills/registry.ts`）

```typescript
export class SkillRegistry {
  private skillsDir: string;
  private tools: Map<string, StructuredTool>;

  constructor(skillsDir?: string);  // 默认 "skills/"
  
  /** 扫描目录并加载所有 .skill.yaml */
  async loadAll(): Promise<StructuredTool[]>;
  
  /** 加载单个 skill 文件 */
  async loadSkill(filePath: string): Promise<StructuredTool>;
  
  /** 将 SkillDefinition 转为 StructuredTool */
  private toTool(def: SkillDefinition): StructuredTool;
  
  /** 监听文件变更（热更新，可选） */
  watch(): void;
}
```

#### SkillTool（`src/skills/skill-tool.ts`）

```typescript
export class SkillTool extends StructuredTool {
  name: string;
  description: string;
  schema: ZodType;
  private def: SkillDefinition;

  constructor(def: SkillDefinition);

  async _call(input: Record<string, unknown>): Promise<string> {
    switch (this.def.action.type) {
      case "template": return renderTemplate(this.def.action.template!, input);
      case "shell":    return execShell(this.def.action, input);
      case "http":     return callHttp(this.def.action, input);
      case "code":     return runCode(this.def.action.code!, input);
    }
  }
}
```

### 5. 集成方式

```typescript
// src/index.ts 修改点
const skillRegistry = new SkillRegistry("skills");
const skillTools = await skillRegistry.loadAll();

const allTools = [
  ...createTools(),
  ragTool,
  ...(resumeTool ? [resumeTool] : []),
  ...skillTools,    // ← 新增
];
```

---

## 三、边界情况与错误处理

### Wiki 知识库

| 场景 | 处理 |
|------|------|
| 文章标题 → slug 冲突 | 自动追加数字后缀（如 `my-article-2`） |
| 保存时 Markdown 渲染失败 | 前端预览降级为纯文本，后端仍保存原文 |
| 从 RAG 删除索引失败 | 记录 warning，不影响 SQLite 删除 |
| 分类含子分类时被删除 | 禁止删除，返回"请先删除子分类" |
| 空标题 / 空内容 | 前端+后端双重校验，返回 400 |
| 分页参数越界 | 返回空列表而非错误 |
| 并发保存同一篇文章 | SQLite 事务 + updated_at 乐观锁 |

### Skill 系统

| 场景 | 处理 |
|------|------|
| YAML 格式错误 | 跳过该文件，打印 warning，不影响其他 skill |
| Shell 命令超时 | 返回 "Command timed out after Nms" |
| HTTP 请求失败 | 返回状态码 + 错误消息 |
| 模板渲染参数缺失 | 返回 "Missing required parameter: xxx" |
| `skills/` 目录不存在 | 静默跳过，不报错 |
| 同名 skill 冲突 | 后加载覆盖先加载，打印 warning |
| `${ENV_VAR}` 未设置 | 返回 "Environment variable XXX is not set" |
| `code` 类型执行抛异常 | 返回异常消息，agent 可重试 |

---

## 四、文件变更清单

### 新增文件

| 文件 | 模块 | 说明 |
|------|------|------|
| `src/wiki/types.ts` | Wiki | 类型定义 |
| `src/wiki/store.ts` | Wiki | WikiStore（SQLite CRUD + RAG 同步） |
| `src/wiki/router.ts` | Wiki | Express 路由 |
| `src/server/public/wiki.html` | Wiki | 仪表盘页面 |
| `src/server/public/wiki-edit.html` | Wiki | 文章编辑器页面 |
| `src/server/public/wiki-article.html` | Wiki | 文章阅读页面 |
| `src/skills/types.ts` | Skill | SkillDefinition 等类型定义 |
| `src/skills/registry.ts` | Skill | SkillRegistry 扫描加载 |
| `src/skills/skill-tool.ts` | Skill | SkillTool StructuredTool 实现 |
| `skits/example.skill.yaml` | Skill | 示例 YAML 文件 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/server/index.ts` | 挂载 Wiki 路由 + 初始化 WikiStore |
| `src/rag/vectorstore.ts` | 新增 `deleteDoc(docId)` 方法 |
| `src/index.ts` | 初始化 WikiStore 和 SkillRegistry |
| `src/server/public/index.html` | 导航栏加「📚 Wiki」链接 |

---

## 五、实施顺序

1. **准备阶段**：给 `RagVectorStore` 加 `deleteDoc()` 方法
2. **Wiki 知识库**：types → store → router → 三个 HTML 页面 → index.ts 集成
3. **Skill 系统**：types → SkillTool → SkillRegistry → 示例 YAML → index.ts 集成
4. **导航整合**：各页面导航栏互链
5. **验证**：typecheck + 启动测试
