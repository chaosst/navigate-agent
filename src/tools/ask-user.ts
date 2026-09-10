import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { HumanChannel } from "./human-channel.js";

const schema = z.object({
  question: z.string().describe("要问用户的问题，写清楚你需要什么信息或让用户在什么之间做选择"),
  options: z
    .array(z.string())
    .optional()
    .describe("可选项（可选）。给出后用户可按数字快选，也能自由输入"),
});

/**
 * ask_user：agent 主动停下来问用户，把回答当工具结果继续推理。
 * 与审批共用同一条 HumanChannel —— 任一时刻只有一个待答槽位，不会"同时问两件事"。
 * 权限为 read（无副作用），因此自身不会触发审批。
 */
export class AskUserTool extends StructuredTool {
  name = "ask_user";
  description =
    "向用户提问并等待回答。当你需要用户做决定、缺少只有用户知道的信息、或需要确认一个无法从工具推断的前提时使用。" +
    "可选地给 options 让用户快选。返回用户的回答文本。";
  schema = schema;

  private channel: HumanChannel;

  constructor(channel: HumanChannel) {
    super();
    this.channel = channel;
  }

  async _call(input: z.infer<typeof schema>): Promise<string> {
    try {
      const res = await this.channel.request({
        kind: "question",
        question: input.question.trim(),
        options: input.options,
      });
      if (res.kind !== "question") return "[unexpected response]";
      const answer = res.answer.trim();
      return answer.length > 0 ? answer : "[empty answer]";
    } catch (e) {
      return `[ask_user failed] ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
