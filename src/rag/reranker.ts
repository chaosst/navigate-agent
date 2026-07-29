import type { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { RagResult } from "./types.js";

/**
 * Reranker — LLM-based listwise reranker
 *
 * 在 RRF 融合之后，用 LLM 重新排序候选段落。
 * LLM 会真正"阅读"查询和每个候选的内容，比只看位置信号的 RRF 更准。
 *
 * 每次调用做一次 listwise rerank：
 *   输入: 查询 + N 条候选段落
 *   输出: 重新排序后的 N 条段落
 *
 * @param llm       ChatOpenAI 实例
 * @param query     原始查询
 * @param candidates 混合检索后的候选列表（建议 10-15 条）
 * @param topK      最终返回多少条（默认 5）
 * @returns         重排后的结果
 */
export async function rerank(
  llm: ChatOpenAI,
  query: string,
  candidates: RagResult[],
  topK: number = 5,
): Promise<RagResult[]> {
  if (candidates.length <= topK) {
    // 候选本身不多，不需要重排
    return candidates;
  }

  // 截取每个候选的前 500 字符，节省 token
  const trimmed = candidates.map((c, i) => ({
    index: i,
    text: c.content.length > 500 ? c.content.slice(0, 500) + "..." : c.content,
  }));

  const systemPrompt = `You are a search result reranker. Given a query and a list of passages, rank them by relevance.

Rules:
- Focus on semantic relevance, not keyword overlap
- Output ONLY a JSON array of indices in descending order of relevance
- Example: [3, 0, 2, 1, 4]
- The array must contain every index exactly once
- Respond with valid JSON only, no explanation`;

  const passageText = trimmed
    .map((p) => `[${p.index}] ${p.text}`)
    .join("\n\n");

  const userPrompt = `Query: ${query}\n\nPassages:\n${passageText}\n\nRanked indices (JSON array):`;

  try {
    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const text = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

    // 解析 LLM 返回的 JSON 数组
    const indices = parseJsonArray(text);
    if (!indices || indices.length === 0) {
      return candidates.slice(0, topK);
    }

    // 按 LLM 给出的顺序重排
    const ordered: RagResult[] = [];
    const used = new Set<number>();

    for (const idx of indices) {
      if (idx >= 0 && idx < candidates.length && !used.has(idx)) {
        ordered.push(candidates[idx]);
        used.add(idx);
        if (ordered.length >= topK) break;
      }
    }

    // 补全漏掉的候选（LLM 可能没给全）
    for (let i = 0; i < candidates.length && ordered.length < topK; i++) {
      if (!used.has(i)) {
        ordered.push(candidates[i]);
        used.add(i);
      }
    }

    return ordered;
  } catch {
    // 重排失败不影响主流程，返回原始候选
    return candidates.slice(0, topK);
  }
}

/**
 * 从 LLM 回复中解析 JSON 数组
 *
 * LLM 可能输出：
 *   [3, 0, 2, 1, 4]
 *   ```json\n[3, 0, 2, 1, 4]\n```
 *   前后可能有空格或说明文字
 */
function parseJsonArray(text: string): number[] | null {
  // 尝试提取 ```json ... ``` 块
  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const content = jsonBlock ? jsonBlock[1].trim() : text.trim();

  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(Number).filter((n) => !isNaN(n));
    }
  } catch {
    // JSON 解析失败，尝试正则提取
  }

  // 兜底：从文本中提取 [数字, 数字, ...]
  const arrMatch = content.match(/\[([\d,\s]+)\]/);
  if (arrMatch) {
    const nums = arrMatch[1].split(",").map((s) => parseInt(s.trim(), 10));
    if (nums.length > 0 && nums.every((n) => !isNaN(n))) {
      return nums;
    }
  }

  return null;
}
