import { config } from "dotenv";
import type { McpServerConfig } from "../tools/mcp.js";

export interface AppConfig {
  openAIApiKey: string;
  modelName: string;
  maxIterations: number;
  baseURL: string;
  /** 单次 LLM 调用超时（ms）。PTC 场景模型常生成大段程序/文档，默认 120s */
  llmTimeoutMs: number;
  /** embedding 模型（摘要/向量检索用）。若 baseURL 无该模型，摘要检索自动降级关键词 */
  embeddingModel: string;
  mcpServers: McpServerConfig[];
  databaseUrl: string;
  databasePoolMin: number;
  databasePoolMax: number;
  apiKeys: string;
  apiKeyLegacy: string;
  apiIpWhitelist: string;
  apiSignatureWindowMs: number;
  apiTrustProxy: boolean;
  apiFailureLimit: number;
  apiFailureWindowMs: number;

  agentMode: AgentMode;           // AGENT_MODE，默认 "normal"
  // ptc
  ptcMaxProgramLength: number;    // PTC_MAX_PROGRAM_LENGTH，默认 16_384（字符）
  ptcMaxWallMs: number;           // PTC_MAX_WALL_MS，默认 60_000
  ptcMaxComputeMs: number;        // PTC_MAX_COMPUTE_MS，默认 30_000（可选）
  ptcMaxOutputBytes: number;      // PTC_MAX_OUTPUT_BYTES，默认 64_1024（64KB）
  ptcMaxParallelSubCalls: number; // PTC_MAX_PARALLEL_SUBCALLS，默认 10；1 恢复串行
  ptcMode: "code" | "both";       // PTC_TOOL_MODE，默认 "code"（PTC 内是否同时保留原生工具）
}

export type AgentMode = "normal" | "plan" | "ptc"

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
  const apiFailureLimitRaw = parseInt(process.env.API_FAILURE_LIMIT ?? "5", 10);
  const apiFailureWindowRaw = parseInt(process.env.API_FAILURE_WINDOW_MS ?? "60000", 10);

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

  // 执行模式：normal | plan | ptc（非法值回退 "normal"）
  const agentModeRaw = process.env.AGENT_MODE ?? "normal";
  const agentMode: AgentMode =
    agentModeRaw === "plan" || agentModeRaw === "ptc" ? agentModeRaw : "normal";

  // PTC 预算（均有默认值；数值非法时回退默认）
  const num = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  };
  const ptcModeRaw = process.env.PTC_TOOL_MODE ?? "code";
  const ptcMode: "code" | "both" = ptcModeRaw === "both" ? "both" : "code";

  return {
    openAIApiKey: apiKey,
    modelName: process.env.OPENAI_MODEL ?? "gpt-4o",
    maxIterations,
    baseURL: process.env.OPENAI_BASE_URL ?? "",
    llmTimeoutMs: num(process.env.LLM_TIMEOUT_MS, 120_000),
    embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    mcpServers,
    databaseUrl,
    databasePoolMin: parseInt(process.env.DATABASE_POOL_MIN ?? "2", 10),
    databasePoolMax: parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10),
    apiKeys: process.env.API_KEYS ?? "",
    apiKeyLegacy: process.env.API_KEY ?? "",
    apiIpWhitelist: process.env.API_IP_WHITELIST ?? "",
    apiSignatureWindowMs: Number.isNaN(apiSignatureWindowRaw) ? 300000 : apiSignatureWindowRaw,
    apiTrustProxy: (process.env.API_TRUST_PROXY ?? "").toLowerCase() === "true",
    apiFailureLimit: Number.isNaN(apiFailureLimitRaw) ? 5 : apiFailureLimitRaw,
    apiFailureWindowMs: Number.isNaN(apiFailureWindowRaw) ? 60000 : apiFailureWindowRaw,

    agentMode,
    ptcMaxProgramLength: num(process.env.PTC_MAX_PROGRAM_LENGTH, 16_384),
    ptcMaxWallMs: num(process.env.PTC_MAX_WALL_MS, 60_000),
    ptcMaxComputeMs: num(process.env.PTC_MAX_COMPUTE_MS, 30_000),
    ptcMaxOutputBytes: num(process.env.PTC_MAX_OUTPUT_BYTES, 64 * 1024),
    ptcMaxParallelSubCalls: num(process.env.PTC_MAX_PARALLEL_SUBCALLS, 10),
    ptcMode,
  };
}
