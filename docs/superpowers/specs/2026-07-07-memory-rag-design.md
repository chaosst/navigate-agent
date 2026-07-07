---
title: Memory + RAG - Iter 2 & 3 设计文档
date: 2026-07-07
status: draft
---

# Memory (Iter 2) + RAG (Iter 3) 设计

## Iter 2: Memory

基于 better-sqlite3 + LangChain 构建记忆层，支持会话持久化与向量记忆检索。

### 技术栈

| 层 | 选择 |
|---|---|
| 持久化存储 | better-sqlite3（嵌入式 SQLite） |
| 向量库 | @langchain/community + MemoryVectorStore |
| Embedding | OpenAI text-embedding-3-small |
| 记忆管理 | 自定义 AgentMemory 封装 |

### 架构

`
Agent Loop
    | serialize / deserialize
AgentMemory
    |--- SqliteStore      ← 会话历史 CRUD
    |--- VectorMemory     ← 向量记忆 检索/存储
`

### 数据流

1. 每次对话结束 → 写入 SQLite（会话 ID + 消息对）
2. 异步生成摘要 → 存入向量库
3. 新对话 → 检索相关记忆 → 注入 system prompt

### 存储结构

SQLite 表：
- sessions — id, name, created_at, updated_at
- messages — id, session_id, role, content, created_at

向量库：每个会话一个向量存储文件，存储对话摘要嵌入。

## Iter 3: RAG

基于 LangChain 文档加载器 + 向量检索构建 RAG 引擎，附带独立 HTML 上传管理页。

### 技术栈

| 层 | 选择 |
|---|---|
| 文档解析 | @langchain/community document loaders |
| 文本分割 | RecursiveCharacterTextSplitter |
| 向量库 | MemoryVectorStore（文件级持久化） |
| Embedding | OpenAI text-embedding-3-small |
| 上传页面 | 纯 HTML + JS |
| 后端 API | Express.js |

### 架构

`
TUI Agent → RAG 检索工具
RAG Engine
    |-- loader.ts       ← 文档加载 + 分割
    |-- vectorstore.ts  ← 向量库 CRUD
    |-- retriever.ts    ← 检索 + 上下文拼接

Web Server
    |-- index.ts        ← Express API
    |-- public/
        |-- index.html  ← 上传管理页面
`

### API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/upload | 上传文档 |
| GET | /api/documents | 文档列表 |
| DELETE | /api/documents/:id | 删除文档 |
| POST | /api/query | RAG 查询测试 |
