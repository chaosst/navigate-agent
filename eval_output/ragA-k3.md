# RAG 评估报告

- 生成时间：2026-09-17T06:40:08.453Z
- 样本数：12（失败 1）
- 检索 top-k：3

## 指标汇总

| 指标 | mean | min | max | 有效样本 |
|---|---|---|---|---|
| hitRate@k（找没找到） | 0.545 | 0.000 | 1.000 | 11 |
| MRR@k（首个相关排名） | 0.545 | 0.000 | 1.000 | 11 |
| nDCG@k（排序质量） | 0.489 | 0.000 | 1.000 | 11 |
| contextPrecision@k（检索精度） | 0.545 | 0.000 | 1.000 | 11 |
| contextRecall（召回） | 0.515 | 0.000 | 1.000 | 11 |
| faithfulness（忠实度） | 0.884 | 0.600 | 1.000 | 11 |
| answerRelevancy（相关性） | 0.636 | 0.000 | 1.000 | 11 |

## 样本明细

### [doc-01] navigate 的 Core Agent（Iter 1）设计里，Agent Loop 用什么框架实现？默认最大迭代次数是多少？

- 检索命中：2/2
- contextKeys: `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：在 navigate 的 **Core Agent（Iter 1）** 设计中，**Agent Loop 使用 LangChain.js 实现**，具体为：

- 基于 **LangChain.js** 的 **AgentExecutor + OpenAIToolsAgent / OpenAI tools agent**
- Agent Loop 采用 **ReAct 模式**
- 在 `loop.ts` 中创建 `OpenAIToolsAgent + AgentExecutor`，并配置 streaming、max iterations、early stopping

**默认最大迭代次数：...

### [doc-02] navigate 的 Tools 层内置了哪几个工具？它们用什么 LangChain 类定义？

- 检索命中：0/1
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.625；answerRelevancy（相关性）=0.500

- 答案：根据提供的上下文，Navigate Agent 的 Tools 层内置工具信息如下：

- **已知内置工具**：`search_documents`
  - 用途：Agent 通过该工具直接检索 RAG 索引中的文档（来自 Wiki 知识库）。

- **LangChain 类定义**：
  - 上下文中提到，OpenCode Skill 系统支持通过 YAML 文件定义可复用技能，并在运行时动态加载为 Agent 的 `StructuredTool`。
  - 但上下文**没有明确说明** `search_documents` 或其他 Tools 层内置工具具体使用哪个 LangChain...

### [doc-03] navigate 一轮对话的数据流分几步？其中工具执行失败、LLM 调用超时分别如何处理？

- 检索命中：1/1
- contextKeys: `89c8743c-5a3c-4293-b5f1-6d383f2b786c:2`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=0.613；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=0.900；answerRelevancy（相关性）=1.000

- 答案：### navigate 一轮对话的数据流

共 **5 步**：

1. 用户通过 TUI 输入 prompt  
2. AgentExecutor 接收 prompt + 历史记录  
3. LLM 返回 tool_call 或最终回复  
4. 若为 tool_call：执行对应工具 → 结果传回 LLM → 继续循环  
5. 若为最终回复：流式渲染到 TUI，等待下一轮用户输入  

### 错误处理

- **工具执行失败**：错误信息作为 observation 传回 LLM，让 agent 自行决定重试或给出回复。  
- **LLM 调用超时**：重试 2 次后提示用户。

### [doc-04] navigate Core Agent 实施计划的 Global Constraints 里，对 Node.js 版本、模块解析方式和工具基类分别提了什么要求？

- 检索命中：0/2
- contextKeys: `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据当前 RAG 检索到的上下文，**没有找到**“Core Agent 实施计划的 Global Constraints”这一部分内容，因此无法提取其中对 Node.js 版本、模块解析方式和工具基类的要求。

现有上下文仅包含《Core Agent - Iter 1 设计文档》的内容，其中与问题相关的信息为：

- **Node.js**：技术栈中写明使用 `TypeScript (Node.js)`，但未给出具体的 Node.js 版本要求。
- **模块解析方式**：上下文中未提及 ESM、CommonJS 或其他模块解析配置。
- **工具基类**：仅提到 Tools Layer（R...

### [doc-05] navigate 的 Memory 层（Iter 2）用什么做持久化？向量库和 Embedding 各选了什么？

- 检索命中：1/2
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:0`, `8ebcfb03-b533-4ed5-8f87-2389e934ba39:1`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据设计文档，**Memory 层（Iter 2）** 的技术选型如下：

| 层 | 选择 |
|---|---|
| 持久化存储 | **better-sqlite3**（嵌入式 SQLite） |
| 向量库 | **@langchain/community + MemoryVectorStore** |
| Embedding | **OpenAI text-embedding-3-small** |
| 记忆管理 | 自定义 **AgentMemory** 封装 |

具体说明：

- **持久化**：使用 `better-sqlite3` 做持久化存储，通过 `SqliteStor...

