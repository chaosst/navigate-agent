# Navigate Agent 架构 UML 图

> 生成时间: 2026-07-12 | Mermaid v8.8.2+

---

## 1. 整体架构概览

```mermaid
graph TB
    subgraph "配置"
        ENV[".env / MCP_SERVERS"]
        SKILL_FILES["skills/*.skill.yaml"]
    end

    subgraph "入口"
        INDEX["src/index.ts main()"]
        CFG["src/config/index.ts loadConfig()"]
    end

    subgraph "Agent 引擎"
        LLM["ChatOpenAI"]
        LOOP["AgentExecutor"]
        PROMPT["System Prompt"]
    end

    subgraph "工具层 (StructuredTool)"
        FILE_TOOLS["Shell / Read / Write / Edit"]
        SEARCH_TOOLS["ListFiles / SearchFiles"]
        MCP_TOOLS["McpWrappedTool (来自 MCP 服务器)"]
        RAG_TOOL["RagSearchTool (search_documents)"]
        RES_TOOL["ResumeSearchTool (search_resume)"]
        SKILL_TOOLS["SkillTool (来自 YAML)"]
    end

    subgraph "MCP"
        MCP_MGR["McpClientManager"]
        MCP_SRV["外部 MCP 服务器 (stdio)"]
    end

    subgraph "RAG"
        RAG_VS["RagVectorStore"]
        RAG_SRV["Express /api/upload"]
        CONTENT_SYNC["ZyplayerDocAdapter"]
    end

    subgraph "Skill"
        SK_REG["SkillRegistry"]
    end

    subgraph "Resume"
        RES_STORE["ResumeStore (SQLite)"]
    end

    ENV --> CFG
    SKILL_FILES --> SK_REG
    INDEX --> CFG
    INDEX --> LLM
    INDEX --> MCP_MGR
    INDEX --> RAG_VS
    INDEX --> LOOP
    INDEX --> SK_REG
    CFG --> MCP_MGR
    MCP_MGR --> MCP_SRV
    MCP_MGR --> MCP_TOOLS
    RAG_VS --> RAG_TOOL
    RES_STORE --> RES_TOOL
    SK_REG --> SKILL_TOOLS
    LOOP --> LLM
    LOOP --> PROMPT
```

---

## 2. MCP 客户端子系统

### 类图

```mermaid
classDiagram
    class McpServerConfig {
        +name: string
        +command: string
        +args: string[]
        +env: Record~string, string~
        +cwd: string
    }

    class McpClientManager {
        -connections: Map~string, McpConnection~
        -_tools: McpWrappedTool[]
        +connectServer(config: McpServerConfig) Promise~void~
        +getTools() StructuredTool[]
        +disconnectAll() Promise~void~
        +$jsonSchemaToZod(schema: any) ZodObject
    }

    class McpWrappedTool {
        +name: string
        +description: string
        +schema: ZodObject
        -client: Client
        -rawToolName: string
        +_call(args: Record~string, unknown~) Promise~string~
    }

    class McpConnection {
        +client: Client
        +transport: StdioClientTransport
    }

    class Client {
        <<MCP SDK>>
        +connect(transport) Promise~void~
        +listTools() Promise~ListToolsResult~
        +callTool(request) Promise~CallToolResult~
        +close() Promise~void~
    }

    class StdioClientTransport {
        <<MCP SDK>>
        +command: string
        +args: string[]
    }

    class StructuredTool {
        <<LangChain>>
    }

    McpClientManager --> McpConnection : manages
    McpClientManager --> McpWrappedTool : creates
    McpClientManager ..> McpServerConfig : reads
    McpWrappedTool --|> StructuredTool : extends
    McpWrappedTool --> Client : wraps
    Client --> StdioClientTransport : uses
```

### JSON Schema → Zod 转换

```
MCP Server listTools()  →  JSON Schema  →  jsonSchemaToZod()
                                                │
                ┌────────────────────────────────┤
                ↓          ↓         ↓          ↓
           z.string()  z.number()  z.boolean()  z.array(z.any())
                ↓          ↓         ↓          ↓
           + .describe() + .default() + .optional()
                ↓
           z.object({ ... })  →  McpWrappedTool.schema
```

---

## 3. RAG 子系统

### 类图

