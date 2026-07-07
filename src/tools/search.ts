import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execSync } from "node:child_process";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Prevent directory traversal attacks by ensuring the resolved path
 * stays within the base directory.
 */
function checkPath(base: string, target: string): string {
  const baseResolved = resolve(base);
  const targetResolved = resolve(base, target);
  if (
    !targetResolved.toLowerCase().startsWith(baseResolved.toLowerCase())
  ) {
    throw new Error(`Path traversal detected: ${target}`);
  }
  return targetResolved;
}

export class ListFilesTool extends StructuredTool {
  name = "list_files";
  description =
    "Recursively list files and directories under a given path with indentation. Directories are shown with a trailing '/'.";
  schema = z.object({
    path: z.string().default(".").describe("Root path to list"),
    maxDepth: z
      .number()
      .optional()
      .describe("Maximum recursion depth"),
  });

  private listDir(
    dirPath: string,
    currentDepth: number,
    maxDepth?: number,
  ): string[] {
    if (maxDepth !== undefined && currentDepth > maxDepth) {
      return [];
    }

    const entries: string[] = [];
    try {
      const items = readdirSync(dirPath);
      for (const item of items) {
        const fullPath = join(dirPath, item);
        const indent = "  ".repeat(currentDepth);
        try {
          const stats = statSync(fullPath);
          if (stats.isDirectory()) {
            entries.push(`${indent}${item}/`);
            entries.push(
              ...this.listDir(fullPath, currentDepth + 1, maxDepth),
            );
          } else {
            entries.push(`${indent}${item}`);
          }
        } catch {
          entries.push(`${indent}${item} (unreadable)`);
        }
      }
    } catch {
      // skip unreadable directories at this level
    }
    return entries;
  }

  protected async _call({
    path: inputPath,
    maxDepth,
  }: z.infer<typeof this.schema>): Promise<string> {
    try {
      const safePath = checkPath(process.cwd(), inputPath);
      const entries = this.listDir(safePath, 0, maxDepth);
      if (entries.length === 0) {
        return "(empty)";
      }
      return entries.join("\n");
    } catch (error: unknown) {
      const err = error as Error;
      return `Error: ${err.message}`;
    }
  }
}

export class SearchFilesTool extends StructuredTool {
  name = "search_files";
  description =
    "Search for text patterns in files using findstr (Windows). Returns matching lines with line numbers.";
  schema = z.object({
    pattern: z.string().describe("Text pattern to search for"),
    path: z.string().default(".").describe("Directory to search in"),
    include: z
      .string()
      .optional()
      .describe("File glob pattern (e.g. *.ts, *.md)"),
  });

  protected async _call({
    pattern,
    path: inputPath,
    include,
  }: z.infer<typeof this.schema>): Promise<string> {
    try {
      const safePath = checkPath(process.cwd(), inputPath);
      const resolvedPath = resolve(safePath);

      // Build findstr command for Windows
      const escapedPattern = pattern.replace(/"/g, '\\"');
      let cmd: string;
      if (include) {
        cmd = `cmd.exe /c findstr /s /n /c:"${escapedPattern}" "${resolvedPath}\\${include}"`;
      } else {
        cmd = `cmd.exe /c findstr /s /n /c:"${escapedPattern}" "${resolvedPath}\\*"`;
      }

      const output = execSync(cmd, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return output.trim() || "(no matches)";
    } catch (error: unknown) {
      const err = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      // findstr exits with non-zero when no matches are found
      if (err.stdout && err.stdout.trim()) {
        return err.stdout.trim();
      }
      return "(no matches)";
    }
  }
}
