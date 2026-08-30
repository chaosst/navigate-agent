import { ClaimVerdict, LlmJudge } from "../judge/llm-judge.js"


export interface ContextRecallResult {
    score: number
    claims: ClaimVerdict[] // 每条 reference claim 的判定明细
}

/**
 * Context Recall —— 标准答案断言有多少被"检索到的上下文"覆盖的比例
 * 与 faithfulness 结构相同，但 claim 来源不同：
 *   faithfulness: claim 来自 answer（模型生成，检验"答得忠不忠实"）
 *   context-recall: claim 来自 referenceClaims（人工标注，检验"检得全不全"）
 */
export async function contextRecall(
    referenceClaims: string[],
    contexts: string[],     // 检索结果的 content 数组
    judge: LlmJudge
): Promise<ContextRecallResult> {
    // score = supported / total；total === 0 → { score: 0, claims: [] }
    const result = await judge.verifyClaims(referenceClaims, contexts)
    if (result.length === 0) {
        return {
            score: 0,
            claims: []
        }
    }
    const supportedCount = result.filter(r => r.supported).length
    return {
        score: supportedCount / result.length,
        claims: result
    }
}