/**
 * delegate 事件卡：TUI 实时显示子 agent 委托过程的纯函数集。
 *
 * 设计约束（帧高纪律，见 layout.ts 顶部注释）：
 * 一次委托只占**一张卡**，childTool 事件原地更新内容而不是追加新卡——
 * 子 agent 一轮能调 8+ 次工具，每调用开一张卡会把 dynamic 帧撑爆。
 * 卡片正文行数恒定 ≤ 3 行（标题 / 任务 / 最近一次子工具调用或终态）。
 */
import type { OutputMessage } from "./output.js";

/** 一次委托的实时活动状态（TUI 侧按 runId 记账） */
export interface DelegateActivity {
  agent: string;
  task: string;
  /** child 工具调用累计次数 */
  count: number;
  /** 最近一次子工具调用预览（如 `read_file({"path":"src/…"})`） */
  lastTool?: string;
}

/** delegate 事件卡的稳定 key（同 runId 原地更新，不另开新卡） */
export function delegateCardKey(runId: string): string {
  return `delegate:${runId}`;
}

/** 按 key 找卡片下标；找不到返回 -1 */
export function findCardIndexByKey(buffer: OutputMessage[], key: string): number {
  return buffer.findIndex((m) => m.key === key);
}

/**
 * 按 key 原地替换卡片；返回新 buffer。找不到返回 null（调用方决定兜底）。
 * 注意：卡溢出进 <Static> 后不在 buffer 里 → null，此时应走兜底而不是静默丢。
 */
export function patchCardByKey(
  buffer: OutputMessage[],
  key: string,
  patch: (msg: OutputMessage) => OutputMessage,
): OutputMessage[] | null {
  const idx = findCardIndexByKey(buffer, key);
  if (idx < 0) return null;
  return buffer.map((m, i) => (i === idx ? patch(m) : m));
}

/** 任务行截断（卡片正文行数有界，任务再长也只占一行） */
function taskLineOf(task: string): string {
  return task.length > 100 ? task.slice(0, 100) + "…" : task;
}

/**
 * 组装卡片正文。行结构固定：
 *   🤖 委派 code 子 agent        ← 第一行（折叠态只显示这行，必须自解释）
 *   <任务前 100 字>
 *   ⚡ read_file(...)（第 3 次工具调用）   ← 进行中才有
 *   ✓ 子 agent 完成：5 次工具调用 · 返回 1.2k 字  ← 终态行
 */
export function renderDelegateBody(a: DelegateActivity, finalLine?: string): string {
  const lines = [`🤖 委派 ${a.agent} 子 agent`, taskLineOf(a.task)];
  if (finalLine) {
    lines.push(finalLine);
  } else if (a.lastTool) {
    lines.push(`⚡ ${a.lastTool}（第 ${a.count} 次工具调用）`);
  }
  return lines.join("\n");
}

/** 终态行：成功带次数与产出规模，失败带原因 */
export function delegateFinalLine(a: DelegateActivity | undefined, ok: boolean, outputChars: number, error?: string): string {
  if (!ok) return `✗ 子 agent 失败：${error ?? "未知错误"}`;
  const count = a?.count ?? 0;
  const size = outputChars >= 1000 ? `${(outputChars / 1000).toFixed(1)}k` : `${outputChars}`;
  return `✓ 子 agent 完成：${count} 次工具调用 · 返回 ${size} 字`;
}

/** 父步骤 observation 摘要行（子 agent 终稿预览，追加到已 settle 的卡上） */
export function delegateResultLine(observation: string): string {
  const text = observation.replace(/^\[子 agent \w+ 返回\]\n?/, "").trim();
  return text.length > 160 ? `⤷ ${text.slice(0, 160)}…` : `⤷ ${text}`;
}