### [doc-06] navigate 的 RAG 引擎（Iter 3）用什么做文本分割和向量库？对外暴露了哪些 API 端点？

- 检索命中：1/2
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:1`, `8ebcfb03-b533-4ed5-8f87-2389e934ba39:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=0.917；answerRelevancy（相关性）=1.000

- 答案：navigate 的 RAG 引擎（Iter 3）中：

- **文本分割**：使用 `RecursiveCharacterTextSplitter`
- **向量库**：使用 `MemoryVectorStore`（文件级持久化）

对外暴露的 API 端点如下：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | 上传文档 |
| GET | `/api/documents` | 文档列表 |
| DELETE | `/api/documents/:id` | 删除文档 |
| POST | `/api/query` | RAG...

### [doc-07] navigate 的 AgentMemory facade（src/memory/index.ts）组合了哪些存储？暴露了哪些方法？

- 检索命中：0/1
- contextKeys: `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.900；answerRelevancy（相关性）=0.000

- 答案：# 关于 AgentMemory facade 的问题

根据当前 RAG 检索到的上下文，**无法回答该问题**。

## 检索结果分析

检索到的上下文是一份 **《Resume RAG — 简历展示与问答系统》设计稿（v1.0，2026-07-07）**，其内容主要涵盖：

- **系统概述**：利用 RAG 技术实现个人简历的展示与智能问答
- **整体架构**：`resume.md` → `ResumeParser` → `ResumeData` → `ResumeStore`（SQLite 持久化）
- **交互方式**：Agent CLI 对话、Web 简历展示页、Web 简历问...

### [doc-08] navigate 的 Skill 系统支持哪几种 action 类型？各自的实现方式是什么？

- 检索命中：0/1
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据当前提供的 RAG 检索上下文，**无法确定 navigate 的 Skill 系统支持哪几种 action 类型及其实现方式**。

上下文中关于 OpenCode Skill 系统的信息仅有概述级描述：

> **OpenCode Skill 系统** — 支持通过 YAML 文件定义可复用的技能（Skills），在运行时动态加载为 Agent 的 `StructuredTool`

除此之外，上下文没有展开说明：

- Skill 系统具体支持哪些 `action` 类型；
- 每种 `action` 类型的定义方式；
- 每种 `action` 类型的运行时实现方式。

因此，基于...

### [doc-09] 自建 Wiki 迁到 Wiki.js 后，Wiki.js 跑在哪个端口？与原应用怎么集成？RAG 同步靠什么触发？

- 检索命中：0/2
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:4`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.667；faithfulness（忠实度）=0.600；answerRelevancy（相关性）=0.500

- 答案：根据提供的 RAG 上下文，回答如下：

## Wiki.js 端口
上下文中未明确说明 Wiki.js 自身运行的端口。  
但可以确定原应用（接收 Webhook 的 Navigate App）运行在 **3001 端口**，因为 Wiki.js 触发 Webhook 的目标地址是：

```
http://localhost:3001/api/wiki-sync
```

## 与原应用集成方式
Wiki.js 通过 **Webhook** 与原应用集成，具体流程：

1. 用户编辑/创建/删除 Wiki 页面。
2. Wiki.js 将内容保存到 SQLite。
3. Wiki.js ...

### [doc-10] Wiki.js 向 RAG 同步时，page:created / page:updated / page:deleted 三种事件分别怎么处理？Webhook 地址与 Payload 是什么？

- 检索命中：1/2
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:4`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=0.850；answerRelevancy（相关性）=1.000

- 答案：## Wiki.js 向 RAG 同步机制

### 整体流程

用户编辑/创建/删除 Wiki 页面后，Wiki.js 会先保存到 SQLite，然后触发 Webhook POST，由 Navigate App 接收并处理同步。

### Webhook 地址与 Payload

- **Webhook 地址**：`http://localhost:3001/api/wiki-sync`
- **Payload**：`{ event, pageId, slug, title, ... }`

### 三种事件的处理方式

- **`page:created`**
  - 通过 GraphQL...

### [doc-11] navigate 架构 UML 里，整体架构概览包含哪几个子系统分组？search_documents 工具最终调用的是哪个类？

- 检索命中：2/2
- contextKeys: `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=0.765；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.938；answerRelevancy（相关性）=1.000

- 答案：根据提供的 Navigate Agent 架构 UML 图，相关信息如下：

## 1. 整体架构概览包含的子系统分组

整体架构概览中包含以下 5 个子系统分组（subgraph）：

- **配置**
- **入口**
- **Agent 引擎**
- **工具层 (StructuredTool)**
- **MCP**

## 2. `search_documents` 工具对应的类

在“工具层 (StructuredTool)”分组中，`search_documents` 对应的节点为：

```mermaid
RAG_TOOL["RagSearchTool (search_docu...

### [doc-12] 简历问答（Resume RAG）里 ResumeStore 的持久化方案与通用 RAG 有何不同？简历各章节的分块粒度是怎么定的？（⚠️ 失败）

- error: 402 Insufficient Balance
