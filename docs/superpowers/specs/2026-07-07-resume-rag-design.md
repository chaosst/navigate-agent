# Resume RAG — 简历展示与问答系统

**日期**: 2026-07-07
**状态**: 设计稿（待审批）
**版本**: 1.0

---

## 1. 概述

在现有的 Navigate Agent 项目中，利用 RAG 技术实现个人简历的展示与智能问答。提供三种交互方式：**Agent CLI 对话**、**精美 Web 简历展示页**、**Web 简历问答聊天页**。

### 目标

- 用户可以通过自然语言向 agent 询问简历内容
- 简历以精美的响应式页面在浏览器展示
- 简历问答聊天页面支持推荐问题、流式输出
- 简历数据独立持久化存储，不依赖内存向量库

---

## 2. 整体架构

```
resume.md (源文件)
    │ 解析
    ▼
ResumeParser ──→ ResumeData (结构化 JSON)
    │               │
    │               ▼
    │          ResumeStore (SQLite 持久化)
    │           ├── 文本块 + OpenAI Embeddings + 元数据(所属章节)
    │           ├── 结构化 ResumeData (JSON 存 SQLite)
    │           └── 版本管理(文件 hash 检测变更)
    │
    ├──► Agent: search_resume 工具
    │           - 按关键词搜索所有内容
    │           - 按章节过滤 (experience / education / skills …)
    │
    ├──► API (Express 路由)
    │     GET  /api/resume          → 完整结构化简历数据
    │     POST /api/resume/chat     → SSE 流式对话
    │
    └──► Web 页面
          GET /resume       → 简历展示页
          GET /resume/chat  → 简历问答聊天页
```

### 关键设计决策

- **独立持久化**: ResumeStore 使用 SQLite 存储 chunks + base64 embeddings，与通用 RAG (MemoryVectorStore) 解耦
- **启动自动导入**: 读取项目根目录 `resume.md`，检测文件 hash 变化后自动更新索引
- **复用 Agent Executor**: Web 聊天页复用 CLI 的 agent executor，保持一致的行为和工具集

---

## 3. 数据结构

```typescript
// src/resume/types.ts

export interface ResumeData {
  name: string;
  title: string;
  summary: string;
  contact: {
    email: string;
    phone?: string;
    github?: string;
    website?: string;
    linkedin?: string;
  };
  sections: ResumeSection[];
}

export type SectionType =
  | "experience"
  | "education"
  | "skills"
  | "projects"
  | "certifications"
  | "languages";

export interface ResumeSection {
  type: SectionType;
  title: string;
  items: ResumeItem[];
}

export interface ResumeItem {
  title: string;
  subtitle?: string;
  dateRange?: string;
  description: string;      // Markdown 格式
  highlights?: string[];
  tags?: string[];
}
```

### 分块策略

| Section | 分块粒度 | sections 过滤值 |
|---------|---------|----------------|
| summary | 整段 1 块 | `all` |
| experience | 每个 item 为 1 块 | `experience` |
| education | 每个 item 为 1 块 | `education` |
| skills | 按类别分组块 | `skills` |
| projects | 每个项目 1 块 | `projects` |
| certifications | 每个证书 1 块 | `certifications` |

---

## 4. 核心组件

### 4.1 ResumeParser (`src/resume/parser.ts`)

从 `resume.md` 解析为 `ResumeData`。

**输入**: Markdown 文件路径
**输出**: `ResumeData`

**解析规则**:
- `--- frontmatter ---` 读取元数据 (name, title, email 等)
- `## 标题` 识别章节类型（映射表：工作经历→experience, 技能→skills 等）
- 各章节下的子标题和列表提取为 `ResumeItem`
- `highlights` 从项目符号列表提取

### 4.2 ResumeStore (`src/resume/store.ts`)

基于 `sql.js` 的持久化存储。

**SQLite 表结构**:

