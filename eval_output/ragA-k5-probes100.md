# RAG 评估报告

- 生成时间：2026-09-17T07:40:32.972Z
- 样本数：12（失败 0）
- 检索 top-k：5

## 指标汇总

| 指标 | mean | min | max | 有效样本 |
|---|---|---|---|---|
| hitRate@k（找没找到） | 0.750 | 0.000 | 1.000 | 12 |
| MRR@k（首个相关排名） | 0.561 | 0.000 | 1.000 | 12 |
| nDCG@k（排序质量） | 0.496 | 0.000 | 1.000 | 12 |
| contextPrecision@k（检索精度） | 0.561 | 0.000 | 1.000 | 12 |
| contextRecall（召回） | 0.722 | 0.000 | 1.000 | 12 |
| faithfulness（忠实度） | 0.937 | 0.600 | 1.000 | 12 |
| answerRelevancy（相关性） | 0.833 | 0.000 | 1.000 | 12 |

## 样本明细

### [doc-01] navigate 的 Core Agent（Iter 1）设计里，Agent Loop 用什么框架实现？默认最大迭代次数是多少？

- 检索命中：2/5
- contextKeys: `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:0`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:2`, `73c09568-fcac-4d36-a74f-380c8982f997:0`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据 Core Agent - Iter 1 设计文档：

## Agent Loop 实现框架

Agent Loop 使用 **LangChain.js** 实现，具体为 **AgentExecutor + OpenAI tools agent**（ReAct 模式）。

在 `src/agent/loop.ts` 中创建 `OpenAIToolsAgent + AgentExecutor`，并配置：
- streaming
- max iterations
- early stopping

## 默认最大迭代次数

默认最大迭代次数为 **25**。

> 相关说明：当超出 max i...

### [doc-02] navigate 的 Tools 层内置了哪几个工具？它们用什么 LangChain 类定义？

- 检索命中：1/5
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `f037973e-08db-4223-9e5e-6479b6cd315d:1`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:1`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=0.200；nDCG@k（排序质量）=0.237；contextPrecision@k（检索精度）=0.200；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：## Navigate Tools 层内置工具

根据文档，Navigate 的 Tools 层位于 `src/tools/`，通过 `registry.ts` 的 `createTools(config)` 注册，按需启用/禁用工具集。内置工具（参考 Claude Code）包括：

- `execute_command`：执行 shell 命令，返回 stdout/stderr/exit code
- `read_file`：读取文件内容（支持行范围）
- `write_file`：写入或创建文件
- `edit_file`：精确定位替换/插入（search-and-replace 模式）...

### [doc-03] navigate 一轮对话的数据流分几步？其中工具执行失败、LLM 调用超时分别如何处理？

- 检索命中：1/5
- contextKeys: `89c8743c-5a3c-4293-b5f1-6d383f2b786c:2`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:14`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=0.613；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据检索到的上下文，navigate 一轮对话的数据流分为 **5 步**：

1. 用户通过 TUI 输入 prompt
2. AgentExecutor 接收 prompt + 历史记录
3. LLM 返回 tool_call 或最终回复
4. 若为 tool_call：执行对应工具 → 结果传回 LLM → 继续循环
5. 若为最终回复：流式渲染到 TUI，等待下一轮用户输入

其中两类异常的处理方式如下：

| 异常情况 | 处理方式 |
|---|---|
| 工具执行失败 | 将错误信息作为 observation 传回 LLM，让 agent 自行决定重试或给出回复 |
| LL...

### [doc-04] navigate Core Agent 实施计划的 Global Constraints 里，对 Node.js 版本、模块解析方式和工具基类分别提了什么要求？

- 检索命中：0/5
- contextKeys: `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.800；answerRelevancy（相关性）=0.000

