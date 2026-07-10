export function handleCommand(input: string): string | null {
  const cmd = input.trim().toLowerCase();
  if (cmd === "/exit" || cmd === "/quit") { process.exit(0); return null; }
  if (cmd === "/clear") { return "CLEAR"; }
  if (cmd === "/help") {
    return "Available commands:\n  /exit             Exit the application\n  /clear            Clear the conversation\n  /show [N|all|none] Toggle tool call details (N=1 is most recent)\n  /help             Show this help message";
  }
  return null;
}
