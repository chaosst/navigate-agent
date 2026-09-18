# RAG 评估报告

- 生成时间：2026-09-17T07:12:25.750Z
- 样本数：12（失败 0）
- 检索 top-k：1

## 指标汇总

| 指标 | mean | min | max | 有效样本 |
|---|---|---|---|---|
| hitRate@k（找没找到） | 0.500 | 0.000 | 1.000 | 12 |
| MRR@k（首个相关排名） | 0.500 | 0.000 | 1.000 | 12 |
| nDCG@k（排序质量） | 0.500 | 0.000 | 1.000 | 12 |
| contextPrecision@k（检索精度） | 0.500 | 0.000 | 1.000 | 12 |
| contextRecall（召回） | 0.500 | 0.000 | 1.000 | 12 |
| faithfulness（忠实度） | 0.941 | 0.750 | 1.000 | 12 |
| answerRelevancy（相关性） | 0.583 | 0.000 | 1.000 | 12 |

## 样本明细

### [doc-01] navigate 的 Core Agent（Iter 1）设计里，Agent Loop 用什么框架实现？默认最大迭代次数是多少？

- 检索命中：1/1
- contextKeys: `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据 Core Agent - Iter 1 设计文档，Agent Loop 的实现方式如下：

- **框架实现**：使用 **LangChain.js**，具体是 **AgentExecutor + OpenAI tools agent**（ReAct 模式）。
- **默认最大迭代次数**：**25**。

在组件说明中，`loop.ts` 负责创建 `OpenAIToolsAgent` 和 `AgentExecutor`，并配置 streaming、`max iterations（默认 25）` 以及 early stopping。

### [doc-02] navigate 的 Tools 层内置了哪几个工具？它们用什么 LangChain 类定义？

- 检索命中：0/1
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.889；answerRelevancy（相关性）=0.000

- 答案：根据当前提供的 RAG 上下文，**无法完整确定** Navigate Tools 层内置了哪几个工具，也无法确定它们分别使用什么 LangChain 类定义。

上下文中只能确认以下相关信息：

- Wiki 知识库场景中，Agent 通过 `search_documents` 工具直接检索 RAG 索引。
- OpenCode Skill 系统支持通过 YAML 定义可复用技能，并在运行时动态加载为 Agent 的 `StructuredTool`。

因此，就现有上下文而言：

- 能确认的工具名：`search_documents`
- 能确认的 LangChain 类：`Struct...

### [doc-03] navigate 一轮对话的数据流分几步？其中工具执行失败、LLM 调用超时分别如何处理？

- 检索命中：1/1
- contextKeys: `89c8743c-5a3c-4293-b5f1-6d383f2b786c:2`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据上下文，navigate 一轮对话的数据流分为 **5 步**：

1. 用户通过 TUI 输入 prompt
2. AgentExecutor 接收 prompt + 历史记录
3. LLM 返回 tool_call 或最终回复
4. 若为 tool_call：执行对应工具 → 结果传回 LLM → 继续循环
5. 若为最终回复：流式渲染到 TUI，等待下一轮用户输入

错误处理方式如下：

- **工具执行失败**：错误信息作为 observation 传回 LLM，让 agent 自行决定重试或给出回复。
- **LLM 调用超时**：重试 2 次后提示用户。

此外，若超出 max...

### [doc-04] navigate Core Agent 实施计划的 Global Constraints 里，对 Node.js 版本、模块解析方式和工具基类分别提了什么要求？

- 检索命中：0/1
- contextKeys: `0ae92788-b57b-bbf8-a4c6-9a1d02bb1b26:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据当前提供的 RAG 上下文（`Core Agent - Iter 1 设计文档`），**没有检索到 “navigate Core Agent 实施计划” 中的 “Global Constraints” 章节**，因此无法确认它对以下三项的具体要求：

- **Node.js 版本**：上下文中未提及。
- **模块解析方式**：上下文中未提及。
- **工具基类**：上下文中未提及。现有内容仅说明 Tools Layer 由 “Registry + 内置工具” 组成，并在 `types.ts` 中定义 `AgentConfig`、`ToolResult` 等类型，但没有说明工具基类的具体要...

### [doc-05] navigate 的 Memory 层（Iter 2）用什么做持久化？向量库和 Embedding 各选了什么？

- 检索命中：1/1
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：根据设计文档，navigate 的 Memory 层（Iter 2）技术选型如下：

- **持久化**：使用 **better-sqlite3**（嵌入式 SQLite）做持久化存储。
- **向量库**：使用 **@langchain/community + MemoryVectorStore**。
- **Embedding**：使用 **OpenAI text-embedding-3-small**。

其架构中，持久化部分由 `SqliteStore` 负责会话历史 CRUD，向量记忆部分由 `VectorMemory` 负责向量记忆的检索与存储。

### [doc-06] navigate 的 RAG 引擎（Iter 3）用什么做文本分割和向量库？对外暴露了哪些 API 端点？

- 检索命中：1/1
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:1`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=0.900；answerRelevancy（相关性）=1.000

- 答案：Navigate 的 RAG 引擎（Iter 3）中：

- **文本分割**：使用 `RecursiveCharacterTextSplitter`
- **向量库**：使用 `MemoryVectorStore`，并支持文件级持久化

