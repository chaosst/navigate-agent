# MCP 客户端支持实现方案

> **对于执行代理：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务执行本方案。步骤使用复选框（`- [ ]`）语法追踪。

**目标：** 为 Navigate 代理添加 MCP（模型上下文协议）客户端支持，使其能通过 stdio 传输连接到外部 MCP 服务器，并将其工具作为原生 LangChain StructuredTool 使用。

**架构：** `McpClientManager` 类管理到 MCP 服务器的连接（通过 `MCP_SERVERS` 环境变量配置）。对每个已连接服务器，通过 `client.listTools()` 发现可用工具，并将每个工具包装为 `McpWrappedTool`（继承 `StructuredTool`）。包装后的工具在启动时合并到代理的工具注册表中。代理的系统提示会更新以告知模型 MCP 提供的工具。关闭时，所有连接优雅关闭。

**技术栈：** TypeScript、@modelcontextprotocol/sdk（Client + StdioClientTransport）、LangChain StructuredTool、Zod 用于输入模式转换

## 全局约束

- 所有 MCP 工具必须命名为 `{serverName}__{toolName}` 以避免命名冲突
- MCP 工具的输入 JSON Schema 必须在运行时转换为 Zod 模式（支持 string、number、integer、boolean、array、object 类型）
- MCP 服务器配置从 `MCP_SERVERS` 环境变量读取，格式为 JSON 数组
- MCP 工具调用结果从 `content[].text` 块提取；错误使用 `isError` 标志
- 系统提示自动包含所有可用 MCP 工具的描述
- 所有 MCP 连接在代理关闭时通过 `process.on('SIGINT')` / `process.on('SIGTERM')` 关闭

---

### 任务 1：创建 MCP 客户端管理器（`src/tools/mcp.ts`）

**文件：**
- 创建：`src/tools/mcp.ts`

**接口：**
- 产出：`McpServerConfig` 接口、`McpClientManager` 类（含 `connectServer(config)`、`getTools(): StructuredTool[]`、`disconnectAll()` 和静态方法 `jsonSchemaToZod(schema)`）