```mermaid
classDiagram
    class RagVectorStore {
        -store: MemoryVectorStore
        -embeddings: OpenAIEmbeddings
        -persistDir: string
        -rawChunks: LoadedChunk[]
        +addChunks(chunks, docId) Promise~void~
        +deleteDoc(docId) Promise~void~
        +search(query, k) Promise~RagResult[]~
        -keywordSearch(query, k) RagResult[]
        -saveToDisk() Promise~void~
        -loadFromDisk() Promise~void~
    }

    class RagSearchTool {
        +name: string = "search_documents"
        +description: string
        -store: RagVectorStore
        +_call(query, k) Promise~string~
    }

    class loadDocument {
        +loadDocument(filePath, filename, chunkSize?, chunkOverlap?) Promise~LoadedChunk[]~
    }

    class createRagServer {
        +createRagStore(store, port, executor, resumeStore, resumeData) Express
    }

    class RagResult {
        <<interface>>
        +content: string
        +score: number
        +source: string
        +docId: string
    }

    class LoadedChunk {
        <<interface>>
        +content: string
        +metadata: Record~string, unknown~
    }

    class StructuredTool {
        <<LangChain>>
    }

    RagSearchTool --|> StructuredTool : extends
    RagSearchTool --> RagVectorStore : depends
    RagVectorStore --> LoadedChunk : stores
    RagVectorStore --> RagResult : produces
    loadDocument --> LoadedChunk : produces
    createRagServer --> RagVectorStore : manages API
```

### 数据处理流

```
上传:  User  →  POST /api/upload  →  loadDocument() 分块  →  RagVectorStore.addChunks()  →  持久化到磁盘
搜索:  Agent  →  RagSearchTool._call()  →  similaritySearchWithScore()  →  keywordSearch() 回退  →  结果
恢复:  启动  →  RagVectorStore.loadFromDisk()  →  重新 embed  →  MemoryVectorStore
```

### RAG ↔ zyplayer-doc 集成

```mermaid
graph LR
    UP["上传文件"] --> RS["RAG Server /api/upload"]
    RS --> WV["PgVectorStore"]
    ZDA["ZyplayerDocAdapter\n(读取 MySQL)"] --> WV
    CP["ContentPoller (轮询)"] --> ZDA
    ZD["zyplayer-doc (port 8083)\n用户手动编辑内容"] --> MYSQL[(MySQL)]
    MYSQL --> ZDA
    WV --> RST["RagSearchTool"]
    RST --> AGT["AgentExecutor"]
```

---

## 4. Skill 子系统

### 类图

```mermaid
classDiagram
    class SkillDefinition {
        <<interface>>
        +name: string
        +description: string
        +schema: object
        +action: SkillAction
    }

    class SkillAction {
        <<interface>>
        +type: SkillActionType
        +template: string
        +command: string
        +url: string
        +method: string
        +headers: Record~string, string~
        +code: string
    }

    class SkillActionType {
        <<enum>>
        template
        shell
        http
        code
    }

    class SkillRegistry {
        -skillsDir: string
        -tools: Map~string, StructuredTool~
        +loadAll() Promise~StructuredTool[]~
        +loadSkill(filePath) Promise~StructuredTool~
        +getTool(name) StructuredTool
        +watch() void
    }

    class SkillTool {
        +name: string
        +description: string
        +schema: ZodObject
        -def: SkillDefinition
        +_call(input) Promise~string~
        -execShell() string
        -callHttp() Promise~string~
        -runCode() Promise~string~
    }

    SkillTool --|> StructuredTool : extends
    SkillTool --> SkillDefinition : wraps
    SkillDefinition --> SkillAction : contains
    SkillAction --> SkillActionType : typed by
    SkillRegistry --> SkillTool : creates
```

### 加载与执行流程

```mermaid
graph TB
    subgraph "Skill 文件"
        Y1["example.skill.yaml<br/>name: greet_user<br/>type: template"]
        Y2["weather.skill.yaml<br/>name: get_weather<br/>type: http"]
    end

    subgraph "SkillRegistry.loadAll()"
        SCAN["扫描并过滤 .skill.yaml"]
        PARSE["js-yaml 解析"]
        VALID["验证字段"]
        INST["new SkillTool()"]
    end

    subgraph "SkillTool._call() 分发"
        ET{"action.type"}
        T["template: renderTemplate() 替换参数"]
        S["shell: execSync()"]
        H["http: fetch()"]
        C["code: AsyncFunction()"]
    end

    Y1 --> SCAN
    Y2 --> SCAN
    SCAN --> PARSE
    PARSE --> VALID
    VALID --> INST
    INST --> ET
    ET --> T
    ET --> S
    ET --> H
    ET --> C
```

---

## 5. Agent 工具集成

### 工具注册

