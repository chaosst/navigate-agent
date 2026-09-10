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

/** 审批卡片文案（无 emoji；权限标签复用既有 PERMISSION_LABEL） */
export function formatApproval(tool: string, args: unknown, permission: string): string {
  const label = PERMISSION_LABEL[permission as ToolPermission] ?? permission;
  return [`[需确认] ${tool}  ${label}`, summarizeArgs(args)].join("\n");
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
