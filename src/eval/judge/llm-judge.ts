import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "langchain"

export interface ClaimVerdict {
    claim: string
    supported: boolean
    reason: string      // 一句支撑/反驳依据，供报告展示
}

export interface JudgeOptions {
    /**
     * 判定轮数（默认 1，保持旧行为与性能）。
     * rounds > 1 时，对每条 claim / 每个分数独立判定 n 次再聚合：
     *  - claim 判定（布尔）→ 逐条多数票（strict majority）
     *  - 分数（0/0.5/1 离散档）→ 众数；无唯一众数回退中位档
     * 目的：消除单次 LLM-as-judge 抖动（见 provider-eval-compare.md §5.3 的实证）。
     */
    rounds?: number
}

/**
 * LlmJudge —— LLM-as-judge 的统一入口。
 *
 * 三个调用方各自强调不同的判定标准，rounds 参数按需开启：
 *  - verifyClaims：faithfulness / contextRecall / compare-providers 的 claimCoverage 共用。
 *    prompt 允许「语义等价」（上下文用不同措辞表达同一事实 → supported），
 *    避免对同义改写零容忍导致系统性低估（provider-eval-compare.md §5.3 改进项）。
 */
export class LlmJudge {
    constructor(private llm: ChatOpenAI) {
        this.llm = llm
    }

    /**
     * 批量判定：一次 LLM 调用判断所有 claims，返回顺序与输入一致
     * @param claims
     * @param contexts
     * @param opts rounds > 1 时逐条多数表决
     */
    async verifyClaims(claims: string[], contexts: string[], opts: JudgeOptions = {}): Promise<ClaimVerdict[]> {
        if (claims.length === 0) return [];

        const rounds = Math.max(1, Math.floor(opts.rounds ?? 1));
        if (rounds === 1) return this.verifyClaimsOnce(claims, contexts);

        // ── 多数表决：每轮整批判定，逐条 claim 收集票 ──
        const votes: { supported: boolean; reason: string }[][] = claims.map(() => []);
        for (let r = 0; r < rounds; r++) {
            const verdicts = await this.verifyClaimsOnce(claims, contexts);
            verdicts.forEach((v, i) => votes[i].push({ supported: v.supported, reason: v.reason }));
        }
        return claims.map((claim, i) => majorityVerdict(claim, votes[i]));
    }

    /** 单轮判定（rounds=1 的直接路径，也是多轮表决的每一票） */
    private async verifyClaimsOnce(claims: string[], contexts: string[]): Promise<ClaimVerdict[]> {
        const claimsText = claims.map((cla, i) => `[${i}] ${cla}`).join("\n")
        // 单段 1600 / 总量 6000：claimCoverage 场景 context 是模型长答案（常 1~2k 字符），
        // 旧 500 截断会把后半段证据切掉 → judge 误判 unsupported（fact-03 实证：RAG 证据在第 950 字符后）。
        const contextsText = contexts.map((c, i) => `[上下文${i + 1}] ${c.slice(0, 1600)}`).join("\n\n")
        .slice(0, 6000)  // 总量防止token爆
        const prompts = [
            new SystemMessage(
                `你是一个严谨的文本一致性判定器。判断每条 claim 的核心含义是否能由给定上下文支持。
            规则：
            - 上下文用不同措辞、同义改写表达了同一核心事实 → supported=true（允许语义等价）
            - 只有上下文完全没有依据、必须靠常识或背景知识脑补的 claim → supported=false
            - 上下文明确陈述了与 claim 相反的内容 → supported=false
            - 只能依据提供的上下文判断，禁止把脑补当作依据
            - 输出 JSON 数组：[{"index":0,"supported":true,"reason":"不超过50字"}]
            - 只输出 JSON，不要任何解释`
            ),
            new HumanMessage(`上下文:\n${contextsText}\n\n待判定 claims: \n${claimsText}`),
        ]

        const result = await this.llm.invoke(prompts)

        // 解析（三级降级）+ 按 index 对齐
        const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        const parsed = this.parseClaimsVerdicts(text)
        
        return claims.map((claim, i) => {
            const v = parsed.find((p) => p.index === i)
            return { claim, supported: v?.supported ?? false, reason: v?.reason ?? "parse-failed"}
        })
    }

