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

export type McpServerStatus = "connected" | "disconnected" | "connecting";

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  config: McpServerConfig;
  status: McpServerStatus;
}

export class McpWrappedTool extends StructuredTool {
  name: string;
  description: string;
  schema: z.ZodObject<any>;

  private manager: McpClientManager;
  private serverName: string;
  private rawToolName: string;

  constructor(manager: McpClientManager, client: Client, serverName: string, tool: { name: string; description?: string; inputSchema?: any }) {
    super();
    this.manager = manager;
    this.client = client;
    this.serverName = serverName;
    this.rawToolName = tool.name;
    this.name = `${serverName}__${tool.name}`;
    this.description = tool.description ?? `MCP tool from server "${serverName}": ${tool.name}`;
    this.schema = McpClientManager.jsonSchemaToZod(tool.inputSchema ?? { type: "object", properties: {} });
  }

  // 保留原始 client 引用，给 _call 用
  private client: Client;

  async _call(args: Record<string, unknown>): Promise<string> {
    // 如果连接断开，自动重连
    if (this.manager.getStatus(this.serverName) !== "connected") {
      try {
        await this.manager.reconnectServer(this.serverName);
      } catch {
        return `[mcp] Server "${this.serverName}" is offline and reconnection failed.`;
      }
    }

    try {
      const result = await this.client.callTool({
        name: this.rawToolName,
        arguments: args,
      });

      if (result.isError) {
        const text = extractText(result.content);
        throw new Error(`MCP tool "${this.name}" returned an error: ${text}`);
      }

      const text = extractText(result.content);
      return text || "(no output)";
    } catch (err) {
      // 连接相关错误 → 标记断开并重试
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Connection closed") || msg.includes("not connected") || msg.includes("transport")) {
        this.manager.markDisconnected(this.serverName);
        return `[mcp] Server "${this.serverName}" disconnected. Please retry.`;
      }
      throw err;
    }
  }
}

