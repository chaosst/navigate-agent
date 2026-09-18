# RAG 评估报告

- 生成时间：2026-09-17T07:45:41.525Z
- 样本数：12（失败 0）
- 检索 top-k：3

## 指标汇总

| 指标 | mean | min | max | 有效样本 |
|---|---|---|---|---|
| hitRate@k（找没找到） | 0.583 | 0.000 | 1.000 | 12 |
| MRR@k（首个相关排名） | 0.528 | 0.000 | 1.000 | 12 |
| nDCG@k（排序质量） | 0.474 | 0.000 | 1.000 | 12 |
| contextPrecision@k（检索精度） | 0.528 | 0.000 | 1.000 | 12 |
| contextRecall（召回） | 0.556 | 0.000 | 1.000 | 12 |
| faithfulness（忠实度） | 0.910 | 0.571 | 1.000 | 12 |
| answerRelevancy（相关性） | 0.708 | 0.000 | 1.000 | 12 |

## 样本明细

### [doc-01] navigate 的 Core Agent（Iter 1）设计里，Agent Loop 用什么框架实现？默认最大迭代次数是多少？

- 检索命中：2/3
- contextKeys: `89c8743c-5a3c-4293-b5f1-6d383f2b786c:0`, `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:2`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：在 navigate 的 Core Agent（Iter 1）设计里：

- **Agent Loop 的实现框架**：使用 **LangChain.js**，具体是基于 **AgentExecutor + OpenAI tools agent** 实现（在 `loop.ts` 中创建 `OpenAIToolsAgent` 和 `AgentExecutor`）。
- **默认最大迭代次数**：**25** 次（`max iterations` 默认配置为 25）。

### [doc-02] navigate 的 Tools 层内置了哪几个工具？它们用什么 LangChain 类定义？

- 检索命中：0/3
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.333；faithfulness（忠实度）=0.900；answerRelevancy（相关性）=1.000

- 答案：根据检索到的架构文档，Navigate Agent 的 **Tools 层**在 UML 图中归类为 `StructuredTool`（即整体使用 LangChain 的 `StructuredTool` 体系来定义），其内置工具按分组如下：

## 内置工具分组

| 分组 | 工具 | 说明 |
| --- | --- | --- |
| **FILE_TOOLS** | `Shell` / `Read` / `Write` / `Edit` | 文件与命令操作工具 |
| **SEARCH_TOOLS** | `ListFiles` / `SearchFiles` | 文件检索类工具 |...

### [doc-03] navigate 一轮对话的数据流分几步？其中工具执行失败、LLM 调用超时分别如何处理？

- 检索命中：1/3
- contextKeys: `89c8743c-5a3c-4293-b5f1-6d383f2b786c:2`, `5392e643-9810-9013-e235-4ac6816894b5:0`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=0.613；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据检索到的上下文（context1），navigate 一轮对话的数据流共 **5 步**：

## 数据流
1. 用户通过 TUI 输入 prompt  
2. AgentExecutor 接收 prompt + 历史记录  
3. LLM 返回 tool_call 或最终回复  
4. 若为 tool_call：执行对应工具 → 结果传回 LLM → 继续循环  
5. 若为最终回复：流式渲染到 TUI，等待下一轮用户输入  

## 错误处理
- **工具执行失败**：错误信息作为 observation 传回 LLM，让 agent 自行决定重试或给出回复。  
- **LLM 调用...

### [doc-04] navigate Core Agent 实施计划的 Global Constraints 里，对 Node.js 版本、模块解析方式和工具基类分别提了什么要求？

- 检索命中：0/3
- contextKeys: `89c8743c-5a3c-4293-b5f1-6d383f2b786c:0`, `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.333；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：抱歉，根据当前检索到的 RAG 上下文，**无法回答**该问题。

## 原因说明

检索到的上下文包括：

| 来源 | 内容概要 |
|---|---|
| Core Agent - Iter 1 设计文档 | 技术栈（TypeScript/Node.js、LangChain.js、OpenAI、ink）、架构分层、组件说明（Agent Loop、Tools、langchain.ts 等） |
| Navigate Agent 架构 UML 图 | 整体架构图（配置、入口、Agent 引擎、工具层、MCP 等模块） |

这两份材料中**均未出现**以下内容：

- ❌ **Global ...

### [doc-05] navigate 的 Memory 层（Iter 2）用什么做持久化？向量库和 Embedding 各选了什么？

- 检索命中：1/3
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:0`, `7403d61a-7cc1-a9af-9685-f270947ef2dc:0`, `80a0c3cc-5ced-4ae1-80f8-54da842b0bd3:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：navigate 的 **Memory 层（Iter 2）** 技术选型如下：

| 层 | 选择 |
|---|---|
| 持久化存储 | **better-sqlite3**（嵌入式 SQLite） |
| 向量库 | **@langchain/community + MemoryVectorStore** |
| Embedding | **OpenAI text-embedding-3-small** |
| 记忆管理 | 自定义 **AgentMemory** 封装 |

补充说明：

- 持久化使用 **better-sqlite3**，并采用 **WAL mode**、bett...

### [doc-06] navigate 的 RAG 引擎（Iter 3）用什么做文本分割和向量库？对外暴露了哪些 API 端点？

- 检索命中：1/3
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:1`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：## Navigate RAG 引擎（Iter 3）

### 文本分割与向量库
- **文本分割**：使用 `RecursiveCharacterTextSplitter`。
- **向量库**：使用 `MemoryVectorStore`，并支持文件级持久化。

