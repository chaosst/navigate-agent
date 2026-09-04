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

/** 遍历/搜索时跳过的噪音目录（node_modules/.git/构建产物/缓存/agent 家目录等），避免大目录把工具拖垮 + 结果塞爆上下文 */
const NOISE_DIRS = [
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".output",
  ".turbo",
  "__pycache__",
  // 工具/编辑器/agent 缓存目录——常是 junction 指向整个家目录（如 .claude），跟随即灾难
  ".claude",
  ".agents",
  ".codex",
  ".idea",
  ".vscode",
  ".cache",
  ".npm",
];

/** 反斜杠字符（fromCharCode 避免源码里写反斜杠字面量的转义地狱） */
const BS = String.fromCharCode(92);

/** 取一行的路径段（按 / 与 \ 切分），用于判断是否落在噪音目录里 */
function lineHasNoiseDir(line: string): boolean {
  for (const name of NOISE_DIRS) {
    const segRe = new RegExp(`(^|[${BS}/])${name}([${BS}/]|$)`);
    if (segRe.test(line)) return true;
  }
  return false;
}

/** 搜索结果返回上限（字符）：搜索工具可产出 MB 级命中，进上下文前必须截断 */
const SEARCH_RESULT_MAX_CHARS = 50_000;

/** 过滤噪音目录命中行 + 截断到返回上限 */
function postprocessSearchOutput(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (lineHasNoiseDir(line)) continue;
    kept.push(line);
  }
  let out = kept.join("\n");
  if (out.length > SEARCH_RESULT_MAX_CHARS) {
    out =
      out.slice(0, SEARCH_RESULT_MAX_CHARS) +
      `\n…[结果过多已截断：共 ${out.length} 字符，建议用 include/更精确 pattern 缩小范围]…`;
  }
  return out.trim() || "(no matches)";
}

export class ListFilesTool extends StructuredTool {
  name = "list_files";
  description =
    "Recursively list files and directories under a given path with indentation (skips node_modules/.git/dist and symlinked dirs). Directories are shown with a trailing '/'.";
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
      const items = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of items) {
        // 符号链接目录（junction 可能指向整个家目录）绝不跟随；噪音目录直接跳过（省 statSync + 防拖垮）
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && NOISE_DIRS.includes(entry.name)) continue;
        const fullPath = join(dirPath, entry.name);
        const indent = "  ".repeat(currentDepth);
        try {
          if (entry.isDirectory()) {
            entries.push(`${indent}${entry.name}/`);
            entries.push(...this.listDir(fullPath, currentDepth + 1, maxDepth));
          } else {
            entries.push(`${indent}${entry.name}`);
          }
        } catch {
          entries.push(`${indent}${entry.name} (unreadable)`);
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
    "Search for text patterns in files (literal text). In a git repo uses `git grep`, which skips node_modules/.venv and other ignored directories and is fast; elsewhere falls back to Windows findstr. Returns matching lines with line numbers.";
  schema = z.object({
    pattern: z.string().describe("Literal text pattern to search for"),
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
    const safePath = checkPath(process.cwd(), inputPath);
    const resolvedPath = resolve(safePath);

    // 首选 git grep：git 工作树内自动跳过 node_modules/.venv 等被忽略目录，单次 100ms 级。
    // findstr /s 无目录排除、会跟随 junction 与嵌套 venv（曾单次扫 15 分钟 + 10MB 命中进上下文），只作非 git 回退。
    const viaGit = gitGrepSearch(resolvedPath, pattern, include);
    if (viaGit !== null) return viaGit;
    return findstrFallback(resolvedPath, pattern, include);
  }
}

/** git 工作树内用 git grep 搜索；不可用（非 git 树/出错）返回 null 交由 findstr 回退 */
function gitGrepSearch(root: string, pattern: string, include?: string): string | null {
  let top: string;
  try {
    top = execSync(`git -C "${root}" rev-parse --show-toplevel`, { encoding: "utf-8" }).trim();
  } catch {
    return null; // 非 git 树
  }
  const rel = relative(top, root);
  if (rel.startsWith("..") || rel.startsWith(BS + BS)) return null; // root 不在该 work tree 内

  const isFile = (() => {
    try { return statSync(root).isFile(); } catch { return false; }
  })();
  const safePattern = pattern.replace(/"/g, ""); // 引号进 cmd 会破坏参数边界，直接剔除
  let pathspec: string;
  if (isFile) {
    pathspec = `"${rel}"`;
  } else if (include) {
    pathspec = `":(glob)${rel === "" ? "" : rel + "/"}**/${include}"`;
  } else {
    pathspec = rel === "" ? "." : `"${rel}"`;
  }
  const cmd = `git -C "${top}" grep -F -n -e "${safePattern}" -- ${pathspec}`;
  try {
    const out = execSync(cmd, { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
    return postprocessSearchOutput(out);
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return "(no matches)"; // git grep 无命中 = exit 1
    return null; // 其他异常（如路径问题）→ findstr 回退
  }
}

/** 非 git 场景回退：按顶层条目逐个 findstr /s，跳过噪音与符号链接目录 */
function findstrFallback(root: string, pattern: string, include?: string): string {
  const escapedPattern = pattern.replace(/"/g, "");
  const targets: string[] = [];
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory() && NOISE_DIRS.includes(e.name)) continue;
      targets.push(join(root, e.name));
    }
  } catch {
    targets.push(root); // root 本身可能是文件而非目录
  }
  if (targets.length === 0) return "(no matches)";

  const collected: string[] = [];
  let approxLen = 0;
  const isFile = (p: string) => {
    try { return statSync(p).isFile(); } catch { return false; }
  };
  for (const t of targets) {
    if (approxLen >= SEARCH_RESULT_MAX_CHARS) break; // 已够，不再多扫
    let cmd: string;
    if (isFile(t)) {
      cmd = `cmd.exe /c findstr /n /c:"${escapedPattern}" "${t}"`;
    } else if (include) {
      cmd = `cmd.exe /c findstr /s /n /c:"${escapedPattern}" "${join(t, include)}"`;
    } else {
      cmd = `cmd.exe /c findstr /s /n /c:"${escapedPattern}" "${join(t, "*")}"`;
    }
    for (const ln of runFindstrLines(cmd)) {
      if (!ln.trim()) continue;
      collected.push(ln);
      approxLen += ln.length;
    }
    if (approxLen >= SEARCH_RESULT_MAX_CHARS) break;
  }
  return postprocessSearchOutput(collected.join("\n"));
}

/** 跑一次 findstr；无命中时 execSync 抛错（非零退出码），取其 stdout 返回 */
function runFindstrLines(cmd: string): string[] {
  try {
    const out = execSync(cmd, { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
    return out.split(/\r?\n/);
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string };
    if (err.stdout && err.stdout.trim()) return err.stdout.split(/\r?\n/);
    return [];
  }
}
