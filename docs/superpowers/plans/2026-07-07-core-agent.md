# Core Agent (Iter 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an interactive terminal-based agent with LangChain AgentExecutor + OpenAI tool calling, including a TUI interface and built-in file/shell tools.

**Architecture:** Four layers -- config/env loads settings, agent layer creates ChatOpenAI + AgentExecutor with streaming, tools layer registers structured file/shell/search tools, TUI layer renders an ink-based interactive terminal with colored output.

**Tech Stack:** TypeScript, Node.js 18+, LangChain.js (@langchain/core, @langchain/openai, langchain), OpenAI (GPT-4o via ChatOpenAI), ink (React for CLI), dotenv, zod (bundled with LangChain)

## Global Constraints

- Node.js >= 18
- ES module resolution (`"type": "module"` in package.json)
- All source files in `src/` with `.ts` extension (JSX files use `.tsx`)
- OpenAI API key from `OPENAI_API_KEY` env var
- No external database or persistence in Iter 1
- Use `StructuredTool` from `@langchain/core/tools` for all tools
- Use `OpenAIToolsAgent` from `@langchain/openai` for agent creation
- Use `ink` for TUI, no `blessed` or other terminal libraries

---

### Task 1: Project scaffold + Config module

**Files:**
- Create: `D:\develop\navigate\package.json`
- Create: `D:\develop\navigate\tsconfig.json`
- Create: `D:\develop\navigate\.env.example`
- Create: `D:\develop\navigate\src\config\index.ts`

**Interfaces:**
- Produces: `AppConfig` type with `openAIApiKey`, `modelName`, `maxIterations`, `baseURL`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "navigate",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@langchain/core": "^0.3.0",
    "@langchain/openai": "^0.4.0",
    "langchain": "^0.3.0",
    "ink": "^5.0.0",
    "react": "^18.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "jsx": "react-jsx"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create .env.example**

```
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-4o
OPENAI_BASE_URL=
MAX_ITERATIONS=25
```

- [ ] **Step 4: Create src/config/index.ts**

```typescript
import "dotenv/config";

export interface AppConfig {
  openAIApiKey: string;
  modelName: string;
  maxIterations: number;
  baseURL?: string;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is required.");
    process.exit(1);
  }
  return {
    openAIApiKey: apiKey,
    modelName: process.env.OPENAI_MODEL || "gpt-4o",
    maxIterations: parseInt(process.env.MAX_ITERATIONS || "25", 10),
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  };
}
```

---

### Task 2: Shared types

**Files:**
- Create: `D:\develop\navigate\src\agent\types.ts`

**Interfaces:**
- Produces: `AgentConfig`, `AgentMessage`, `ToolResult` types

- [ ] **Step 1: Create src/agent/types.ts**

```typescript
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
```

---

### Task 3: LangChain model initialization

**Files:**
- Create: `D:\develop\navigate\src\agent\langchain.ts`

**Interfaces:**
- Consumes: `AppConfig` from config
- Produces: `createChatModel(config: AppConfig): ChatOpenAI`

- [ ] **Step 1: Create src/agent/langchain.ts**

```typescript
import { ChatOpenAI } from "@langchain/openai";
import type { AppConfig } from "../config/index.js";

export function createChatModel(config: AppConfig): ChatOpenAI {
  const params: ConstructorParameters<typeof ChatOpenAI>[0] = {
    model: config.modelName,
    apiKey: config.openAIApiKey,
    temperature: 0,
    streaming: true,
  };
  if (config.baseURL) {
    params.configuration = { baseURL: config.baseURL };
  }
  return new ChatOpenAI(params);
}
```

---

### Task 4: System prompt builder

**Files:**
- Create: `D:\develop\navigate\src\agent\prompt.ts`

**Interfaces:**
- Produces: `buildSystemPrompt(): string`

- [ ] **Step 1: Create src/agent/prompt.ts**