- 答案：根据提供的 RAG 检索结果，**未找到**关于“navigate Core Agent 实施计划的 Global Constraints”中对 Node.js 版本、模块解析方式和工具基类提出要求的具体内容。现有上下文主要涉及 Core Agent 的迭代设计、架构 UML 图以及 Wiki 知识库设计，并未涵盖“实施计划”或“Global Constraints”部分。

因此，无法依据当前上下文回答该问题。建议查阅 Core Agent 实施计划文档中的 Global Constraints 章节以获取准确信息。

### [doc-05] navigate 的 Memory 层（Iter 2）用什么做持久化？向量库和 Embedding 各选了什么？

- 检索命中：1/5
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:0`, `7403d61a-7cc1-a9af-9685-f270947ef2dc:0`, `80a0c3cc-5ced-4ae1-80f8-54da842b0bd3:0`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:2`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=0.944；answerRelevancy（相关性）=1.000

- 答案：# Navigate Memory 层（Iter 2）技术选型

根据设计文档，Iter 2 的 Memory 层选型如下：

| 层 | 选择 |
|---|---|
| 持久化存储 | **better-sqlite3**（嵌入式 SQLite） |
| 向量库 | **@langchain/community + MemoryVectorStore** |
| Embedding | **OpenAI text-embedding-3-small** |
| 记忆管理 | 自定义 AgentMemory 封装 |

## 补充说明

- 持久化使用 **better-sqlite3 同步...

### [doc-06] navigate 的 RAG 引擎（Iter 3）用什么做文本分割和向量库？对外暴露了哪些 API 端点？

- 检索命中：1/5
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:1`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`, `f037973e-08db-4223-9e5e-6479b6cd315d:1`, `8ebcfb03-b533-4ed5-8f87-2389e934ba39:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据上下文，Navigate 的 RAG 引擎（Iter 3）相关技术选型与 API 如下：

## 文本分割与向量库

| 层 | 选择 |
|---|---|
| 文档解析 | `@langchain/community document loaders` |
| 文本分割 | `RecursiveCharacterTextSplitter` |
| 向量库 | `MemoryVectorStore`（文件级持久化） |
| Embedding | `OpenAI text-embedding-3-small` |

因此：

- **文本分割**：使用 `RecursiveCharact...

### [doc-07] navigate 的 AgentMemory facade（src/memory/index.ts）组合了哪些存储？暴露了哪些方法？

- 检索命中：1/5
- contextKeys: `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`, `80a0c3cc-5ced-4ae1-80f8-54da842b0bd3:1`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=0.200；nDCG@k（排序质量）=0.237；contextPrecision@k（检索精度）=0.200；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：# AgentMemory Facade（src/memory/index.ts）

## 组合的存储

`AgentMemory` facade 是一个 Wrapper，组合了以下两种存储：

- **SqliteStore** — SQLite 持久化存储
- **VectorMemory** — 向量记忆存储

> 注：其中 `VectorMemory`（位于 `src/memory/vector-memory.ts`）本身由 `OpenAIEmbeddings`（`text-embedding-3-small`）+ `MemoryVectorStore` 组成。

## 暴露的方法

...

### [doc-08] navigate 的 Skill 系统支持哪几种 action 类型？各自的实现方式是什么？

- 检索命中：0/5
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`, `5392e643-9810-9013-e235-4ac6816894b5:9`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.333；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：Navigate Agent 的 Skill 系统在 `SkillTool._call()` 中根据 `action.type` 分发，目前支持以下 4 种 action 类型：

| action 类型 | 实现方式 |
|---|---|
| `template` | 调用 `renderTemplate()` 替换参数 |
| `shell` | 使用 `execSync()` 执行 |
| `http` | 使用 `fetch()` 请求 |
| `code` | 使用 `AsyncFunction()` 执行 |

整体加载与执行流程为：

1. `SkillRegistry.loa...

### [doc-09] 自建 Wiki 迁到 Wiki.js 后，Wiki.js 跑在哪个端口？与原应用怎么集成？RAG 同步靠什么触发？

