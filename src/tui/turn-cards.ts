/**
 * turn-cards.ts — 当轮工具卡片的合并 / 折叠纯函数集。
 *
 * 解决两类问题（2026-09-18）：
 * 1. 连续同名工具调用一张卡搞定（×N 计数），不再一次调用一张卡刷屏；
 * 2. 当轮卡片超预算时折叠最老的普通工具卡，**绝不回合中途写 <Static>**——
 *    回合中途插 Static 会让终端滚动、Ink 的 eraseLines 擦错区域，
 *    「状态行重复多行」「画面跳顶/震动」都源于此（见 layout.ts 顶部注释）。
 *
 * plan 卡（🗺️ Plan: 前缀）、delegate / PTC 等带 key 或 ptc 数据的卡片
 * 有自己的原地更新逻辑，一律不参与合并与折叠。
 */
import type { OutputMessage } from "./output.js";
import { PLAN_MESSAGE_MARKER } from "./plan-utils.js";

/** 折叠卡的稳定 key（每轮最多一张，原地更新计数） */
export const FOLD_CARD_KEY = "tools:folded";

/** 普通工具卡：可合并 / 可折叠。无 key、无 PTC 数据、非 delegate、已结算 */
export function isPlainToolCard(m: OutputMessage): boolean {
  return m.role === "tool" && !m.key && !m.ptc && !m.running && !!m.name && m.name !== "delegate";
}

function isPlanCard(m: OutputMessage): boolean {
  return typeof m.content === "string" && m.content.startsWith(PLAN_MESSAGE_MARKER);
}

/** 多行 detail 压成单行预览（合并卡只保留最近一次的摘要） */
function oneLine(text: string, max = 160): string {
  return text.replace(/\s*\n+\s*/g, " ").trim().slice(0, max);
}

/**
 * normal 模式 onToolStart：末尾是同名已结算普通工具卡 → 原地转 running
 * （callCount 保留已完成次数，settle 时 +1）；否则追加一张新 running 卡。
 */
export function pushToolCallStart(buffer: OutputMessage[], tool: string, argsJson: string): OutputMessage[] {
  const lastIdx = buffer.length - 1;
  const last = lastIdx >= 0 ? buffer[lastIdx] : undefined;
  const content = `Calling: ${tool}\n${argsJson}`;
  if (last && isPlainToolCard(last) && last.name === tool) {
    const next = buffer.slice();
    next[lastIdx] = { ...last, running: true, callCount: last.callCount ?? 1, content, timestamp: new Date() };
    return next;
  }
  return [
    ...buffer,
    { role: "tool", name: tool, content, timestamp: new Date(), running: true },
  ];
}

/**
 * 结算一次工具调用（normal onToolEnd / plan 步骤卡共用）：
 * - 末尾是本工具的 running 卡 → 摘掉，次数并入合并计数；
 * - 末尾是同名已结算普通工具卡 → 合并成 `×N · 最近摘要`；
 * - 否则追加一张单次卡（content 保持完整 detail，Static 历史不丢信息）。
 */
export function settleToolCall(buffer: OutputMessage[], tool: string, detailLine: string): OutputMessage[] {
  const lastIdx = buffer.length - 1;
  const last = lastIdx >= 0 ? buffer[lastIdx] : undefined;
  const hadRunning = !!last && last.running && last.role === "tool" && !last.key;
  const base = hadRunning ? buffer.slice(0, -1) : buffer;
  // running 卡的 callCount = 转换前已完成的同名调用次数（pushToolCallStart 写入）
  const priorRunningCount = hadRunning ? (last!.callCount ?? 0) : 0;

  const tIdx = base.length - 1;
  const target = tIdx >= 0 ? base[tIdx] : undefined;
  const canMerge = !!target && isPlainToolCard(target) && target.name === tool;
  const count = (canMerge ? (target!.callCount ?? 1) : 0) + priorRunningCount + 1;
  const content = count > 1 ? `×${count} · ${oneLine(detailLine)}` : detailLine;

  if (canMerge) {
    const next = base.slice();
    next[tIdx] = { ...target!, callCount: count, content, timestamp: new Date() };
    return next;
  }
  return [...base, { role: "tool", name: tool, callCount: count, content, timestamp: new Date() }];
}

/**
 * 当轮卡片总数超预算时，从最老开始折叠普通工具卡进折叠卡
 * （`⋯ 更早的 N 次工具调用已折叠`）；无可折叠时丢最老的非关键卡
 * （plan / 带 key / running 卡豁免）。纯函数：返回新 buffer，绝不写 <Static>。
 */
export function capTurnCards(buffer: OutputMessage[], limit: number): OutputMessage[] {
  let next = buffer;
  while (next.length > limit) {
    const foldIdx = next.findIndex(isPlainToolCard);
    if (foldIdx >= 0) {
      const removed = next[foldIdx];
      next = next.slice(0, foldIdx).concat(next.slice(foldIdx + 1));
      next = addFold(next, removed.name ?? "tool");
      continue;
    }
    const dropIdx = next.findIndex((m) => !m.running && !m.key && !isPlanCard(m));
    if (dropIdx < 0) break; // 只剩 plan / keyed / running 关键卡 → 容忍暂时超限
    next = next.slice(0, dropIdx).concat(next.slice(dropIdx + 1));
  }
  return next;
}

function addFold(buffer: OutputMessage[], toolName: string): OutputMessage[] {
  const idx = buffer.findIndex((m) => m.key === FOLD_CARD_KEY);
  const prevCount = idx >= 0 ? (buffer[idx].callCount ?? 0) : 0;
  const count = prevCount + 1;
  const card: OutputMessage = {
    role: "tool",
    name: "tools",
    key: FOLD_CARD_KEY,
    callCount: count,
    content: `⋯ 更早的 ${count} 次工具调用已折叠（最近：${toolName}）`,
    timestamp: new Date(),
  };
  if (idx >= 0) {
    const next = buffer.slice();
    next[idx] = card;
    return next;
  }
  return [...buffer, card];
}