```typescript
export function buildSystemPrompt(): string {
  return `You are an AI assistant with access to a set of tools to help the user.
You can execute shell commands, read and write files, search code, and more.

Guidelines:
- Think step by step before using tools
- When the user asks to modify code, read the file first, then make precise edits
- Use execute_command for running shell commands (builds, tests, git operations)
- For file edits, prefer edit_file over write_file when making targeted changes
- List the directory first if you are unsure of the file structure
- Be concise in your responses but thorough in your actions
- If a tool fails, try to understand why and fix it before reporting failure
- Never ask the user for permission to use tools — just use them`;
}
```

---

### Task 5: Shell execution tool

**Files:**
- Create: `D:\develop\navigate\src\tools\shell.ts`

**Interfaces:**
- Produces: `createShellTool(): StructuredTool`

- [ ] **Step 1: Create src/tools/shell.ts**

```typescript
import { execSync } from "node:child_process";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export class ShellTool extends StructuredTool {
  name = "execute_command";
  description = "Execute a shell command in the current working directory. Returns stdout, stderr, and exit code.";
  schema = z.object({
    command: z.string().describe("The shell command to execute"),
    workdir: z.string().optional().describe("Working directory (defaults to cwd)"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 30000)"),
  });

  async _input({ command, workdir, timeout }: z.infer<typeof this.schema>): Promise<string> {
    try {
      const output = execSync(command, {
        cwd: workdir || process.cwd(),
        timeout: timeout || 30000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return `Exit code: 0\n\n${output}`;
    } catch (error: unknown) {
      const err = error as { status?: number; stdout?: string; stderr?: string; message?: string };
      return `Exit code: ${err.status ?? 1}\n\nstdout:\n${err.stdout || ""}\nstderr:\n${err.stderr || ""}\n${err.message || ""}`;
    }
  }
}
```

---

### Task 6: Filesystem tools

**Files:**
- Create: `D:\develop\navigate\src\tools\filesystem.ts`

**Interfaces:**
- Produces: `ReadFileTool`, `WriteFileTool`, `EditFileTool`

- [ ] **Step 1: Create src/tools/filesystem.ts**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

function checkPath(target: string): string {
  const resolved = resolve(target);
  const cwd = process.cwd();
  if (relative(cwd, resolved).startsWith("..")) {
    throw new Error(`Path outside working directory: ${target}`);
  }
  return resolved;
}

export class ReadFileTool extends StructuredTool {
  name = "read_file";
  description = "Read a file from the filesystem. Optionally specify line range.";
  schema = z.object({
    path: z.string().describe("Path to the file"),
    startLine: z.number().optional().describe("Starting line number (1-based)"),
    endLine: z.number().optional().describe("Ending line number (1-based, inclusive)"),
  });

  async _input({ path, startLine, endLine }: z.infer<typeof this.schema>): Promise<string> {
    const resolved = checkPath(path);
    const content = readFileSync(resolved, "utf-8");
    const lines = content.split("\n");
    if (startLine !== undefined || endLine !== undefined) {
      const start = startLine ?? 1;
      const end = endLine ?? lines.length;
      return lines.slice(start - 1, end).join("\n");
    }
    return content;
  }
}

export class WriteFileTool extends StructuredTool {
  name = "write_file";
  description = "Write content to a file. Creates parent directories if needed.";
  schema = z.object({
    path: z.string().describe("Path to the file"),
    content: z.string().describe("Content to write"),
  });

  async _input({ path, content }: z.infer<typeof this.schema>): Promise<string> {
    const resolved = checkPath(path);
    const dir = dirname(resolved);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(resolved, content, "utf-8");
    return `Written ${Buffer.byteLength(content, "utf-8")} bytes to ${path}`;
  }
}

export class EditFileTool extends StructuredTool {
  name = "edit_file";
  description = "Make a targeted search-and-replace edit to an existing file. Use this instead of write_file for modifications.";
  schema = z.object({
    path: z.string().describe("Path to the file"),
    old: z.string().describe("Text to search for (must be unique)"),
    new: z.string().describe("Replacement text"),
  });

