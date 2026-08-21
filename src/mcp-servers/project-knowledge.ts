#!/usr/bin/env node
/**
 * project-knowledge MCP Server
 *
 * 一个简单的 MCP Server，暴露项目相关的工具和资源。
 * 通过 STDIO 传输，与 navigate Agent 通信。
 *
 * 使用方式：
 *   注册到 .env 的 MCP_SERVERS 即可自动发现。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// ════════════════════════════════════════════
//  Server 初始化
// ════════════════════════════════════════════

const server = new Server(
  {
    name: "project-knowledge",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},      // 提供可调用的工具
      resources: {},  // 提供可读取的数据资源
      prompts: {},    // 提供预置提示词模板
    },
  },
);

// ════════════════════════════════════════════
//  工具定义
// ════════════════════════════════════════════

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_project_stats",
        description: "统计当前项目的文件数量和类型分布",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get_recent_commits",
        description: "获取最近的 Git 提交记录",
        inputSchema: {
          type: "object",
          properties: {
            count: {
              type: "number",
              description: "要返回的提交数量（默认 5）",
            },
          },
          required: [],
        },
      },
      {
        name: "find_large_files",
        description: "查找项目中超过指定大小的文件",
        inputSchema: {
          type: "object",
          properties: {
            minKB: {
              type: "number",
              description: "最小文件大小（KB，默认 100）",
            },
            dir: {
              type: "string",
              description: "搜索目录（默认 src/）",
            },
          },
          required: [],
        },
      },
    ],
  };
});

// ════════════════════════════════════════════
//  工具执行
// ════════════════════════════════════════════

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_project_stats":
        return { content: [{ type: "text", text: getProjectStats() }] };

      case "get_recent_commits":
        return { content: [{ type: "text", text: getRecentCommits((args as any)?.count ?? 5) }] };

      case "find_large_files":
        return {
          content: [
            {
              type: "text",
              text: findLargeFiles(
                (args as any)?.minKB ?? 100,
                (args as any)?.dir ?? "src",
              ),
            },
          ],
        };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// ════════════════════════════════════════════
//  提示词模板（Prompts）
//  MCP prompts 是预置的提示词模板，Client 可以拉取后作为 LLM 输入。
//  它不是"可调用的工具"，而是"可获取的提示词"。
// ════════════════════════════════════════════

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "review_code",
        description: "生成一个代码审查提示词，让 LLM 检查指定文件的代码质量",
        arguments: [
          {
            name: "filePath",
            description: "要审查的文件路径",
            required: true,
          },
        ],
      },
      {
        name: "explain_module",
        description: "生成一个模块解释提示词，让 LLM 解释指定目录的作用",
        arguments: [
          {
            name: "modulePath",
            description: "模块路径（如 src/agent）",
            required: true,
          },
        ],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "review_code": {
      const filePath = (args as any)?.filePath ?? "";
      return {
        description: `Code review for ${filePath}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please review the following file and analyze:\n`
                + `1. Potential bugs or logical errors\n`
                + `2. Code style and best practices\n`
                + `3. Performance issues\n`
                + `4. Security concerns\n\n`
                + `File: ${filePath}\n\n`
                + `Read the file content using the read_file tool first, then provide your review.`,
            },
          },
        ],
      };
    }

    case "explain_module": {
      const modulePath = (args as any)?.modulePath ?? "";
      return {
        description: `Explain module: ${modulePath}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Explain the purpose and architecture of the "${modulePath}" module.\n`
                + `Please cover:\n`
                + `1. What this module does\n`
                + `2. Its key files and classes\n`
                + `3. How it fits into the overall project\n`
                + `4. Entry points and dependencies\n\n`
                + `Use list_files and read_file tools to explore the module first.`,
            },
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// ════════════════════════════════════════════
//  资源定义（MCP 资源是 Server 暴露给 Client 的数据）
// ════════════════════════════════════════════

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "project://structure",
        name: "Project Structure",
        description: "项目的目录结构树",
        mimeType: "text/plain",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === "project://structure") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: buildTree("."),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ════════════════════════════════════════════
//  辅助函数
// ════════════════════════════════════════════

function getProjectStats(): string {
  const extensions = new Map<string, number>();
  let totalFiles = 0;
  let totalDirs = 0;

  function walk(dir: string): void {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            totalDirs++;
            walk(fullPath);
          } else {
            totalFiles++;
            const ext = entry.includes(".") ? entry.split(".").pop()!.toLowerCase() : "(no ext)";
            extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable */ }
  }

  walk(".");

  const lines: string[] = [
    `📊 Project Stats`,
    `Total files: ${totalFiles}`,
    `Total dirs:  ${totalDirs}`,
    ``,
    `File types:`,
    ...Array.from(extensions.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `  .${ext}: ${count}`),
  ];

  return lines.join("\n");
}

function getRecentCommits(count: number): string {
  try {
    const output = execSync(`git log --oneline -${Math.min(count, 20)}`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return output.trim() || "(no commits found)";
  } catch {
    return "(not a git repository or git not available)";
  }
}

function findLargeFiles(minKB: number, dir: string): string {
  if (!existsSync(dir)) return `Directory "${dir}" not found.`;

  const largeFiles: { path: string; sizeKB: number }[] = [];

  function walk(current: string): void {
    try {
      const entries = readdirSync(current);
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
        const fullPath = join(current, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (stat.size > minKB * 1024) {
            largeFiles.push({ path: relative(".", fullPath), sizeKB: Math.round(stat.size / 1024) });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walk(dir);

  if (largeFiles.length === 0) return `No files larger than ${minKB}KB found in "${dir}".`;

  largeFiles.sort((a, b) => b.sizeKB - a.sizeKB);
  const lines = largeFiles.map((f) => `${f.sizeKB}KB  ${f.path}`);
  return `Files > ${minKB}KB in "${dir}":\n${lines.join("\n")}`;
}

function buildTree(dir: string, depth = 0, maxDepth = 3): string {
  if (depth > maxDepth) return "";
  const lines: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const fullPath = join(dir, entry);
      const indent = "  ".repeat(depth);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          lines.push(`${indent}${entry}/`);
          lines.push(buildTree(fullPath, depth + 1, maxDepth));
        } else {
          lines.push(`${indent}${entry}`);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return lines.join("\n");
}

// ════════════════════════════════════════════
//  启动
// ════════════════════════════════════════════

const transport = new StdioServerTransport();
await server.connect(transport);
