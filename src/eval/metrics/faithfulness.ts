import { ClaimVerdict, LlmJudge } from "../judge/llm-judge.js";

export function splitClaims(answer: string): string[] {
    // 规则：按 /[。！？；\n]/ 切分 → trim → 长度 >= 2 → 上限 20 条
    return answer.split(/[。！？；\n.!?;]/)
    .map(s => s.trim())
    .filter(s => s.length >= 2)
    .slice(0, 20)
}

/**
 * 答案 claims 被上下文支撑的比例
 * @param answer 
 * @param contexts 
 * @param judge 
 * @returns 
 */
export async function faithfulness(
    answer: string,
    contexts: string[],
    judge: LlmJudge
): Promise<{ score: number, claims: ClaimVerdict[] }> {
    // score = supported 数 / 总 claim 数；total === 0 → 0
    if (!answer.length || !contexts.length) {
        return { score: 0, claims: [] }
    }
    const claims = splitClaims(answer)
    if (!claims.length) {
        return { score: 0, claims: [] }
    }
    const result = await judge.verifyClaims(claims, contexts)
    const supportedCount = result.filter(r => r.supported).length
    const score = supportedCount / claims.length
    return {
        score, claims: result
    }
}