  async _input({ path, old, new: newText }: z.infer<typeof this.schema>): Promise<string> {
    const resolved = checkPath(path);
    const content = readFileSync(resolved, "utf-8");
    const count = content.split(old).length - 1;
    if (count === 0) {
      throw new Error(`Could not find the exact text to replace:\n\n${old}`);
    }
    if (count > 1) {
      throw new Error(`Found ${count} occurrences — edit_file requires unique match`);
    }
    const result = content.replace(old, newText);
    writeFileSync(resolved, result, "utf-8");
    return `Edited ${path}: replaced 1 occurrence.`;
  }
}
```

---

### Task 7: Search/List tools

**Files:**
- Create: `D:\develop\navigate\src\tools\search.ts`

**Interfaces:**
- Produces: `ListFilesTool`, `SearchFilesTool`

- [ ] **Step 1: Create src/tools/search.ts**

```typescript
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execSync } from "node:child_process";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

function isWithinCwd(target: string): string {
  const resolved = resolve(target);
  const cwd = process.cwd();
  if (relative(cwd, resolved).startsWith("..")) {
    throw new Error(`Path outside working directory: ${target}`);
  }
  return resolved;
}

export class ListFilesTool extends StructuredTool {
  name = "list_files";
  description = "List files and directories at a path.";
  schema = z.object({
    path: z.string().default(".").describe("Directory path"),
    maxDepth: z.number().optional().describe("Max directory depth (default 1)"),
  });

  async _input({ path, maxDepth }: z.infer<typeof this.schema>): Promise<string> {
    const resolved = isWithinCwd(path);

    function walk(dir: string, depth: number): string[] {
      if (maxDepth !== undefined && depth > maxDepth) return [];
      const entries: string[] = [];
      try {
        const items = readdirSync(dir);
        for (const item of items) {
          const full = join(dir, item);
          const rel = relative(resolve(path), full);
          try {
            const s = statSync(full);
            if (s.isDirectory()) {
              entries.push(`${rel}/`);
              entries.push(...walk(full, depth + 1));
            } else {
              entries.push(rel);
            }
          } catch { entries.push(`${rel} (inaccessible)`); }
        }
      } catch { entries.push(`(cannot read directory)`); }
      return entries;
    }

    const lines = walk(resolved, 0);
    return lines.length ? lines.join("\n") : "(empty directory)";
  }
}

export class SearchFilesTool extends StructuredTool {
  name = "search_files";
  description = "Search for text in files using ripgrep-like pattern matching. Uses findstr on Windows.";
  schema = z.object({
    pattern: z.string().describe("Text pattern to search for"),
    path: z.string().default(".").describe("Directory to search in"),
    include: z.string().optional().describe("File pattern to include (e.g. *.ts)"),
  });

  async _input({ pattern, path, include }: z.infer<typeof this.schema>): Promise<string> {
    const resolved = isWithinCwd(path);
    let cmd: string;
    if (include) {
      cmd = `findstr /s /n /c:"${pattern}" "${resolved}\\${include}"`;
    } else {
      cmd = `findstr /s /n /c:"${pattern}" "${resolved}\\*"`;
    }
    try {
      const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
      return output.trim() || "(no matches)";
    } catch {
      return "(no matches)";
    }
  }
}
```

---

### Task 8: Tool registry

**Files:**
- Create: `D:\develop\navigate\src\tools\registry.ts`

**Interfaces:**
- Consumes: all tools from Tasks 5-7
- Produces: `createTools(): StructuredTool[]`

- [ ] **Step 1: Create src/tools/registry.ts**

```typescript
import { StructuredTool } from "@langchain/core/tools";
import { ShellTool } from "./shell.js";
import { ReadFileTool, WriteFileTool, EditFileTool } from "./filesystem.js";
import { ListFilesTool, SearchFilesTool } from "./search.js";