对外暴露的 API 端点如下：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | 上传文档 |
| GET | `/api/documents` | 文档列表 |
| DELETE | `/api/documents/:id` | 删除文档 |
| POST | `/api/query` | R...

### [doc-07] navigate 的 AgentMemory facade（src/memory/index.ts）组合了哪些存储？暴露了哪些方法？

- 检索命中：0/1
- contextKeys: `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据提供的 RAG 检索上下文，**没有找到关于 navigate 的 AgentMemory facade（`src/memory/index.ts`）组合了哪些存储以及暴露了哪些方法的信息**。

上下文中仅包含“Resume RAG — 简历展示与问答系统”的设计稿，主要描述了简历解析、存储（ResumeStore、SQLite）、Agent 工具（`search_resume`）、API 路由及 Web 页面等，并未提及 `AgentMemory` facade 或其组合的存储、暴露的方法。

因此，无法基于当前上下文回答该问题。

### [doc-08] navigate 的 Skill 系统支持哪几种 action 类型？各自的实现方式是什么？

- 检索命中：0/1
- contextKeys: `2b32c6eb-47d2-4e2d-825a-9b8d43a6eba5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.000；faithfulness（忠实度）=0.750；answerRelevancy（相关性）=0.000

- 答案：根据当前提供的上下文，**无法确定** Navigate 的 Skill 系统具体支持哪几种 action 类型，也无法说明各自的实现方式。

上下文中与 Skill 系统相关的信息仅有：

- 在 Navigate Agent 项目中新增了 **OpenCode Skill 系统**。
- 该系统支持通过 **YAML 文件**定义可复用的技能（Skills）。
- 技能会在运行时动态加载为 Agent 的 `StructuredTool`。

但上下文没有展开说明 Skill 系统内部的 `action` 类型定义、枚举值或各类 action 的具体实现方式。因此不能依据现有 RAG 检索...

### [doc-09] 自建 Wiki 迁到 Wiki.js 后，Wiki.js 跑在哪个端口？与原应用怎么集成？RAG 同步靠什么触发？

- 检索命中：0/1
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.333；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.500

- 答案：根据提供的上下文，整理如下：

## Wiki.js 端口

上下文中**未明确说明 Wiki.js 自身运行的端口**。  
唯一出现的端口是 `3001`，但它是原应用（Navigate App）接收 Webhook 的地址：

```text
http://localhost:3001/api/wiki-sync
```

也就是说，`3001` 是原应用监听 Webhook 的端口，并非 Wiki.js 的端口。因此无法从现有上下文推断 Wiki.js 跑在哪个端口。

---

## 与原应用的集成方式

Wiki.js 通过 **Webhook** 与原应用集成，整体流程如下：

...

### [doc-10] Wiki.js 向 RAG 同步时，page:created / page:updated / page:deleted 三种事件分别怎么处理？Webhook 地址与 Payload 是什么？

- 检索命中：1/1
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:5`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=1.000；faithfulness（忠实度）=0.850；answerRelevancy（相关性）=1.000

- 答案：# Wiki.js 向 RAG 同步机制

## Webhook 地址与 Payload

- **Webhook 地址**：`http://localhost:3001/api/wiki-sync`
- **Payload**：
  ```json
  { event, pageId, slug, title, ... }
  ```

## 三种事件的处理方式

Wiki.js 在用户编辑/创建/删除页面后，会保存到 SQLite，并触发 Webhook POST。Navigate App 接收 Webhook 后，根据事件类型分别处理：

| 事件 | 处理流程 |
|------|--...

### [doc-11] navigate 架构 UML 里，整体架构概览包含哪几个子系统分组？search_documents 工具最终调用的是哪个类？

- 检索命中：1/1
- contextKeys: `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`
- 指标：hitRate@k（找没找到）=1.000；MRR@k（首个相关排名）=1.000；nDCG@k（排序质量）=1.000；contextPrecision@k（检索精度）=1.000；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=1.000

- 答案：## 整体架构概览包含的子系统分组

根据 Navigate Agent 架构 UML 图（`graph TB`），整体架构概览包含以下 **5 个子系统分组**：

1. **配置** — `.env / MCP_SERVERS`、`skills/*.skill.yaml`
2. **入口** — `src/index.ts main()`、`src/config/index.ts loadConfig()`
3. **Agent 引擎** — `ChatOpenAI`、`AgentExecutor`、`System Prompt`
4. **工具层 (StructuredTool)** —...

### [doc-12] 简历问答（Resume RAG）里 ResumeStore 的持久化方案与通用 RAG 有何不同？简历各章节的分块粒度是怎么定的？

- 检索命中：0/1
- contextKeys: `38d4b4a4-3d26-c940-a8c1-c298c467d245:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=0.000；contextRecall（召回）=0.667；faithfulness（忠实度）=0.900；answerRelevancy（相关性）=0.500

- 答案：根据提供的设计稿上下文（context1），Resume RAG 中 **ResumeStore 的持久化方案**与通用 RAG 的主要不同如下：

- **不依赖内存向量库**：Resume RAG 明确要求简历数据独立持久化存储，不依赖内存向量库。
- **使用 SQLite 持久化**：ResumeStore 基于 SQLite 实现持久化，存储内容包括：
  1. **文本块 + OpenAI Embeddings + 元数据**（元数据中记录所属章节）；
  2. **结构化 ResumeData**（以 JSON 形式存入 SQLite）；
  3. **版本管理**（通过文件 h...
