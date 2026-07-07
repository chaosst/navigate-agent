import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

function validatePath(unsafePath: string): string {
  const resolved = resolve(unsafePath);
  const cwd = process.cwd();
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..")) {
    throw new Error(
      `Path escape detected: ${unsafePath} resolves outside workspace (${cwd})`,
    );
  }
  return resolved;
}

export class ReadFileTool extends StructuredTool {
  name = "read_file";
  description =
    "Read a file from the filesystem. Optionally specify startLine and endLine (1-based) to read a range of lines.";
  schema = z.object({
    path: z.string().describe("Path to the file to read"),
    startLine: z
      .number()
      .optional()
      .describe("Starting line number (1-based, inclusive)"),
    endLine: z
      .number()
      .optional()
      .describe("Ending line number (1-based, inclusive)"),
  });

  protected async _call({
    path,
    startLine,
    endLine,
  }: z.infer<typeof this.schema>): Promise<string> {
    const resolved = validatePath(path);

    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${path}`);
    }

    const content = readFileSync(resolved, "utf-8");

    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split("\n");
      const start = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
      const end =
        endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
      return lines.slice(start, end).join("\n");
    }

    return content;
  }
}

export class WriteFileTool extends StructuredTool {
  name = "write_file";
  description =
    "Write content to a file. Creates parent directories if they don't exist.";
  schema = z.object({
    path: z.string().describe("Path to the file to write"),
    content: z.string().describe("Content to write to the file"),
  });

  protected async _call({
    path,
    content,
  }: z.infer<typeof this.schema>): Promise<string> {
    const resolved = validatePath(path);
    const parentDir = dirname(resolved);

    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    writeFileSync(resolved, content, "utf-8");
    const bytesWritten = Buffer.byteLength(content, "utf-8");
    return `Written ${bytesWritten} bytes to ${path}`;
  }
}

export class EditFileTool extends StructuredTool {
  name = "edit_file";
  description =
    "Search and replace text in a file. Exactly one occurrence of `old` must exist, otherwise an error is returned.";
  schema = z.object({
    path: z.string().describe("Path to the file to edit"),
    old: z.string().describe("The exact text to find (must match exactly once)"),
    new: z.string().describe("The replacement text"),
  });

  protected async _call({
    path,
    old,
    new: newText,
  }: z.infer<typeof this.schema>): Promise<string> {
    const resolved = validatePath(path);

    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${path}`);
    }

    const content = readFileSync(resolved, "utf-8");

    const occurrences = content.split(old).length - 1;

    if (occurrences === 0) {
      throw new Error(`No matches found for: ${old}`);
    }

    if (occurrences > 1) {
      throw new Error(`Multiple matches (${occurrences}) found for: ${old}`);
    }

    const newContent = content.replace(old, newText);
    writeFileSync(resolved, newContent, "utf-8");
    return `Replaced 1 occurrence in ${path}`;
  }
}