export function createTools(): StructuredTool[] {
  return [
    new ShellTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new ListFilesTool(),
    new SearchFilesTool(),
  ];
}
```

---

### Task 9: Agent Loop (core)

**Files:**
- Create: `D:\develop\navigate\src\agent\loop.ts`

**Interfaces:**
- Consumes: `createChatModel`, `buildSystemPrompt`, `createTools`, `AgentConfig`, `AgentEvents`
- Produces: `runAgent(input: string, events?: AgentEvents): Promise<string>`

- [ ] **Step 1: Create src/agent/loop.ts**

```typescript
import { AgentExecutor } from "langchain/agents";
import { OpenAIToolsAgent } from "@langchain/openai";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import type { ChatOpenAI } from "@langchain/openai";
import type { AgentEvents } from "./types.js";

export async function createAgentExecutor(
  llm: ChatOpenAI,
  tools: StructuredTool[],
  systemPrompt: string,
  maxIterations: number
): Promise<AgentExecutor> {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("messages"),
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  const agent = await OpenAIToolsAgent.createPrompt({
    llm,
    tools,
    prompt,
  });

  return AgentExecutor.fromAgentAndTools({
    agent,
    tools,
    maxIterations,
    earlyStoppingMethod: "generate",
    returnIntermediateSteps: true,
    handleParsingErrors: true,
  });
}

export async function runAgent(
  executor: AgentExecutor,
  input: string,
  history: BaseMessage[] = [],
  events?: AgentEvents
): Promise<string> {
  const stream = await executor.stream({
    messages: [...history, new HumanMessage(input)],
  });

  let fullOutput = "";

  for await (const chunk of stream) {
    if (chunk.actions) {
      for (const action of chunk.actions) {
        events?.onToolStart?.(action.tool, action.toolInput as Record<string, unknown>);
      }
    }
    if (chunk.steps) {
      for (const step of chunk.steps) {
        events?.onToolEnd?.({
          tool: step.action.tool,
          input: step.action.toolInput as Record<string, unknown>,
          output: step.observation,
          success: true,
          durationMs: 0,
        });
      }
    }
    if (chunk.output) {
      fullOutput += chunk.output;
      events?.onToken?.(chunk.output);
    }
  }

  events?.onFinish?.(fullOutput);
  return fullOutput;
}

export function parseHistory(history: string[]): BaseMessage[] {
  return history.map((h) => new HumanMessage(h));
}
```

---

### Task 10: TUI input component

**Files:**
- Create: `D:\develop\navigate\src\tui\input.tsx`

**Interfaces:**
- Consumes: value, onChange, onSubmit, disabled
- Produces: `<Input>` component

- [ ] **Step 1: Create src/tui/input.tsx**

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { ControlledTextInput } from "./text-input.js";

interface InputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function Input({ value, onChange, onSubmit, disabled }: InputProps) {
  const handleSubmit = (text: string) => {
    if (text.trim()) {
      onSubmit(text.trim());
    }
  };

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{"> "}</Text>
      <ControlledTextInput
        value={value}
        onChange={onChange}
        onSubmit={handleSubmit}
        disabled={disabled}
        placeholder="Type your message..."
      />
    </Box>
  );
}
```

- [ ] **Step 2: Create src/tui/text-input.tsx**

