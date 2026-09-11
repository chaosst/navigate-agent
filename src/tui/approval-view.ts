import { PERMISSION_LABEL, type ToolPermission } from "../tools/permission.js";

/** 单键数字快选的上限（一位数字） */
const QUICK_PICK_MAX = 9;

/** 审批决定（与 HumanResponse 的 approval.decision 对齐） */
export type ApprovalDecision = "allow" | "always" | "deny";

/**
 * 按键 → 决定。返回 null 表示"不是决定键"，交给理由输入缓冲。
 * Esc 走 deny（用户想立刻中断）。
 */
export function resolveApprovalKey(input: { ch?: string; escape?: boolean }): ApprovalDecision | null {
  if (input.escape) return "deny";
  const ch = input.ch ?? "";
  if (ch === "y" || ch === "Y") return "allow";
  if (ch === "a" || ch === "A") return "always";
  if (ch === "n" || ch === "N") return "deny";
  return null;
}

/** 数字快选：'1'..'n' 映射到选项值；越界/非数字/无选项 → null */
export function optionIndexToValue(ch: string, options?: string[]): string | null {
  if (!options || options.length === 0) return null;
  if (!/^[1-9]$/.test(ch)) return null;
  const idx = Number(ch) - 1;
  return options[idx] ?? null;
}

/**
 * 参数摘要：单行超长截断、总长超限截断，避免撑爆 TUI 动态区。
 * 循环引用 / 不可序列化一律兜底成 String()，绝不抛。
 */
export function summarizeArgs(args: unknown, maxValueLength = 200, maxTotal = 800): string {
  if (args === undefined || args === null) return "（无参数）";
  let text: string;
  if (typeof args === "string") {
    text = args;
  } else {
    try {
      text = JSON.stringify(args, null, 2) ?? String(args);
    } catch {
      text = String(args);
    }
  }
  const lines = text
    .split("\n")
    .map((line) => (line.length > maxValueLength ? `${line.slice(0, maxValueLength)} …` : line));
  const joined = lines.join("\n");
  return joined.length > maxTotal ? `${joined.slice(0, maxTotal)}\n…（参数过长已截断）` : joined;
}

/** 单行截断（不换行，避免撑爆审批卡片） */
function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 单个参数值 → 紧凑单行文本（字符串原样，其余走 JSON；循环引用兜底 String） */
function inlineValue(v: unknown, max = 120): string {
  if (typeof v === "string") return clamp(v, max);
  if (v === undefined) return "undefined";
  try {
    return clamp(JSON.stringify(v) ?? String(v), max);
  } catch {
    return clamp(String(v), max);
  }
}

/** 读取字符串参数（非字符串 / 空串 → undefined） */
function argString(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 读取数字参数 */
function argNumber(args: unknown, key: string): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 对象参数 → 紧凑单行 `key=value  key2=value2`。
 *
 * 替代 summarizeArgs 的多行 pretty JSON：审批卡片两行就够看清，缩进花括号纯噪音。
 * （summarizeArgs 保留——它是通用参数摘要工具，仍有单测覆盖。）
 */
export function compactArgs(args: unknown, max = 200): string {
  if (args === undefined || args === null) return "（无参数）";
  if (typeof args === "string") return clamp(args, max);
  if (typeof args !== "object") return clamp(String(args), max);
  const entries = Object.entries(args as Record<string, unknown>).map(
    ([k, v]) => `${k}=${inlineValue(v)}`,
  );
  return entries.length === 0 ? "（无参数）" : clamp(entries.join("  "), max);
}

/**
 * 工具调用 → 一句人话（审批卡片正文）。
 *
 * 语义边界要说清楚：这是从**参数推导**的意图，不是模型自述的目的。模型调用前说的
 * 那句「我打算…」在 AIMessage 里，没有透传到 HumanRequest。要显示后者需要给
 * HumanRequest 加 intent 字段并让它随调用传下来，改动面大一档；先用推导版。
 */
export function describeIntent(tool: string, args: unknown): string {
  const rawPath = argString(args, "path") ?? argString(args, "file_path");
  const path = rawPath ?? "(未知路径)";
  const dir = rawPath ?? ".";
  const query = argString(args, "query");
  switch (tool) {
    case "write_file": {
      const content = argString(args, "content") ?? "";
      return `写入文件 ${path}（${content.length} 字符）`;
    }
    case "edit_file":
      return `修改文件 ${path}`;
    case "read_file":
      return `读取文件 ${path}`;
    case "list_files": {
      const depth = argNumber(args, "maxDepth");
      return `列出目录 ${dir}${depth !== undefined ? `（深度 ${depth}）` : ""}`;
    }
    case "search_files": {
      const pattern = argString(args, "pattern");
      return `在 ${dir} 中搜索${pattern ? `“${clamp(pattern, 60)}”` : `（${compactArgs(args)}）`}`;
    }
    case "execute_command": {
      const cmd = argString(args, "command");
      return cmd ? `执行命令 ${clamp(cmd, 120)}` : `执行命令（${compactArgs(args)}）`;
    }
    case "web_search":
      return `联网搜索${query ? `“${clamp(query, 60)}”` : `（${compactArgs(args)}）`}`;
    case "search_documents":
      return `检索知识库${query ? `“${clamp(query, 60)}”` : `（${compactArgs(args)}）`}`;
    case "delegate": {
      const agent = argString(args, "agent") ?? "子";
      const task = argString(args, "task");
      return `委派 ${agent} agent：${task ? clamp(task, 80) : compactArgs(args)}`;
    }
    default:
      // 未知工具（含 MCP / skills 动态注册的）：退回紧凑参数，至少不 dump JSON
      return compactArgs(args);
  }
}

/** 审批卡片文案：一行身份（工具名 + 权限档），一行人话意图 */
export function formatApproval(tool: string, args: unknown, permission: string): string {
  const label = PERMISSION_LABEL[permission as ToolPermission] ?? permission;
  return [`[需确认] ${tool}  ${label}`, `  → ${describeIntent(tool, args)}`].join("\n");
}

/** 三档按键提示 */
export function approvalHint(): string {
  return "[y] 允许一次    [a] 本次运行总是允许    [n] 拒绝";
}

/** 提问卡片文案 */
export function formatQuestion(question: string, options?: string[]): string {
  const lines = [`[提问] ${question}`];
  if (options && options.length > 0) {
    options.forEach((opt, i) => {
      lines.push(i < QUICK_PICK_MAX ? `  ${i + 1}. ${opt}` : `  - ${opt}`);
    });
    if (options.length > QUICK_PICK_MAX) {
      lines.push(`仅前 ${QUICK_PICK_MAX} 项支持数字快选，其余请直接输入`);
    }
    lines.push("按数字快选，或直接输入回答后回车");
  } else {
    lines.push("输入回答后回车提交");
  }
  return lines.join("\n");
}
