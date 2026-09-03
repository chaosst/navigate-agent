import { ChatOpenAI } from "@langchain/openai";
import { PgVectorStore } from "../../storage/pg-vector-store.js";
import { RagEvalSample } from "../types.js";
import { RagResult } from "../../rag/types.js";
import { LlmJudge } from "../judge/llm-judge.js";
import { faithfulness } from "../metrics/faithfulness.js";
import { answerRelevancy } from "../metrics/answer-relevancy.js";
import { contextRecall } from "../metrics/context-recall.js";
import { hitRateAtK, mrrAtK, ndcgAtK } from "../metrics/retrieval.js";
import { contextPrecision } from "../metrics/context-precision.js";
import { HumanMessage, SystemMessage } from "langchain";


export interface RagEvalOptions {
    samples: RagEvalSample[]
    store: PgVectorStore        // 注入现有检索实例
    llm: ChatOpenAI             // 生成答案
    /** 独立 judge（可选）。判分若与被测共用同一 llm → self-preference bias；
     *  跨后端对比必须传独立实例（如固定 DeepSeek），见 provider-eval-compare.md §8 P3 */
    judge?: ChatOpenAI
    k?: number                  // 默认5
}

export interface RagEvalSampleResult {
    sample: RagEvalSample
    contexts: RagResult[]                   // 原始检索结果
    contextKeys: string[]                   // "docId:chunkIndex"，与标注比对
    answer: string                          // 生成的答案
    failed?: string                         // 单条评估失败原因（report 汇总时排除，避免 0 分污染均值）
    metrics: {
        hitRate: number
        mrr: number
        ndcg: number
        contextPrecision: number | null     // 样本没标注 relevantChunks → null
        contextRecall: number | null        // 样本没标注 referenceClaims → null
        faithfulness: number
        answerRelevancy: number
    }
}

export async function runRagEval(opts: RagEvalOptions): Promise<{ results: RagEvalSampleResult[] }> {
    if (!opts.judge) {
        // 解耦提示只在整批开头打一次，不刷屏
        console.warn("[eval] judge 与被测共用同一 llm（self-preference bias）。跨后端对比请传独立 judge，如 JUDGE_BASE_URL/JUDGE_MODEL。");
    }
    const results: RagEvalSampleResult[] = [];

    for (let sample of opts.samples) {
        try {
            const r = await processSample(sample, opts)
            results.push(r)
        } catch (e) {
            // 单条失败绝不能中断整批 —— 记下来继续跑
            console.error(`[eval] sample ${sample.id} failed:`, (e as Error).message);
            results.push(createFailedResult(sample, e));  // 或跳过，报告里留痕
        }
        console.log(`[eval] ${results.length}/${opts.samples.length} done`);  // 长跑批的进度
    }
    return { results };
}

function createFailedResult(sample: RagEvalSample, e: unknown): RagEvalSampleResult {
    return {
        sample,
        contexts: [],
        contextKeys: [],
        answer: (e as Error).message,
        failed: (e as Error).message,
        metrics: {
            hitRate: 0,
            mrr: 0,
            ndcg: 0,
            contextPrecision: null,
            contextRecall: null,
            faithfulness: 0,
            answerRelevancy: 0
        }
    }
}

async function processSample(sample: RagEvalSample, opts: RagEvalOptions): Promise<RagEvalSampleResult> {
    const k = opts.k ?? 5

    // 检索
    const contexts = await opts.store.search(sample.question, k)
    const contextKeys = contexts.map((c) => `${c.docId}:${c.chunkIndex ?? -1}`)

    // 生成
    const answer = await generateAnswer(opts.llm, sample.question, contexts)

    // 六路指标 -- judge 默认复用生成 llm；opts.judge 提供时（跨后端对比）用独立实例
    const judge = new LlmJudge(opts.judge ?? opts.llm)
    const relevant = new Set(sample.relevantChunks ?? [])
    const hasAnnotation = !!sample.relevantChunks?.length

    const [faithfulnessRes, ar, cr] = await Promise.all([
        faithfulness(answer, contexts.map(c => c.content), judge),
        answerRelevancy(sample.question, answer, judge),
        sample.referenceClaims?.length
            ? contextRecall(sample.referenceClaims, contexts.map(c => c.content), judge)
            : Promise.resolve({
                score: null, claims: []
            })
    ])

    return {
        sample,
        contexts,
        contextKeys,
        answer,
        metrics: {
            hitRate: hitRateAtK(contextKeys, relevant, k),
            mrr: mrrAtK(contextKeys, relevant, k),
            ndcg: ndcgAtK(contextKeys, relevant, k),
            contextPrecision: hasAnnotation ? contextPrecision(contextKeys, relevant, k).score : null,
            contextRecall: cr.score,
            faithfulness: faithfulnessRes.score,
            answerRelevancy: ar
        }
    }
}

async function generateAnswer(llm: ChatOpenAI, question: string, contexts: RagResult[]): Promise<string>{
    const answer = await llm.invoke([
        new SystemMessage(`
            你是一个强大且专业的RAG检索答案输出生成器，根据question和RAG检索结果contexts，生成出精准的回答，规则如下：
            - 只依据RAG搜索出来的上下文进行生成，禁止编造
            - 按md文档风格的自然语言字符串生成答案
            `),
        new HumanMessage(`questions: ${question}\n\ncontexts:\n${contexts.map((c, i) => `context${i+1}: ${c.content}`).join("\n")}`)
    ])

    return  typeof answer.content === "string" ? answer.content : JSON.stringify(answer.content);
}