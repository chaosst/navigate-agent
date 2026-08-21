import type { AgentMessage } from "../agent/types.js";

/**
 * ContextManager — Token 感知的上下文窗口管理器
 *
 * 职责：把无限增长的对话历史截断到指定 token 预算内。
 * 策略：从最旧的消息开始丢弃，保留最新的 N 轮。
 *
 * 为什么不用 tiktoken？
 *   - tiktoken 对第三方模型（DeepSeek 等）需要注册才支持
 *   - 每次截断前还要调 LLM 的 getNumTokens()，多一次异步调用
 *   - 改用字符估算，速度快 1000 倍，误差在 10% 以内
 */
export class ContextManager {
  private maxBudget: number;
  private responseReserve: number;

  constructor(maxBudget = 6000, responseReserve = 2000) {
    this.maxBudget = maxBudget;
    this.responseReserve = responseReserve;
  }

  /**
   * 估算文本的 token 数
   *
   * 经验公式：
   *   - ASCII 字符（英文、数字、符号）：约 4 字符/token
   *   - 非 ASCII 字符（中文、日文等）：约 1.5 字符/token
   *   - 空格和换行：不计
   */
  estimateTokens(text: string): number {
    let count = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code === 0x20 || code === 0x0a || code === 0x0d) continue; // space/newline
      if (code > 0x7f) {
        count += 1.5; // CJK
      } else {
        count += 0.25; // ASCII
      }
    }
    return Math.ceil(count);
  }

  /**
   * 截断消息列表到 token 预算内
   *
   * @param messages  原始消息列表（从旧到新）
   * @param input     当前用户输入（不计入预算，但估算时要做减法）
   * @returns         截断后的消息列表
   */
  truncate(messages: AgentMessage[], input: string): AgentMessage[] {
    if (messages.length === 0) return [];

    // 计算可用预算
    const inputTokens = this.estimateTokens(input);
    // 还为 system prompt + tool definitions 预留
    const available = this.maxBudget - this.responseReserve - inputTokens - 500;

    if (available <= 0) {
      // 极端情况：输入太长，只保留最后一条
      return messages.slice(-1);
    }

    // 从最旧到最新算 token，超了就从旧开始丢
    // 但至少保留最后 2 轮（4 条消息）
    const minKeep = Math.min(4, messages.length);

    // 从最新向旧数，找第一个不超过 budget 的位置
    let tokenCount = 0;
    let cutIndex = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const tokens =
        this.estimateTokens(msg.content) +
        (msg.role === "assistant" ? 10 : 5); // 角色标签的开销

      if (tokenCount + tokens > available && i < messages.length - minKeep) {
        // 超过 budget 且已经保留了至少 minKeep 条
        cutIndex = i + 1;
        break;
      }

      tokenCount += tokens;
    }

    const result = messages.slice(cutIndex);
    return result;
  }
}
