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
  };
}
