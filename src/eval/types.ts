

export interface RagEvalSample {
    id: string
    question: string
    /** 标准答案中的关键断言，用于 faithfulness / context-recall */
    referenceClaims: string[]
    /** 相关 chunk 标注："docId:chunkIndex"，与 RRF 的 key 对齐 */
    relevantChunks?: string[]
    referenceAnswer?: string
}

export interface MetricResult {
    name: string
    value: number   // 0-1
    perSample?: {
        sampleId: string
        value:number
    } []
    detail?: Record<string ,unknown>
}

export interface EvalReport {
    createdAt: string
    metrics: MetricResult[]
    samples: unknown[]  // 明细，M3 再细化
}