```sql
-- 简历元信息
CREATE TABLE resume_meta (
  id TEXT PRIMARY KEY DEFAULT 'current',
  name TEXT,
  title TEXT,
  email TEXT,
  summary TEXT,
  raw_md TEXT,
  version INTEGER DEFAULT 1,
  updated_at TEXT
);

-- 分块 + embedding
CREATE TABLE resume_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_type TEXT NOT NULL,
  item_title TEXT,
  content TEXT NOT NULL,
  embedding TEXT,    -- base64 编码的 Float32Array
  seq INTEGER
);

-- 版本追踪
CREATE TABLE resume_versions (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  md_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  changes TEXT      -- 变更描述（可选）
);
```

**API**:

```typescript
class ResumeStore {
  constructor(dbPath: string, embeddings: OpenAIEmbeddings);
  
  /** 导入/更新简历数据 */
  async import(data: ResumeData, rawMd: string): Promise<void>;
  
  /** 检测 resume.md 是否有变更 */
  async hasChanged(mdHash: string): Promise<boolean>;
  
  /** 语义搜索 */
  async search(query: string, section?: SectionType, k?: number): Promise<RagResult[]>;
  
  /** 获取概要（注入 prompt 用） */
  async getSummary(): Promise<string>;
  
  /** 获取完整结构化数据 */
  async getResumeData(): Promise<ResumeData | null>;
  
  /** 计算余弦相似度（内存中对比 query 和 stored embeddings） */
  private cosineSimilarity(a: number[], b: number[]): number;
}
```

### 4.3 ResumeSearchTool (`src/resume/search-tool.ts`)

```typescript
class ResumeSearchTool extends StructuredTool {
  name = "search_resume";
  description = "Search the user's resume for professional experience, skills, education, and project details. "
    + "Use this when asked about the user's background, skills, work history, or qualifications. "
    + "Filter by section type (experience, education, skills, projects) to narrow results.";

  schema = z.object({
    query: z.string().describe("Search query for resume content"),
    section: z.enum(["experience","education","skills","projects","certifications","all"])
      .optional()
      .describe("Filter results to a specific resume section"),
    k: z.number().optional().describe("Number of results to return (default 5)"),
  });

  constructor(private store: ResumeStore) {}

  async _call({ query, section, k }: z.infer<typeof this.schema>): Promise<string> {
    const results = await this.store.search(query, section, k || 5);
    // 格式化为可读文本
  }
}
```

### 4.4 System Prompt 更新 (`src/agent/prompt.ts`)

```typescript
export function buildSystemPrompt(resumeSummary?: string): string {
  let prompt = `You are an AI assistant with access to file system and shell tools...`;

  if (resumeSummary) {
    prompt += `\n\n## About the User\n${resumeSummary}\n\n`
      + `You have access to the user's resume via the search_resume tool. `
      + `The resume contains sections: experience, education, skills, projects, certifications. `
      + `When asked about the user's background, experience, or qualifications, use search_resume.`;
  }

  return prompt;
}
```

---

## 5. Web 页面

### 5.1 简历展示页 (`/resume`)

- 纯静态 HTML + CSS + vanilla JS
- 响应式布局（桌面/平板/手机）
- 支持亮/暗模式
- 区块：头像+联系信息 → 个人简介 → 工作经历时间线 → 技能标签云 → 项目卡片 → 教育背景
- 底部的 PDF 下载按钮和时间戳

### 5.2 简历问答聊天页 (`/resume/chat`)

**布局**:
- 顶部：导航（← 返回简历）+ 标题
- 中间：对话区域（用户消息 + AI 流式输出）
- 推荐问题区域：可点击的问题按钮
- 底部：文本输入框 + 发送按钮

**推荐问题列表**:

| 问题 | 预期行为 |
|------|---------|
| 📋 介绍我的背景 | `search_resume(section=all)` |
| 💡 我有哪些技能 | `search_resume(section=skills)` |
| 💼 我的工作经历 | `search_resume(section=experience)` |
| 🎓 教育背景 | `search_resume(section=education)` |
| 🚀 我的项目 | `search_resume(section=projects)` |
| 🎯 我适合什么岗位 | 综合检索 + 分析 |
| 📄 帮我写求职信 | 检索简历 + 生成 |

### 5.3 SSE 流式聊天 API

```http
POST /api/resume/chat
Content-Type: application/json

{
  "question": "介绍我的工作经历",
  "sessionId": "abc123"
}