function extractText(content: unknown): string {
  const items = Array.isArray(content)
    ? (content as Array<{ type?: string; text?: string }>)
    : [];
  return items
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

export class McpClientManager {
  private connections: Map<string, McpConnection> = new Map();
  private _tools: McpWrappedTool[] = [];
  private reconnectAttempts = new Map<string, number>();
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private readonly RECONNECT_DELAY_MS = 1000;

  async connectServer(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      const existing = this.connections.get(config.name)!;
      if (existing.status === "connected") {
        console.log(`[mcp] Server "${config.name}" already connected, skipping`);
        return;
      }
      // 状态不是 connected → 断开重连
      await this.disconnectServer(config.name);
    }

    console.log(`[mcp] Connecting to server "${config.name}"...`);
    this.setStatus(config.name, "connecting");

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });

    const client = new Client(
      {
        name: "navigate-mcp-client",
        version: "0.1.0",
      },
      {
        capabilities: {},
      },
    );

    // 监听 transport 关闭事件 → 自动标记断开
    transport.onclose = () => {
      console.warn(`[mcp] Server "${config.name}" transport closed`);
      const conn = this.connections.get(config.name);
      if (conn) {
        conn.status = "disconnected";
      }
    };

    try {
      await client.connect(transport);
    } catch (error) {
      console.error(`[mcp] Failed to connect to "${config.name}":`, (error as Error).message);
      this.setStatus(config.name, "disconnected");
      throw error;
    }

    // 首次连接或完全重连时重新注册工具
    const toolsResult = await client.listTools();
    const serverTools = toolsResult.tools ?? [];

    // 如果已有同名工具，先移除旧的
    this._tools = this._tools.filter(t => !t.name.startsWith(`${config.name}__`));

    for (const tool of serverTools) {
      const wrapped = new McpWrappedTool(this, client, config.name, tool);
      this._tools.push(wrapped);
      console.log(`[mcp] Registered tool: ${wrapped.name}`);
    }

    this.connections.set(config.name, { client, transport, config, status: "connected" });
    this.reconnectAttempts.set(config.name, 0);
    console.log(`[mcp] Server "${config.name}" connected with ${serverTools.length} tool(s)`);
  }

  /** 对指定 Server 触发重连 */
  async reconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`Server "${name}" not found`);

    const attempts = this.reconnectAttempts.get(name) ?? 0;
    if (attempts >= this.MAX_RECONNECT_ATTEMPTS) {
      throw new Error(`Server "${name}" reconnection failed after ${attempts} attempts`);
    }

    this.reconnectAttempts.set(name, attempts + 1);
    console.log(`[mcp] Reconnecting server "${name}" (attempt ${attempts + 1}/${this.MAX_RECONNECT_ATTEMPTS})...`);

    // 延迟重连，避免疯狂重试
    if (attempts > 0) {
      await new Promise(r => setTimeout(r, this.RECONNECT_DELAY_MS * attempts));
    }

    await this.connectServer(conn.config);
  }

  /** 断开指定 Server */
  async disconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    try {
      await conn.client.close();
    } catch { /* ignore close errors */ }
    this.connections.delete(name);
    this._tools = this._tools.filter(t => !t.name.startsWith(`${name}__`));
    console.log(`[mcp] Disconnected server "${name}"`);
  }

  /** 标记 Server 为断开 */
  markDisconnected(name: string): void {
    const conn = this.connections.get(name);
    if (conn) {
      conn.status = "disconnected";
    }
  }

  /** 获取指定 Server 的连接状态 */
  getStatus(name: string): McpServerStatus {
    return this.connections.get(name)?.status ?? "disconnected";
  }

  /** 获取所有 Server 的状态报告 */
  getServerStatuses(): { name: string; status: McpServerStatus; tools: number }[] {
    return Array.from(this.connections.entries()).map(([name, conn]) => {
      const toolCount = this._tools.filter(t => t.name.startsWith(`${name}__`)).length;
      return { name, status: conn.status, tools: toolCount };
    });
  }

  /** 定期健康检查：对每个 connected Server 发一次轻量请求 */
  async healthCheck(): Promise<void> {
    for (const [name, conn] of this.connections) {
      if (conn.status !== "connected") continue;
      try {
        await conn.client.listTools();
      } catch {
        console.warn(`[mcp] Health check failed for "${name}", marking disconnected`);
        conn.status = "disconnected";
      }
    }
  }

  private setStatus(name: string, status: McpServerStatus): void {
    const conn = this.connections.get(name);
    if (conn) conn.status = status;
  }

  getTools(): StructuredTool[] {
    return [...this._tools];
  }

  async disconnectAll(): Promise<void> {
    for (const [name] of this.connections) {
      await this.disconnectServer(name);
    }
    this.reconnectAttempts.clear();
  }

  static jsonSchemaToZod(schema: any): z.ZodObject<any> {
    const shape: Record<string, z.ZodTypeAny> = {};
    const properties = schema.properties ?? {};
    const required = new Set<string>(schema.required ?? []);

    for (const [key, prop] of Object.entries<any>(properties)) {
      let zodType: z.ZodTypeAny;

      switch (prop.type) {
        case "string":
          zodType = z.string();
          break;
        case "number":
          zodType = z.number();
          break;
        case "integer":
          zodType = z.number().int();
          break;
        case "boolean":
          zodType = z.boolean();
          break;
        case "array":
          zodType = z.array(z.any());
          break;
        case "object":
          zodType = z.record(z.any());
          break;
        default:
          zodType = z.unknown();
          break;
      }

      if (prop.description) {
        zodType = zodType.describe(prop.description);
      }

      if (prop.default !== undefined) {
        try {
          zodType = zodType.default(prop.default);
        } catch {
          // Some Zod versions may not support .default() on all types; fall back
        }
      }

      if (!required.has(key)) {
        zodType = zodType.optional();
      }

      shape[key] = zodType;
    }

    return z.object(shape);
  }
}
