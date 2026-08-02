import { config } from "dotenv";
import type { McpServerConfig } from "../tools/mcp.js";

export interface AppConfig {
  openAIApiKey: string;
  modelName: string;
  maxIterations: number;
  baseURL: string;
  mcpServers: McpServerConfig[];
  databaseUrl: string;
  databasePoolMin: number;
  databasePoolMax: number;
  apiKeys: string;
  apiKeyLegacy: string;
  apiIpWhitelist: string;
  apiSignatureWindowMs: number;
  apiTrustProxy: boolean;
}

export function loadConfig(): AppConfig {
  config();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required but not set.");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required but not set.");
  }

  const maxIterationsRaw = parseInt(process.env.MAX_ITERATIONS ?? "25", 10);
  const maxIterations = Number.isNaN(maxIterationsRaw) ? 25 : maxIterationsRaw;

  const apiSignatureWindowRaw = parseInt(process.env.API_SIGNATURE_WINDOW_MS ?? "300000", 10);

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

  return {
    openAIApiKey: apiKey,
    modelName: process.env.OPENAI_MODEL ?? "gpt-4o",
    maxIterations,
    baseURL: process.env.OPENAI_BASE_URL ?? "",
    mcpServers,
    databaseUrl,
    databasePoolMin: parseInt(process.env.DATABASE_POOL_MIN ?? "2", 10),
    databasePoolMax: parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10),
    apiKeys: process.env.API_KEYS ?? "",
    apiKeyLegacy: process.env.API_KEY ?? "",
    apiIpWhitelist: process.env.API_IP_WHITELIST ?? "",
    apiSignatureWindowMs: Number.isNaN(apiSignatureWindowRaw) ? 300000 : apiSignatureWindowRaw,
    apiTrustProxy: (process.env.API_TRUST_PROXY ?? "").toLowerCase() === "true",
  };
}