```tsx
import React, { useEffect, useRef } from "react";
import { Text } from "ink";
import type { TextProps } from "ink";

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ControlledTextInput({ value, onChange, onSubmit, disabled, placeholder }: TextInputProps) {
  const bufferRef = useRef(value);

  useEffect(() => {
    bufferRef.current = value;
  }, [value]);

  useEffect(() => {
    if (disabled) return;

    const handler = (data: Buffer) => {
      const str = data.toString();
      for (const char of str) {
        if (char === "\r" || char === "\n") {
          onSubmit(bufferRef.current);
          onChange("");
        } else if (char === "\x7f" || char === "\b") {
          bufferRef.current = bufferRef.current.slice(0, -1);
          onChange(bufferRef.current);
        } else if (char === "\x03") {
          process.exit(0);
        } else if (char.length === 1 && char >= " ") {
          bufferRef.current += char;
          onChange(bufferRef.current);
        }
      }
    };

    process.stdin.on("data", handler);
    return () => { process.stdin.off("data", handler); };
  }, [disabled, onChange, onSubmit]);

  return (
    <Text color="white">
      {value || (placeholder ? <Text dimColor>{placeholder}</Text> : null)}
      <Text backgroundColor="gray"> </Text>
    </Text>
  );
}
```

---

### Task 11: TUI output component

**Files:**
- Create: `D:\develop\navigate\src\tui\output.tsx`

**Interfaces:**
- Consumes: messages array, streaming text
- Produces: `<Output>` component

- [ ] **Step 1: Create src/tui/output.tsx**

```tsx
import React, { useRef, useEffect } from "react";
import { Box, Text } from "ink";

export interface OutputMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  timestamp: Date;
}

interface OutputProps {
  messages: OutputMessage[];
  streamingText?: string;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function MessageItem({ msg }: { msg: OutputMessage }) {
  if (msg.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>[{formatTime(msg.timestamp)}]</Text>
        <Text bold color="blue">{"> "}{msg.content}</Text>
      </Box>
    );
  }
  if (msg.role === "tool") {
    return (
      <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
        <Text dimColor>[{formatTime(msg.timestamp)}]</Text>
        <Text color="cyan">  ⚡ {msg.name || "tool"}</Text>
        <Text dimColor color="gray">
          {msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content}
        </Text>
      </Box>
    );
  }
  if (msg.role === "system") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>[{formatTime(msg.timestamp)}]</Text>
        <Text color="yellow">  {msg.content}</Text>
      </Box>
    );
  }
  // assistant
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>[{formatTime(msg.timestamp)}]</Text>
      <Text color="green">{msg.content}</Text>
    </Box>
  );
}

export function Output({ messages, streamingText }: OutputProps) {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="auto">
      {messages.map((msg, i) => (
        <MessageItem key={i} msg={msg} />
      ))}
      {streamingText ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>[流式输出]</Text>
          <Text color="green">{streamingText}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
```

---

### Task 12: TUI commands

**Files:**
- Create: `D:\develop\navigate\src\tui\commands.ts`

**Interfaces:**
- Produces: `CommandHandler`

- [ ] **Step 1: Create src/tui/commands.ts**

```typescript
const COMMANDS: Record<string, { description: string; handler: () => void }> = {};

export function registerCommand(name: string, description: string, handler: () => void): void {
  COMMANDS[name] = { description, handler };
}

export function handleCommand(input: string): string | null {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === "/exit" || cmd === "/quit") {
    process.exit(0);
    return null;
  }

  if (cmd === "/clear") {
    // Clear message: caller handles state reset
    return "CLEAR";
  }

  if (cmd === "/help") {
    const lines = ["Available commands:"];
    for (const [name, { description }] of Object.entries(COMMANDS)) {
      lines.push(`  ${name.padEnd(16)} ${description}`);
    }
    lines.push("  /exit             Exit the application");
    lines.push("  /clear            Clear the conversation");
    return lines.join("\n");
  }

  return null;
}
```

---

### Task 13: TUI App + Entry point

**Files:**
- Create: `D:\develop\navigate\src\tui\app.tsx`
- Create: `D:\develop\navigate\src\index.ts`

**Interfaces:**
- Consumes: all TUI components, agent loop, tool registry, config

- [ ] **Step 1: Create src/tui/app.tsx**