```mermaid
graph LR
    subgraph "启动时收集"
        A["createTools(mcpTools)"] --> AT1["ShellTool"]
        A --> AT2["ReadFileTool"]
        A --> AT3["WriteFileTool"]
        A --> AT4["EditFileTool"]
        A --> AT5["ListFilesTool"]
        A --> AT6["SearchFilesTool"]
        A --> MCP["McpWrappedTool (N 个)"]
        B["RagSearchTool"]
        C["ResumeSearchTool"]
        D["SkillTool (N 个)"]
    end

    subgraph "合并"
        ALL["allTools"]
    end

    AT1 --> ALL
    AT2 --> ALL
    AT3 --> ALL
    AT4 --> ALL
    AT5 --> ALL
    AT6 --> ALL
    MCP --> ALL
    B --> ALL
    C --> ALL
    D --> ALL

    subgraph "AgentExecutor"
        P["buildSystemPrompt(resumeSummary, mcpDescs)"]
        E["createAgentExecutor(llm, allTools, prompt, maxIterations)"]
    end

    ALL --> E
    P --> E
```

### StructuredTool 继承层次

```mermaid
classDiagram
    class StructuredTool {
        <<LangChain>>
    }

    StructuredTool <|-- ShellTool : shell
    StructuredTool <|-- ReadFileTool : read_file
    StructuredTool <|-- WriteFileTool : write_file
    StructuredTool <|-- EditFileTool : edit_file
    StructuredTool <|-- ListFilesTool : list_files
    StructuredTool <|-- SearchFilesTool : search_files
    StructuredTool <|-- RagSearchTool : search_documents
    StructuredTool <|-- ResumeSearchTool : search_resume
    StructuredTool <|-- SkillTool : (from YAML)
    StructuredTool <|-- McpWrappedTool : server__tool

    RagSearchTool --> RagVectorStore
    ResumeSearchTool --> ResumeStore
    SkillTool --> SkillDefinition
    McpWrappedTool --> Client
```

---

## 6. 系统启动序列

```mermaid
sequenceDiagram
    participant Main as main()
    participant Cfg as loadConfig()
    participant MCP as McpClientManager
    participant LLM as ChatOpenAI
    participant RAG as RagVectorStore
    participant SK as SkillRegistry
    participant EX as AgentExecutor

    Main->>Cfg: loadConfig()
    Cfg-->>Main: AppConfig

    Main->>MCP: new (并连接各 MCP 服务器)
    MCP->>MCP: 每个服务器: connect -> listTools -> wrap
    MCP-->>Main: McpWrappedTool[]

    Main->>LLM: createChatModel(config)
    LLM-->>Main: ChatOpenAI

    Main->>RAG: new RagVectorStore()
    RAG->>RAG: loadFromDisk() 恢复数据

    opt resume.md 存在
        Main->>Main: ResumeStore.create() + import()
    end

    Main->>SK: new (并 loadAll)
    SK->>SK: 扫描 YAML -> new SkillTool
    SK-->>Main: StructuredTool[]

    Main->>Main: 合并所有工具 -> allTools
    Main->>Main: buildSystemPrompt() -> prompt

    Main->>EX: createAgentExecutor(llm, allTools, prompt)
    EX-->>Main: AgentExecutor

    Main->>Main: createRagServer() + render(App)

    Note over Main: SIGINT/SIGTERM -> disconnectAll()
```

---

## 7. 工具调用流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant UI as TUI
    participant EX as AgentExecutor
    participant LLM as LLM
    participant Tool as StructuredTool
    participant Ext as 外部服务

    User->>UI: 输入问题
    UI->>EX: stream(messages)

    loop 迭代 (maxIterations)
        EX->>LLM: 消息 + 工具定义
        LLM-->>EX: 文本 或 工具调用

        alt 工具调用
            EX->>EX: 解析工具名和参数
            EX->>Tool: _call(args)

            alt MCP 工具
                Tool->>Ext: client.callTool()  stdio
                Ext-->>Tool: content[]
            else RAG 工具
                Tool->>Tool: store.search()
            else Resume 工具
                Tool->>Tool: store.search()
            else Skill 工具
                Tool->>Tool: execSync/fetch/AsyncFunction
            else 文件工具
                Tool->>Tool: 文件读写
            end

            Tool-->>EX: 字符串结果
        else 最终回复
            EX-->>UI: streaming tokens
            UI-->>User: 显示回复
        end
    end
```

---

## 图例

| 符号 | 含义 |
|------|------|
| `class` / `<<interface>>` | TypeScript 类 / 接口 |
| `--|>` `extends` | 继承 |
| `-->` | 关联/依赖 |
| `..>` | 创建 |
| `<|--` | 被继承 |
| `{}` 菱形 | 条件分支 |
| `alt/else/end` | 条件选择 |
| `loop/end` | 循环 |
| `opt/end` | 可选块 |

---

> 使用 Mermaid.js 语法，支持 GitHub、VS Code (Mermaid 插件)、GitLab 等渲染器。
