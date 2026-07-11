import { getRecentLogs } from "../agent/logger.js";

export function handleCommand(input: string): string | null {
  const cmd = input.trim().toLowerCase();
  if (cmd === "/exit" || cmd === "/quit") { process.exit(0); return null; }
  if (cmd === "/clear") { return "CLEAR"; }
  if (cmd.startsWith("/logs")) {
    const parts = cmd.split(/\s+/);
    const n = parts[1] ? parseInt(parts[1], 10) : 50;
    if (isNaN(n) || n < 1) return "Usage: /logs [N]  (N = number of lines, default 50)";
    return getRecentLogs(n);
  }
  if (cmd === "/help") {
    return "Available commands:\n  /exit             Exit the application\n  /clear            Clear the conversation\n  /show [N|all|none] Toggle tool call details (N=1 is most recent)\n  /logs [N]         Show last N agent log lines\n  /help             Show this help message";
  }
  return null;
}