→ 200 text/event-stream
event: token
data: "..."

event: done
data: "完整回答"
```

---

## 6. 服务端修改

### `src/server/index.ts`

```typescript
// 新增参数：executor
export function createRagServer(
  store: RagVectorStore,
  port?: number,
  executor?: AgentExecutor,       // 新增
  resumeStore?: ResumeStore,      // 新增
  resumeData?: ResumeData         // 新增
)
```

**新增路由**:

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/resume` | serve `resume.html` |
| GET | `/resume/chat` | serve `resume-chat.html` |
| GET | `/api/resume` | 返回完整 ResumeData JSON |
| POST | `/api/resume/chat` | SSE 流式问答 |

### `src/index.ts`

```typescript
// 新增初始化
const resumeStore = new ResumeStore("navigate.db", embeddings);
const resumeParser = new ResumeParser();
const resumeData = resumeParser.parseFile("resume.md");
await resumeStore.import(resumeData, rawMd);

// 创建工具
const resumeTool = new ResumeSearchTool(resumeStore);
const allTools = [...createTools(), ragTool, resumeTool];

// 更新 prompt
const resumeSummary = resumeStore.getSummary();
const systemPrompt = buildSystemPrompt(resumeSummary);

// 传给 server
createRagServer(ragStore, 3001, executor, resumeStore, resumeData);
```

---

## 7. 启动流程

```
1. src/index.ts 启动
2. 读取 resume.md → 计算 MD5 hash
3. ResumeParser 解析 → ResumeData
4. ResumeStore 检查 hash 变更
   ├── 未变更 → 跳过
   └── 已变更 → 重新索引 embeddings + 创建新版本
5. 创建 ResumeSearchTool
6. 创建 Agent Executor (含所有工具)
7. Build System Prompt (注入简历摘要)
8. Express 服务器启动
   ├── /            → RAG 文档管理
   ├── /resume      → 简历展示页
   ├── /resume/chat → 简历问答页
   └── /api/resume/* → JSON API + SSE Chat
```

---

## 8. 文件变更清单

### 新增文件（6个）

| 文件 | 说明 |
|------|------|
| `src/resume/types.ts` | ResumeData 接口定义 |
| `src/resume/parser.ts` | Markdown → ResumeData 解析器 |
| `src/resume/store.ts` | SQLite 持久化 + 语义搜索 |
| `src/resume/search-tool.ts` | search_resume 工具 |
| `src/server/public/resume.html` | 简历展示页 |
| `src/server/public/resume-chat.html` | 简历问答页 |

### 修改文件（4个）

| 文件 | 改动 |
|------|------|
| `src/server/index.ts` | 新增 resume 路由 + executor/resumeStore 参数 |
| `src/agent/prompt.ts` | 支持注入简历摘要 |
| `src/index.ts` | ResumeStore 初始化 + 传给 server |
| `src/server/public/index.html` | 导航栏加「简历」链接 |

---

## 9. 边界情况与错误处理

| 场景 | 处理方式 |
|------|---------|
| `resume.md` 不存在 | 启动时 warning，跳过简历加载 |
| `resume.md` 格式错误 | Parser 抛具体错误 + 行号，应用继续运行 |
| SQLite 写入失败 | store.import() catch → console.error 不崩溃 |
| Embedding API 不可用 | store.search() 返回空数组 + 降级为关键词匹配（空格分词） |
| SSE 连接断开 | 前端 detect `onerror` → 显示"连接中断，请重试" |
| 空查询 | 前端禁用空输入提交 |
| 并发请求 | 每个 sessionId 独立处理，互不干扰 |
| 长对话历史 | session 存储上限 50 条消息，超过则截断前半 |

---

## 10. 设计评审要点

1. ResumeStore 的 SQLite embedding 相似度搜索性能是否达标？→ 简历数据量小（<100 chunks），全量加载到内存对比可接受
2. SSE vs WebSocket 是否足够？→ SSE 单向流足够，前端不需要发流
3. resume.md 如何维护？→ 用户手动编辑，重启 agent 时自动检测变更
4. HTML 页面是否需要外部资源？→ 纯内联 CSS/JS，不依赖 CDN，离线可用
