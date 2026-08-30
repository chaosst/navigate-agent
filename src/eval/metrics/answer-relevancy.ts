import { LlmJudge } from "../judge/llm-judge.js";

/**
 * 	答案是否命中问题核心
 * @param question 
 * @param answer 
 * @param judge 
 * @returns 
 */
export async function answerRelevancy(
    question: string,
    answer: string,
    judge: LlmJudge,
  ): Promise<number> {
      // 直接委托 judge.scoreAnswer
      return judge.scoreAnswer(question, answer)
  }