### 对外暴露的 API 端点
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | 上传文档 |
| GET | `/api/documents` | 文档列表 |
| DELETE | `/api/documents/:id` | 删除文档 |
| POST | `/...

### [doc-07] navigate 的 AgentMemory facade（src/memory/index.ts）组合了哪些存储？暴露了哪些方法？

- 检索命中：0/3
- contextKeys: `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据当前提供的 RAG 检索上下文，**没有找到关于 `AgentMemory` facade（`src/memory/index.ts`）的任何信息**，因此无法准确回答它组合了哪些存储、暴露了哪些方法。

现有上下文主要涉及：

- **Resume RAG 设计**：`ResumeParser`、`ResumeStore`、`ResumeData`、`search_resume` 等；
- **Navigate Agent 架构 UML**：入口、Agent 引擎、工具层、MCP 管理等。

其中并未出现：

- `AgentMemory`
- `src/memory/index.ts`...

### [doc-08] navigate 的 Skill 系统支持哪几种 action 类型？各自的实现方式是什么？

- 检索命中：0/3
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.571；answerRelevancy（相关性）=0.000

- 答案：根据提供的上下文，**无法确定 navigate 的 Skill 系统具体支持哪几种 action 类型**，因为相关文档中未列出 action 类型及其实现细节。

上下文中仅包含以下关于 Skill 系统的信息：

- OpenCode Skill 系统支持通过 YAML 文件定义可复用的技能（Skills），并在运行时动态加载为 Agent 的 `StructuredTool`。
- 在整体架构图中，工具层包含 `SKILL_TOOLS["SkillTool (来自 YAML)"]`，表明技能最终以 `SkillTool` 的形式接入 Agent，但未进一步说明其内部 action 类型...

### [doc-09] 自建 Wiki 迁到 Wiki.js 后，Wiki.js 跑在哪个端口？与原应用怎么集成？RAG 同步靠什么触发？

- 检索命中：0/3
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`, `5392e643-9810-9013-e235-4ac6816894b5:7`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:7`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.850；answerRelevancy（相关性）=1.000

- 答案：## Wiki.js 端口

给定上下文中**没有明确说明 Wiki.js 自身监听的端口**。唯一出现的端口是 `3001`，但它对应的是 Wiki.js 触发 Webhook 时 POST 到的地址：

```text
http://localhost:3001/api/wiki-sync
```

该 Webhook 由 Navigate App 接收，因此 `3001` 是原应用/Navigate App 的 Webhook 接收端口，不能据此确认 Wiki.js 跑在 `3001`。

## 与原应用的集成方式

集成方式是 Wiki.js 通过 Webhook 通知 Navigat...

### [doc-10] Wiki.js 向 RAG 同步时，page:created / page:updated / page:deleted 三种事件分别怎么处理？Webhook 地址与 Payload 是什么？

- 检索命中：1/3
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:4`, `f037973e-08db-4223-9e5e-6479b6cd315d:1`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=0.850；answerRelevancy（相关性）=1.000

- 答案：# Wiki.js 向 RAG 同步：事件处理与 Webhook

## 整体流程

用户编辑/创建/删除 Wiki 页面后，Wiki.js 会保存到 SQLite，并触发 Webhook POST：

```text
用户编辑/创建/删除 Wiki 页面
        │
        ▼
Wiki.js 保存到 SQLite
        │
        ├── 触发 Webhook POST
        │    URL: http://localhost:3001/api/wiki-sync
        │    Payload: { event, pageId, s...

### [doc-11] navigate 架构 UML 里，整体架构概览包含哪几个子系统分组？search_documents 工具最终调用的是哪个类？

- 检索命中：2/3
- contextKeys: `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=0.765；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=0.333；faithfulness（忠实度）=0.800；answerRelevancy（相关性）=1.000

- 答案：## 整体架构概览包含的子系统分组

在 Navigate Agent 架构 UML 图中，整体架构概览包含以下 **5 个**子系统分组（subgraph）：

| 序号 | 子系统分组 | 主要节点 |
|------|-----------|----------|
| 1 | **配置** | `.env / MCP_SERVERS`、`skills/*.skill.yaml` |
| 2 | **入口** | `src/index.ts main()`、`src/config/index.ts loadConfig()` |
| 3 | **Agent 引擎** | `ChatOpen...

### [doc-12] 简历问答（Resume RAG）里 ResumeStore 的持久化方案与通用 RAG 有何不同？简历各章节的分块粒度是怎么定的？

- 检索命中：1/3
- contextKeys: `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:9`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:1`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=0.333；nDCG@k（排序质量）=0.307；contextPrecision@k（检索精度）=0.333；contextRecall（召回）=0.667；faithfulness（忠实度）=0.944；answerRelevancy（相关性）=0.500

- 答案：## ResumeStore 的持久化方案与通用 RAG 的不同

根据上下文，ResumeStore 与通用 RAG 的持久化方案主要区别如下：

- **通用 RAG**：使用 `MemoryVectorStore`，属于内存向量库，数据依赖内存，未体现独立持久化。
- **ResumeStore**：使用 **SQLite 独立持久化**，与通用 RAG 解耦。
  - 存储 **chunks + base64 embeddings + 元数据（所属章节）**。
  - 同时将结构化 `ResumeData` 以 **JSON 形式存入 SQLite**。
  - 具备 **版本管理**...
