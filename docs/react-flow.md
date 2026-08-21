# Navigate Agent ReAct 流程

> 扫描自当前代码 (2026-08-07) | Mermaid

## 0. 结论速览

项目里实际存在 **两条 ReAct 路径**,只有一条在运行:

| 路径 | 代码 | 是否接线 | 说明 |
|---|---|---|---|
| **主路径** | `loop.ts` → LangChain `AgentExecutor` + `createOpenAIToolsAgent` | ✅ TUI & Server 都在用 | 黑盒循环,产出的 chunk 与 `runAgent`/TUI/SSE 对接 |
| **手写路径** | `custom-loop.ts` `CustomAgent` + `delegate.ts` `DelegateTaskTool` | ⚠️ 未接线 | `delegate_task` 未在 `createTools()`/入口注册,目前是死代码;`ToolFilter` 也仅在这里生效 |

另有一个差异点:CLAUDE.md 声称"所有工具都被 `PermissionWrapper` 包装",但 `src/tools/registry.ts` 的 `createTools()` 返回的是**裸工具**(`new ShellTool()` 等,未包 `PermissionWrapper`),`ToolFilter` 在主路径里也没被调用 → 实际运行时 LLM 能看到全部工具、无动态权限过滤。

---

## 1. 装配流程(进程启动时一次)

```mermaid
flowchart TB
    START(["入口<br/>index.ts TUI / server-entry.ts"]) --> CFG["loadConfig()<br/>src/config/index.ts"]
    START --> LLM["createChatModel()<br/>ChatOpenAI<br/>(temp=0, streaming, 30s超时)"]
    START --> EMB["OpenAIEmbeddings<br/>text-embedding-3-small"]

    CFG --> MAX["maxIterations<br/>(.env, 默认25)"]

    EMB --> MEM["AgentMemory.create()<br/>(仅 TUI)"]
    EMB --> POOL["Postgres 连接池 getPool()"]
    POOL --> RAG["PgVectorStore<br/>src/storage/"]
    RAG --> RAGTOOL["RagSearchTool<br/>(search_documents)"]

    RAGTOOL --> ALL

    EMB --> RESUME{resume.md<br/>存在?}
    RESUME -- 是 --> RESSTORE["ResumeStore.create()<br/>导入/缓存索引"]
    RESSTORE --> REST[["ResumeSearchTool<br/>(search_resume)"]]
    RESSTORE --> SUM["resume 摘要"]

    RESUME -- 否 --> REST

    SKILL["SkillRegistry.loadAll()<br/>skills/*.skill.yaml"] --> SKT["SkillTool 列表"]

    REST --> ALL["allTools =<br/>createTools() + rag + resume? + skills"]
    SKT --> ALL
    ALL --> EXEC

    SUM --> SYS["buildSystemPrompt(resumeSummary)<br/>src/agent/prompt.ts"]
    SYS --> EXEC["createAgentExecutor(llm, tools, systemPrompt, maxIterations)<br/>src/agent/loop.ts:19"]
    EXEC --> P1["ChatPromptTemplate<br/>System + Messages + agent_scratchpad"]
    EXEC --> P2["createOpenAIToolsAgent(streamRunnable)"]
    EXEC --> P3["AgentExecutor(maxIterations,<br/>returnIntermediateSteps,<br/>earlyStoppingMethod='generate')"]

    P1 & P2 & P3 --> DONE(["运行:<br/>TUI render(App) /<br/>createRagServer(:3001)"])
```

工具集合明细(`createTools()`,`src/tools/registry.ts`):

```mermaid
flowchart LR
    ALL["allTools"] --> SH["ShellTool<br/>execute_command"]
    ALL --> RF["ReadFileTool"]
    ALL --> WF["WriteFileTool"]
    ALL --> EF["EditFileTool"]
    ALL --> LF["ListFilesTool"]
    ALL --> SF["SearchFilesTool"]
    ALL --> RAG["RagSearchTool"]
    ALL --> RES["ResumeSearchTool (可选)"]
    ALL --> SK["SkillTool x N (可选)"]
```

---

## 2. 主路径 ReAct 循环(实际运行)

TUI 输入 → `runAgent()`;HTTP 请求 → `/api/resume/chat`。两条路最终都调用同一个 `executor.stream({messages})`。

```mermaid
flowchart TB
    USR["用户输入 value / question"]

    subgraph TUI["TUI (src/tui/app.tsx onSubmit)"]
        T1["historyRef (会话消息) → parseHistory()"]
        T2["memory.addUserMessage(value)"]
        T3["runAgent(executor, value, history, events)<br/>src/agent/loop.ts:63"]
        T4["30s Promise.race 超时包装"]
        T5["渲染: 运行中的工具 / 流式文本 / 最终回复"]
        T6["memory.addAssistantMessage + summarizeAndStore"]
    end

    subgraph SRV["Server (src/server/index.ts:390 /api/resume/chat)"]
        S1["token 即 sessionId → 内存会话"]
        S2["messages → HumanMessage/AIMessage 列表"]
        S3["executor.stream({messages})"]
        S4["SSE: event:token / done / error"]
    end

    USR --> T1
    USR --> T2
    T1 --> T3
    T3 --> T4
    T4 --> STREAM

    USR --> S1
    S1 --> S2
    S2 --> S3
    S3 --> STREAM["executor.stream({messages})<br/>src/agent/loop.ts / server/index.ts"]

    STREAM --> LOOP

    subgraph LOOP["AgentExecutor 内部循环 (LangChain 黑盒, maxIterations)"]
        direction TB
        L1["LLM.invoke<br/>(system + messages + scratchpad + tools)"]
        L1 --> L2{返回了<br/>tool_calls?}
        L2 -- 是 --> L3["ToolExecutor 逐个执行工具<br/>(shell/文件/RAG/resume/skill)"]
        L3 --> L4["结果作为 ToolMessage 回填对话"]
        L4 --> L1
        L2 -- 否 --> L5["产出最终答案 output<br/>(earlyStopping='generate')"]
    end

    LOOP --> CHUNK

    subgraph CHUNK["stream() 产出的 chunk"]
        C1["chunk.intermediateSteps (新增) → onToolStart / onToolEnd<br/>(记录日志 + TUI 动态区)"]
        C2["chunk.output → onToken (累加流式文本)"]
    end

    CHUNK --> T5
    CHUNK --> S4
    T5 --> T6
    T6 --> END2(["回合结束"])
```

