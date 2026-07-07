export interface AgentConfig {
  modelName: string;
  maxIterations: number;
  systemPrompt: string;
  verbose?: boolean;
}

export interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ToolResult {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  success: boolean;
  durationMs: number;
}

export interface AgentEvents {
  onToolStart?: (tool: string, input: Record<string, unknown>) => void;
  onToolEnd?: (result: ToolResult) => void;
  onToken?: (token: string) => void;
  onFinish?: (output: string) => void;
  onError?: (error: Error) => void;
}
