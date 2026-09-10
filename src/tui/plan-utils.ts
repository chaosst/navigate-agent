/**
 * plan-utils.ts — plan 模式下 plan 消息的不可变更新工具
 *
 * 抽取为独立纯函数以便单测；plan 渲染逻辑：
 * 每次收到 chunk.plan 时，找到消息列表里最后一条以 "🗺️ Plan:" 开头的 system 消息替换它；
 * 找不到才 append，避免每次 executor 步骤完成都重刷完整 plan 造成刷屏。
 */

export interface PlanMessage {
  /** 实际消息列表里会混入 user/assistant/tool 等角色；plan 替换逻辑不挑 role */
  role: string;
  content: string;
  timestamp: Date;
}

/** plan 消息的识别前缀 */
export const PLAN_MESSAGE_MARKER = "🗺️ Plan:";

/**
 * 不可变地更新消息列表中的 plan 消息：
 * 替换最后一条 content 以 PLAN_MESSAGE_MARKER 开头的消息；无则追加。
 * 其他消息保持原样（浅拷贝 + 一处替换/末尾追加）。
 */
export function updatePlanMessage<M extends PlanMessage>(prev: M[], planText: string): M[] {
  let planIdx = -1;
  for (let i = prev.length - 1; i >= 0; i--) {
    const c = (prev[i] as any)?.content;
    if (typeof c === "string" && c.startsWith(PLAN_MESSAGE_MARKER)) {
      planIdx = i;
      break;
    }
  }
  const newMsg = { role: "system", content: planText, timestamp: new Date() } as unknown as M;
  if (planIdx >= 0) {
    const next = prev.slice();
    next[planIdx] = newMsg;
    return next;
  }
  return [...prev, newMsg];
}
