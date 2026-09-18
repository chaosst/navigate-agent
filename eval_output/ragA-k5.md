# RAG 评估报告

- 生成时间：2026-09-17T07:16:28.203Z
- 样本数：12（失败 0）
- 检索 top-k：5

## 指标汇总

| 指标 | mean | min | max | 有效样本 |
|---|---|---|---|---|
| hitRate@k（找没找到） | 0.500 | 0.000 | 1.000 | 12 |
| MRR@k（首个相关排名） | 0.500 | 0.000 | 1.000 | 12 |
| nDCG@k（排序质量） | 0.431 | 0.000 | 1.000 | 12 |
| contextPrecision@k（检索精度） | 0.500 | 0.000 | 1.000 | 12 |
| contextRecall（召回） | 0.472 | 0.000 | 1.000 | 12 |
| faithfulness（忠实度） | 0.889 | 0.650 | 1.000 | 12 |
| answerRelevancy（相关性） | 0.667 | 0.000 | 1.000 | 12 |

## 样本明细

### [doc-01] navigate 的 Core Agent（Iter 1）设计里，Agent Loop 用什么框架实现？默认最大迭代次数是多少？

- 检索命中：2/2
- contextKeys: `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据 Core Agent - Iter 1 设计文档：

- **Agent Loop 实现框架**：采用 **LangChain.js**，具体使用 **AgentExecutor + OpenAI tools agent**，并以 ReAct 模式运行。
- **默认最大迭代次数**：**25**。

文档中 `loop.ts` 负责创建 `OpenAIToolsAgent + AgentExecutor`，并配置 streaming、max iterations（默认 25）和 early stopping。

### [doc-02] navigate 的 Tools 层内置了哪几个工具？它们用什么 LangChain 类定义？

- 检索命中：0/1
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.750；answerRelevancy（相关性）=0.500

- 答案：根据提供的上下文，navigate 的 Tools 层内置工具信息如下：

- **`search_documents`**：Agent 通过该工具直接检索 RAG 索引中的文档。

关于它们使用的 LangChain 类定义，上下文中仅提到 OpenCode Skill 系统在运行时动态加载为 Agent 的 **`StructuredTool`**，但并未明确说明 `search_documents` 等内置工具具体使用哪个 LangChain 类定义。因此，无法从当前上下文确定所有内置工具及其对应的 LangChain 类。

### [doc-03] navigate 一轮对话的数据流分几步？其中工具执行失败、LLM 调用超时分别如何处理？

- 检索命中：1/1
- contextKeys: `89c8743c-5a3c-4293-b5f1-6d383f2b786c:2`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=0.613；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据检索上下文，navigate 一轮对话的数据流分为 **5 步**：

1. 用户通过 TUI 输入 prompt
2. AgentExecutor 接收 prompt + 历史记录
3. LLM 返回 tool_call 或最终回复
4. 若为 tool_call：执行对应工具 → 结果传回 LLM → 继续循环
5. 若为最终回复：流式渲染到 TUI，等待下一轮用户输入

错误处理方式如下：

- **工具执行失败**：错误信息作为 observation 传回 LLM，让 agent 自行决定重试或给出回复。
- **LLM 调用超时**：重试 2 次后提示用户。

### [doc-04] navigate Core Agent 实施计划的 Global Constraints 里，对 Node.js 版本、模块解析方式和工具基类分别提了什么要求？

- 检索命中：0/2
- contextKeys: `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`, `89c8743c-5a3c-4293-b5f1-6d383f2b786c:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据提供的 RAG 检索上下文，未找到“Core Agent 实施计划”中“Global Constraints”的相关内容。现有上下文为《Core Agent - Iter 1 设计文档》，其中仅包含技术栈（TypeScript/Node.js、LangChain.js、OpenAI、ink、npm/yarn）和架构说明，**没有提及**对以下三点的具体要求：

- Node.js 版本
- 模块解析方式
- 工具基类

因此，无法依据现有上下文回答该问题。

### [doc-05] navigate 的 Memory 层（Iter 2）用什么做持久化？向量库和 Embedding 各选了什么？

- 检索命中：1/2
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:0`, `8ebcfb03-b533-4ed5-8f87-2389e934ba39:1`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：navigate 的 Memory 层（Iter 2）技术选型如下：

- **持久化存储**：`better-sqlite3`（嵌入式 SQLite）
- **向量库**：`@langchain/community` + `MemoryVectorStore`
- **Embedding**：OpenAI `text-embedding-3-small`

此外，记忆管理使用自定义的 `AgentMemory` 封装，整体基于 better-sqlite3 + LangChain 构建，支持会话持久化与向量记忆检索。

### [doc-06] navigate 的 RAG 引擎（Iter 3）用什么做文本分割和向量库？对外暴露了哪些 API 端点？

- 检索命中：1/2
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:1`, `8ebcfb03-b533-4ed5-8f87-2389e934ba39:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=0.950；answerRelevancy（相关性）=1.000

- 答案：# navigate RAG 引擎（Iter 3）技术说明

## 文本分割与向量库

| 层 | 选择 |
|---|---|
| 文本分割 | **RecursiveCharacterTextSplitter** |
| 向量库 | **MemoryVectorStore**（文件级持久化） |
| Embedding | OpenAI text-embedding-3-small |
| 文档解析 | @langchain/community document loaders |
| 后端 API | Express.js |
| 上传页面 | 纯 HTML + JS |

RAG 引擎...

### [doc-07] navigate 的 AgentMemory facade（src/memory/index.ts）组合了哪些存储？暴露了哪些方法？

- 检索命中：0/1
- contextKeys: `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.750；answerRelevancy（相关性）=0.000