```tsx
import React, { useState, useCallback, useRef } from "react";
import { Box, Text } from "ink";
import { Input } from "./input.js";
import { Output, type OutputMessage } from "./output.js";
import { handleCommand } from "./commands.js";
import type { AgentExecutor } from "langchain/agents";

interface AppProps {
  executor: AgentExecutor;
}

export function App({ executor }: AppProps) {
  const [messages, setMessages] = useState<OutputMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const historyRef = useRef<string[]>([]);

  const onSubmit = useCallback(async (value: string) => {
    if (value.startsWith("/")) {
      const result = handleCommand(value);
      if (result === "CLEAR") {
        setMessages([]);
        historyRef.current = [];
        return;
      }
      if (result) {
        setMessages((prev) => [...prev, { role: "system", content: result, timestamp: new Date() }]);
      }
      return;
    }

    const userMsg: OutputMessage = { role: "user", content: value, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]);
    setRunning(true);
    setStreamingText("");

    try {
      const stream = await executor.stream({
        messages: [...historyRef.current.map((h) => {
          try { return JSON.parse(h); } catch { return null; }
        }).filter(Boolean), new HumanMessage(value)],
      });

      let fullOutput = "";
      for await (const chunk of stream) {
        if (chunk.actions) {
          for (const action of chunk.actions) {
            const toolMsg: OutputMessage = {
              role: "tool",
              content: `Calling: ${action.tool}\n${JSON.stringify(action.toolInput, null, 2)}`,
              name: action.tool,
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, toolMsg]);
          }
        }
        if (chunk.steps) {
          for (const step of chunk.steps) {
            const resultMsg: OutputMessage = {
              role: "tool",
              content: `Result: ${step.observation}`,
              name: step.action.tool,
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, resultMsg]);
          }
        }
        if (chunk.output) {
          fullOutput += chunk.output;
          setStreamingText(fullOutput);
        }
      }

      const assistantMsg: OutputMessage = {
        role: "assistant",
        content: fullOutput,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setStreamingText("");
      historyRef.current.push(JSON.stringify(new HumanMessage(value)));
      historyRef.current.push(JSON.stringify(new AIMessage(fullOutput)));
    } catch (error) {
      const err = error as Error;
      setMessages((prev) => [...prev, { role: "system", content: `Error: ${err.message}`, timestamp: new Date() }]);
    } finally {
      setRunning(false);
    }
  }, [executor]);

  return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="single" borderColor="green" paddingX={1}>
        <Text bold>Navigate Agent</Text>
        <Text dimColor>  (type /help for commands)</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column" overflowY="auto" minHeight={10}>
        <Output messages={messages} streamingText={running ? streamingText : undefined} />
      </Box>
      <Input value={input} onChange={setInput} onSubmit={onSubmit} disabled={running} />
      {running ? (
        <Box paddingX={1}>
          <Text color="yellow">Agent is thinking...</Text>
        </Box>
      ) : null}
    </Box>
  );
}
```

- [ ] **Step 2: Create src/index.ts**

```typescript
#!/usr/bin/env node

import "dotenv/config";
import React from "react";
import { render } from "ink";
import { App } from "./tui/app.js";
import { loadConfig } from "./config/index.js";
import { createChatModel } from "./agent/langchain.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { createAgentExecutor } from "./agent/loop.js";
import { createTools } from "./tools/registry.js";

async function main() {
  console.log("Navigate Agent - Initializing...");

  const config = loadConfig();
  const llm = createChatModel(config);
  const tools = createTools();
  const systemPrompt = buildSystemPrompt();
  const executor = await createAgentExecutor(llm, tools, systemPrompt, config.maxIterations);

  render(<App executor={executor} />);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

---

### Task 14: Verify the application runs

- [ ] **Step 1: Install dependencies**

Run: `npm install`
Expected: All packages install without errors.

- [ ] **Step 2: Create a .env file with a test API key**

Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Start the TUI**

Run: `npm run dev`
Expected: The TUI starts and shows the "Navigate Agent" header with input prompt.
