import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = "rag_data";
const LOG_FILE = join(LOG_DIR, "agent.log");

/**
 * 写入一条 Agent 日志
 */
export function logAgent(entry: {
  timestamp?: string;
  type:
    | "tool_call"
    | "tool_result"
    | "llm_request"
    | "llm_response"
    | "error"
    | "warning"
    | "info"
    | "ptc_program"    // PTC：模型发起 run_code
    | "ptc_dispatch"   // PTC：程序内子调用
    | "ptc_result";    // PTC：run_code 结算
  message: string;
  details?: unknown;
}): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const ts = entry.timestamp || new Date().toISOString();
    const details = entry.details !== undefined ? " " + JSON.stringify(entry.details, null, 0) : "";
    const line = `[${ts}] [${entry.type}] ${entry.message}${details}\n`;
    appendFileSync(LOG_FILE, line, "utf-8");
  } catch {
    // 日志写入失败不影响主流程
  }
}

/**
 * 获取最近 N 条日志
 */
export function getRecentLogs(n: number = 50): string {
  try {
    if (!existsSync(LOG_FILE)) return "(no agent logs yet)";
    const content = readFileSync(LOG_FILE, "utf-8");
    const lines = content.trim().split("\n");
    return lines.slice(-n).join("\n");
  } catch {
    return "(failed to read logs)";
  }
}