- 检索命中：0/5
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`, `5392e643-9810-9013-e235-4ac6816894b5:7`, `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:7`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:4`, `f037973e-08db-4223-9e5e-6479b6cd315d:13`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.333；faithfulness（忠实度）=0.600；answerRelevancy（相关性）=0.500

- 答案：根据给定上下文，可以确定如下：

## 端口

- **原应用/Navigate App 接收 Wiki.js Webhook 的端口是 `3001`**：  
  `http://localhost:3001/api/wiki-sync`
- **Wiki.js 自身监听端口在上下文中没有明确说明**，因此无法从这些材料确定 Wiki.js 具体跑在哪个端口。

也就是说，`3001` 是原应用侧接收同步请求的端口，不是上下文中明确给出的 Wiki.js 端口。

## 与原应用的集成方式

- Wiki.js 保存页面到 SQLite 后，会触发 Webhook POST 到原应用：
  ...

### [doc-10] Wiki.js 向 RAG 同步时，page:created / page:updated / page:deleted 三种事件分别怎么处理？Webhook 地址与 Payload 是什么？

- 检索命中：1/5
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:4`, `f037973e-08db-4223-9e5e-6479b6cd315d:1`, `f037973e-08db-4223-9e5e-6479b6cd315d:13`, `8ebcfb03-b533-4ed5-8f87-2389e934ba39:1`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：## Wiki.js 向 RAG 同步的事件处理与 Webhook 配置

Wiki.js 在用户编辑、创建或删除页面后，会触发 Webhook POST 请求到 Navigate App，由同步服务负责将变更同步到 RAG 向量库。

### Webhook 地址与 Payload

- **Webhook 地址**：`http://localhost:3001/api/wiki-sync`
- **Payload 示例**：`{ event, pageId, slug, title, ... }`

### 三种事件的处理方式

| 事件 | 处理流程 |
|------|--------...

### [doc-11] navigate 架构 UML 里，整体架构概览包含哪几个子系统分组？search_documents 工具最终调用的是哪个类？

- 检索命中：2/5
- contextKeys: `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`, `a6c0b815-9d96-4a7b-a62b-135a999f6c50:0`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:7`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=0.553；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=0.333；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据提供的 RAG 检索上下文，回答如下：

## 1. 整体架构概览包含的子系统分组

在 Navigate Agent 架构 UML 的“整体架构概览”中，`graph TB` 下的 `subgraph` 分组共有 **5 个**，分别为：

- **配置**
- **入口**
- **Agent 引擎**
- **工具层 (StructuredTool)**
- **MCP**

## 2. search_documents 工具最终调用的类

在“工具层 (StructuredTool)”分组中，`search_documents` 工具被标记为：

```mermaid
RAG_TO...

### [doc-12] 简历问答（Resume RAG）里 ResumeStore 的持久化方案与通用 RAG 有何不同？简历各章节的分块粒度是怎么定的？

- 检索命中：1/5
- contextKeys: `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:9`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:1`, `38d4b4a4-3d26-c940-a8c1-c298c467d245:7`, `f037973e-08db-4223-9e5e-6479b6cd315d:5`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=0.333；nDCG@k（排序质量）=0.307；contextPrecision@k（检索精度）=0.333；contextRecall（召回）=0.667；faithfulness（忠实度）=0.900；answerRelevancy（相关性）=0.500

- 答案：# ResumeStore 持久化方案与通用 RAG 的差异

根据上下文，ResumeStore 与通用 RAG 的主要区别如下：

| 维度 | 通用 RAG | ResumeStore |
|---|---|---|
| 向量存储 | 使用 `MemoryVectorStore`，属于内存向量库 | 使用 SQLite 持久化存储 |
| 是否独立 | - | 独立持久化，与通用 RAG 解耦，不依赖内存向量库 |
| 存储内容 | 上下文未展开 | SQLite 中存储 chunks + base64 embeddings；同时将结构化 `ResumeData` 以 JSON 存入 S...
