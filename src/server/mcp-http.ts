import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createApiKeyAuth, type ApiKeyAuthConfig } from "./api-key-auth.js";
import { createMcpServer, type RagStoreLike } from "./mcp.js";

export function mountMcpRoutes(app: Express, store: RagStoreLike, apiAuth: ApiKeyAuthConfig): void {
  if (apiAuth.trustProxy) app.set("trust proxy", true);

  const require = createApiKeyAuth(apiAuth);

  // SDK(1.29)的 StreamableHTTPServerTransport 约束:
  // 1. 无状态模式(sessionIdGenerator: undefined)的实例只能处理【一个】请求,
  //    复用会抛 "Stateless transport cannot be reused across requests"。
  // 2. Server/McpServer 只能连接【一个】transport,重复 connect 会抛
  //    "Already connected to a transport"。
  // 因此采用 serverless 无状态模式:每个请求新建 server + transport(createMcpServer
  // 只注册 4 个只读工具的 schema,开销极小),无会话状态,满足多客户端/curl 验证。
  const handle = async (req: Request, res: Response): Promise<void> => {
    const mcp = createMcpServer(store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态模式
      enableJsonResponse: true,      // 直接返回 JSON 而非 SSE,便于 curl 验证
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  const onError = (res: Response, err: unknown): void => {
    console.error("[mcp] transport error:", (err as Error)?.message);
    if (!res.headersSent) res.status(500).json({ error: "mcp transport error" });
  };

  app.post("/mcp", require, (req, res) => {
    void handle(req, res).catch((err) => onError(res, err));
  });
  app.get("/mcp", require, (req, res) => {
    void handle(req, res).catch((err) => onError(res, err));
  });
  app.delete("/mcp", require, (req, res) => {
    void handle(req, res).catch((err) => onError(res, err));
  });
}
