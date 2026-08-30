import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "langchain"

export interface ClaimVerdict {
    claim: string
    supported: boolean
    reason: string      // 一句支撑/反驳依据，供报告展示
}

export class LlmJudge {
    constructor(private llm: ChatOpenAI) {
        this.llm = llm
    }

    /**
     * 批量判定：一次 LLM 调用判断所有 claims，返回顺序与输入一致
     * @param claims 
     * @param contexts 
     */
    async verifyClaims(claims: string[], contexts: string[]): Promise<ClaimVerdict[]> {
        if (claims.length === 0) return [];

        const claimsText = claims.map((cla, i) => `[${i}] ${cla}`).join("\n")
        const contextsText = contexts.map((c, i) => `[上下文${i + 1}] ${c.slice(0, 500)}`).join("\n\n")
        .slice(0, 3000)  // 总量防止token爆
        const prompts = [
            new SystemMessage(
                `你是一个严谨的文本一致性判定器。判断每条 claim 是否能由给定上下文直接推出。
            规则：
            - 只能依据提供的上下文判断，上下文没提到的 claim 一律标 supported=false
            - 禁止用常识、背景知识脑补
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
     * 判定 answer 是否回答了 question 的核心，返回 0-1
     * @param question 
     * @param answer 
     */
    async scoreAnswer(question: string, answer: string): Promise<number> {
        const result = await this.llm.invoke([
            new SystemMessage(`
                你是答案相关性评分器。判断 answer 是否回答了 question
                规则：
                - 1.0：精准命中问题核心；0.5： 只回答了部分/答非核心；0.0： 完全答非所问
                - 输出 JSON：{"score":0.x,"reason":"不超过50字"}，只输出 JSON
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