主循环代码位点:`src/agent/custom-loop.ts:103-248` 里注释描述的循环结构与 LangChain `AgentExecutor` 一致(Think → Act → Observe),区别仅是前者手写、后者黑盒。

---

## 3. 手写路径 CustomAgent(当前未接线)

`src/agent/custom-loop.ts` 的手写 ReAct 循环,唯一调用方是 `src/tools/delegate.ts` 的 `DelegateTaskTool`(子任务委派 worker)。`delegate_task` 未注册进 `createTools()`,所以此路径目前不会触发。

```mermaid
flowchart TB
    SUB["主 Agent 调 delegate_task 工具<br/>(目前无任何地方注册)"]
    SUB --> W["DelegateTaskTool._call()<br/>src/tools/delegate.ts:56"]

    subgraph WK["new CustomAgent(...) worker (maxWorkerIterations=6)"]
        direction TB
        W1["worker.run(task) 同步模式<br/>src/agent/custom-loop.ts:254"]
        W2["SystemMessage(workerPrompt) + HumanMessage(task)"]
        W2 --> W3["循环开始 (maxIterations)"]
        W3 --> W4["llm.bindTools(allTools).invoke()<br/>30s 超时, 首轮失败降级为无工具重试"]
        W4 --> W5{有<br/>tool_calls?}
        W5 -- 否 --> W6["返回 extractText(content) 纯文本"]
        W5 -- 是 --> W7["逐个执行工具 → ToolMessage 回填"]
        W7 --> W3
        W3 -- 迭代耗尽 --> W8["LLM 总结已收集的 toolOutputs → [Worker partial]"]
    end

    W --> WK
    WK --> RET["[Worker result] 文本回给主 Agent 作为工具 observation"]

    subgraph STREAM["CustomAgent.stream() 流式变体 (备用)"]
        ST1["SystemMessage + 历史消息"]
        ST2["ToolFilter.filter(allTools, userInput)<br/>关键词→权限等级 (read 默认 / write / dangerous)"]
        ST3["llm.bindTools(过滤后工具).invoke()"]
        ST3 --> ST4{有<br/>tool_calls?}
        ST4 -- 否 --> ST5["yield {output, intermediateSteps}<br/>末尾附工具统计报告"]
        ST4 -- 是 --> ST6["Promise.all 并发执行全部工具调用"]
        ST6 --> ST7["逐条 yield intermediateSteps chunk + ToolMessage 回填"]
        ST7 --> ST3
        ST3 -- 迭代耗尽 --> ST8["yield 兜底 fallback 消息"]
    end
```

---

## 4. 权限 / 过滤基础设施(存在但主路径未生效)

```mermaid
flowchart LR
    PERM["PermissionWrapper 装饰器<br/>src/tools/permission.ts<br/>permission: read/write/dangerous<br/>+ 统计 + 限流/熔断(未启用)"] --> RAW["原始 StructuredTool"]
    FILTER["ToolFilter<br/>src/tools/tool-filter.ts<br/>关键词 → 最低权限等级"] -.只在 custom-loop.ts 调用.-> PERM

    RAW2["createTools()<br/>返回裸工具 (new ShellTool() ...)<br/>未包 PermissionWrapper"] -.实际.-> EXEC2["AgentExecutor 主路径<br/>工具全部暴露, 无动态过滤"]
```

> ⚠️ 与 CLAUDE.md 描述不符:文档称所有工具均被 `PermissionWrapper` 包装、`ToolFilter` 动态限制可见工具,但当前 `registry.ts` 没有包装,主路径也没接入 `ToolFilter`。要启用需在 `createTools()` 里 `new PermissionWrapper(new ShellTool(), "dangerous")` 并把过滤接入 `createAgentExecutor` 或改走 `CustomAgent.stream()`。

---

## 5. 一次完整对话的生命周期(TUI 视角)

```mermaid
sequenceDiagram
    participant U as 用户
    participant T as TUI (app.tsx)
    participant M as AgentMemory
    participant A as AgentExecutor
    participant L as LLM
    participant TL as Tools

    U->>T: 输入文本
    T->>M: addUserMessage
    T->>A: runAgent(executor, input, history, events)
    loop 迭代 = 1..maxIterations
        A->>L: invoke(messages + tools)
        alt LLM 返回 tool_calls
            L-->>A: tool_calls
            A->>A: ToolExecutor 执行 (并发/逐个)
            A->>TL: 调用工具
            TL-->>A: 结果 → ToolMessage 回填
            A-->>T: stream chunk (intermediateSteps) → onToolStart/onToolEnd
        else LLM 返回纯文本
            L-->>A: 最终答案
            A-->>T: chunk.output → onToken 流式渲染
        end
    end
    T->>M: addAssistantMessage + summarizeAndStore
    T-->>U: 渲染最终回复
```