    private parseClaimsVerdicts(text: string): { index: number; supported: boolean; reason?: string }[] {
        const parsed = this.extractJson(text);
        if (Array.isArray(parsed)) {
            return parsed.filter((v) => v && typeof v.index === "number" && typeof v.supported === "boolean")
                .map((v) => ({ index: v.index, supported: v.supported, reason: String(v.reason ?? "") }));
        }
        // 正则兜底：从文本里抠 {index, supported}
        const out = [];
        const re = /\{\s*"index"\s*:\s*(\d+)\s*,\s*"supported"\s*:\s*(true|false)[^}]*\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) out.push({ index: +m[1], supported: m[2] === "true" });
        return out;
    }

    private extractJson(text: string): unknown {
        const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);   // ① JSON 块
        const candidate = block ? block[1].trim() : text.trim();
        try { return JSON.parse(candidate); } catch { /* ② 裸 JSON */ }
        const start = candidate.search(/[[{]/);
        const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
        if (start >= 0 && end > start) {
            try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* ③ 正则兜底留给调用方 */ }
        }
        return null;
    }

    /**
     * 判定 answer 是否回答了 question 的核心，返回 0-1（离散档：0 / 0.5 / 1）
     * @param question
     * @param answer
     * @param opts rounds > 1 时多次判定取众数档
     */
    async scoreAnswer(question: string, answer: string, opts: JudgeOptions = {}): Promise<number> {
        const rounds = Math.max(1, Math.floor(opts.rounds ?? 1));
        if (rounds === 1) return this.scoreOnce(question, answer);

        const scores: number[] = [];
        for (let r = 0; r < rounds; r++) {
            scores.push(await this.scoreOnce(question, answer));
        }
        return majorityScore(scores);
    }

    /** 单次评分（rounds=1 直接路径 + 多轮的每一票） */
    private async scoreOnce(question: string, answer: string): Promise<number> {
        const result = await this.llm.invoke([
            new SystemMessage(`
                你是答案相关性评分器。判断 answer 是否回答了 question，按 question 包含的
                全部子问题与约束逐项核对，再给出三档分数之一：
                - 1.0：完整回答了所有子问题与约束，精准命中核心
                - 0.5：与问题相关但只回答了部分子问题 / 遗漏约束 / 答到边缘 / 混入多余内容
                - 0.0：核心答非所问或关键内容完全缺失
                - score 只允许 0、0.5、1 三个值
                - 输出 JSON：{"score":0.5,"reason":"不超过50字"}，只输出 JSON
                `),
            new HumanMessage(`Question: ${question}\n\nAnswer: ${answer}`)
        ])
        
        const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        const obj = this.parseScoreObject(text)
        return Math.max(0, Math.min(1, typeof obj?.score === 'number' ? obj.score : 0)) // clamp 防越界
    }

    private parseScoreObject(text: string) {
        const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);   // ① JSON 块
        const candidate = block ? block[1].trim() : text.trim();
    
        try { return JSON.parse(candidate); } catch { /* ② 裸 JSON */ }

        const m = text.match(/"score"\s*:\s*([0-9.]+)/);
        return m ? { score: Number(m[1]) } : null;
    }
}

// ── 多轮聚合（取多数 / 众数）───────────────────────────────────────────────

/** 布尔票多数：严格多数才判 true；平票（偶数轮）保守取 false */
export function majorityVerdict(claim: string, votes: { supported: boolean; reason: string }[]): ClaimVerdict {
    if (votes.length === 0) return { claim, supported: false, reason: "no-rounds" };
    const yes = votes.filter((v) => v.supported).length;
    const supported = yes > votes.length / 2;
    // reason 取多数那一侧的最后一票（保证与最终结论同侧、可读）
    let reason = votes[votes.length - 1].reason;
    for (let i = votes.length - 1; i >= 0; i--) {
        if (votes[i].supported === supported) { reason = votes[i].reason; break; }
    }
    return { claim, supported, reason };
}

/**
 * 分数众数：先把原始分离散到 {0, 0.5, 1} 三档（0.25 与 0.75 为分界），
 * 再取出现最多的档；无唯一众数（三档各一票）回退中位档 0.5。
 * 与 scoreAnswer 的 prompt「score 只允许 0/0.5/1」保持一致。
 */
export function majorityScore(scores: number[]): number {    const bucket = (s: number) => (s < 0.25 ? 0 : s >= 0.75 ? 1 : 0.5);
    const counts = new Map<number, number>();
    for (const s of scores) {
        const b = bucket(Math.max(0, Math.min(1, s)));
        counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestCount = 0;
    for (const [b, n] of counts) {
        if (n > bestCount) { best = b; bestCount = n; }
    }
    if (bestCount > scores.length / 2) return best ?? 0.5;
    // 无严格多数：按原始分取中位档，避免 0/0.5/1 各一票时武断归零
    const sorted = scores.slice().sort((a, b) => a - b);
    return bucket(sorted[Math.floor(sorted.length / 2)] ?? 0.5);
}