- [ ] **步骤 1：编写文件头部和 McpServerConfig 接口**

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}
```

- [ ] **步骤 2：实现 McpWrappedTool 类**

  继承 `StructuredTool` 的子类：
  - 工具命名为 `{serverName}__{toolName}`
  - 通过 `McpClientManager.jsonSchemaToZod()` 将 `inputSchema`（JSON Schema）转换为 Zod
  - `_call(args)` 中将调用转发到 `client.callTool()`，提取 `__` 后的原始工具名
  - 从 `result.content` 块提取文本；`result.isError` 为 true 时抛错
  - 返回拼接的文本内容，或 "(no output)"

- [ ] **步骤 3：实现 connectServer()**

  通过 StdioClientTransport 连接，通过 `client.listTools()` 发现工具，每个包装为 `McpWrappedTool`，连接存入 `this.connections` 映射。记录进度。用 try/catch 处理错误。

- [ ] **步骤 4：实现 getTools()、disconnectAll() 和 jsonSchemaToZod()**

  `getTools()` 返回 `this._tools` 的副本。`disconnectAll()` 遍历连接，对每个调用 `client.close()`。`jsonSchemaToZod()` 将 JSON Schema 转换为 Zod（string/number/integer/boolean/array/object → unknown）。保留 `description` 和 `default`；非必需字段标记为 optional。

- [ ] **步骤 5：TypeScript 编译检查**
  运行：`npx tsc --noEmit`
  预期：无错误

- [ ] **步骤 6：提交**
  ```
  git add src/tools/mcp.ts
  git commit -m "feat: add MCP client manager with tool wrapping"
  ```

---

### 任务 2：向 Config 模块添加 MCP 服务器配置

**文件：**
- 修改：`src/config/index.ts`

**接口：**
- 消费：`src/tools/mcp.ts` 中的 `McpServerConfig`
- 产出：扩展 `AppConfig`，增加 `mcpServers: McpServerConfig[]` 字段

- [ ] **步骤 1：导入 McpServerConfig 并扩展 AppConfig**

  在 `src/config/index.ts` 中：
  - 添加导入：`import type { McpServerConfig } from "../tools/mcp.js";`
  - 在 `AppConfig` 中添加：`mcpServers: McpServerConfig[];`

- [ ] **步骤 2：在 loadConfig() 中解析 MCP_SERVERS 环境变量**

  在现有环境变量读取之后，添加：
  ```typescript
  let mcpServers: McpServerConfig[] = [];
  const mcpServersRaw = process.env.MCP_SERVERS;
  if (mcpServersRaw) {
    try {
      mcpServers = JSON.parse(mcpServersRaw) as McpServerConfig[];
      if (!Array.isArray(mcpServers)) {
        console.warn("[config] MCP_SERVERS must be a JSON array, ignoring");
        mcpServers = [];
      }
    } catch {
      console.warn("[config] Failed to parse MCP_SERVERS, ignoring");
      mcpServers = [];
    }
  }
  ```
  在返回的配置对象中包含 `mcpServers`。

- [ ] **步骤 3：TypeScript 编译检查**
  运行：`npx tsc --noEmit`
  预期：无错误

- [ ] **步骤 4：提交**
  ```
  git add src/config/index.ts
  git commit -m "feat: add MCP server config parsing from MCP_SERVERS env var"
  ```

---

### 任务 3：更新工具注册表以支持 MCP 工具

**文件：**
- 修改：`src/tools/registry.ts`

- [ ] **步骤 1：更新 createTools() 接受可选的额外工具**

  将签名从 `createTools(): StructuredTool[]` 改为：
  ```typescript
  export function createTools(extraTools?: StructuredTool[]): StructuredTool[] {
    return [
      new ShellTool(),
      new ReadFileTool(),
      new WriteFileTool(),
      new EditFileTool(),
      new ListFilesTool(),
      new SearchFilesTool(),
      ...(extraTools ?? []),
    ];
  }
  ```
  确保 `import { StructuredTool } from "@langchain/core/tools";` 已存在。

- [ ] **步骤 2：TypeScript 编译检查**
  运行：`npx tsc --noEmit`
  预期：无错误

- [ ] **步骤 3：提交**
  ```
  git add src/tools/registry.ts
  git commit -m "chore: update createTools to accept optional extra MCP tools"
  ```

---

### 任务 4：将 MCP 客户端接入应用入口点

**文件：**
- 修改：`src/index.ts`

- [ ] **步骤 1：导入 McpClientManager**

  ```typescript
  import { McpClientManager } from "./tools/mcp.js";
  ```

- [ ] **步骤 2：初始化 MCP 管理器并连接服务器**

  在 `const config = loadConfig();` 之后：
  ```typescript
  const mcpManager = new McpClientManager();
  if (config.mcpServers.length > 0) {
    console.log(`[mcp] Found ${config.mcpServers.length} MCP server(s) in config`);
    for (const serverConfig of config.mcpServers) {
      try {
        await mcpManager.connectServer(serverConfig);
      } catch (error) {
        console.error(`[mcp] Failed to connect to "${serverConfig.name}":`, (error as Error).message);
      }
    }
  }
  ```

- [ ] **步骤 3：将 MCP 工具合并到工具列表**

  将：
  ```typescript
  const allTools = [...createTools(), ragTool, ...(resumeTool ? [resumeTool] : [])];
  ```
  改为：
  ```typescript
  const mcpTools = mcpManager.getTools();
  const allTools = [
    ...createTools(mcpTools),
    ragTool,
    ...(resumeTool ? [resumeTool] : []),
  ];
  ```

- [ ] **步骤 4：添加优雅关闭处理器**

  在服务器启动后添加：
  ```typescript
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await mcpManager.disconnectAll();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await mcpManager.disconnectAll();
    process.exit(0);
  });
  ```

- [ ] **步骤 5：TypeScript 编译检查**
  运行：`npx tsc --noEmit`
  预期：无错误

- [ ] **步骤 6：提交**
  ```
  git add src/index.ts
  git commit -m "feat: wire MCP client manager into agent startup"
  ```

---

### 任务 5：更新系统提示以描述 MCP 工具

**文件：**
- 修改：`src/agent/prompt.ts`

- [ ] **步骤 1：更新 buildSystemPrompt 接受工具描述**

  将签名从 `buildSystemPrompt(resumeSummary?: string)` 改为：
  ```typescript
  export function buildSystemPrompt(
    resumeSummary?: string,
    mcpToolDescriptions?: string[],
  ): string {
    let prompt = `You are Navigate Agent, an AI assistant with access to file system and shell tools...`;

    if (mcpToolDescriptions && mcpToolDescriptions.length > 0) {
      prompt += `\n\n## External Tools (MCP)\nYou have access to the following external tools provided by MCP servers:\n`;
      for (const desc of mcpToolDescriptions) {
        prompt += `- ${desc}\n`;
      }
    }

    if (resumeSummary) {
      prompt += `\n\n## About the User\n${resumeSummary}\n\n`
        + `You have access to the user's resume via the search_resume tool. `;
    }

    return prompt;
  }
  ```

- [ ] **步骤 2：更新 src/index.ts 中的调用**

  在 `const mcpTools = mcpManager.getTools();` 之后生成描述：
  ```typescript
  const mcpToolDescriptions = mcpTools.map(t =>
    `${t.name}: ${t.description}`
  );
  const systemPrompt = buildSystemPrompt(resumeSummary, mcpToolDescriptions);
  ```

- [ ] **步骤 3：TypeScript 编译检查**
  运行：`npx tsc --noEmit`
  预期：无错误

- [ ] **步骤 4：提交**
  ```
  git add src/agent/prompt.ts src/index.ts
  git commit -m "feat: list available MCP tools in system prompt"
  ```

---

### 任务 6：在 .env.example 中记录 MCP 配置

**文件：**
- 修改：`.env.example`

- [ ] **步骤 1：添加 MCP_SERVERS 文档**

  追加到 `.env.example`：
  ```env
  # MCP 服务器配置
  # MCP 服务器定义的 JSON 数组。
  # 每个条目：{ "name": string, "command": string, "args": string[], "env"?: object, "cwd"?: string }
  # 示例：MCP_SERVERS=[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","./rag_uploads"]}]
  # 留空或不设置以禁用 MCP 支持。
  MCP_SERVERS=
  ```

- [ ] **步骤 2：提交**
  ```
  git add .env.example
  git commit -m "docs: document MCP_SERVERS env var configuration"
  ```

---

### 验证

- [ ] **最终检查：** 运行 `npx tsc --noEmit` 并确认零错误
- [ ] **启动：** MCP_SERVERS 为空时运行 `npm run dev` — 确认代理启动正常
- [ ] **带 MCP 服务器：** 设置 MCP_SERVERS 为有效服务器配置，重启，确认控制台显示工具已发现