- 答案：根据提供的上下文，未能找到关于 Navigate 项目中 `AgentMemory` facade（`src/memory/index.ts`）的具体信息。上下文仅描述了 Resume RAG 系统的设计，包括 `ResumeParser`、`ResumeStore`（SQLite 持久化）、Agent 的 `search_resume` 工具、Express API 路由以及 Web 页面等，但没有提及 `AgentMemory` facade 组合了哪些存储或暴露了哪些方法。因此无法依据现有上下文回答该问题。

### [doc-08] navigate 的 Skill 系统支持哪几种 action 类型？各自的实现方式是什么？

- 检索命中：0/1
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据当前提供的 RAG 上下文，**无法确定 navigate 的 Skill 系统具体支持哪几种 action 类型，也无法说明各自的实现方式**。

上下文中仅包含《Wiki 知识库 + OpenCode Skill 系统设计文档》的概述部分，其中与 Skill 系统相关的信息只有：

- OpenCode Skill 系统支持通过 **YAML 文件**定义可复用的技能（Skills）。
- 技能在运行时**动态加载为 Agent 的 `StructuredTool`**。

但上下文没有列出 Skill 系统的 action 类型枚举，也没有描述每种 action 的具体实现逻辑。因此...

### [doc-09] 自建 Wiki 迁到 Wiki.js 后，Wiki.js 跑在哪个端口？与原应用怎么集成？RAG 同步靠什么触发？

- 检索命中：0/2
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:4`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.667；faithfulness（忠实度）=0.650；answerRelevancy（相关性）=1.000

- 答案：## 1. Wiki.js 运行端口

根据提供的上下文，**没有明确说明 Wiki.js 自身运行在哪个端口**。

上下文中唯一出现的端口是 Webhook 接收地址：

```text
http://localhost:3001/api/wiki-sync
```

这是原应用（Navigate App）接收 Wiki.js Webhook 的地址，**不是 Wiki.js 自身的监听端口**。因此无法从给定上下文确认 Wiki.js 跑在哪个端口。

## 2. 与原应用怎么集成

集成方式主要包括 Webhook、GraphQL API 和导航入口：

- **Webhook 集成*...

### [doc-10] Wiki.js 向 RAG 同步时，page:created / page:updated / page:deleted 三种事件分别怎么处理？Webhook 地址与 Payload 是什么？

- 检索命中：1/2
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`, `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:4`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=0.800；answerRelevancy（相关性）=1.000

- 答案：## Wiki.js → RAG 同步

Wiki.js 在用户创建/编辑/删除页面后，会先保存到 SQLite，并触发 Webhook POST。

### Webhook 地址与 Payload

- **地址**：`http://localhost:3001/api/wiki-sync`
- **Payload**：`{ event, pageId, slug, title, ... }`

### 三种事件处理方式

- **`page:created`**  
  通过 GraphQL API 获取内容 → 分块 → 注入 RAG。

- **`page:updated`**  
 ...

### [doc-11] navigate 架构 UML 里，整体架构概览包含哪几个子系统分组？search_documents 工具最终调用的是哪个类？

- 检索命中：2/2
- contextKeys: `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=0.553；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据 Navigate Agent 架构 UML 图，整体架构概览包含以下子系统分组：

1. **配置**
2. **入口**
3. **Agent 引擎**
4. **工具层 (StructuredTool)**
5. **MCP**

其中，`search_documents` 工具在工具层中对应的是 `RagSearchTool` 类，因此最终调用的是 **RagSearchTool**。

### [doc-12] 简历问答（Resume RAG）里 ResumeStore 的持久化方案与通用 RAG 有何不同？简历各章节的分块粒度是怎么定的？

- 检索命中：0/1
- contextKeys: `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.765；answerRelevancy（相关性）=0.500

- 答案：## ResumeStore 持久化方案与通用 RAG 的差异

根据当前设计稿，ResumeStore 的持久化方案与通用 RAG 的主要不同在于：

- **使用 SQLite 持久化**，而不是依赖内存向量库。
- 存储内容包括：
  - 文本块 + OpenAI Embeddings + 元数据（所属章节）
  - 结构化 `ResumeData`（JSON 存 SQLite）
  - 版本管理（文件 hash 检测变更）
- 设计目标明确提到：**“简历数据独立持久化存储，不依赖内存向量库”**。

因此，通用 RAG 可能更偏向内存向量库或临时索引，而 ResumeStore 把文...
