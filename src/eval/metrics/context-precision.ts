/**
 * Context Precision@k —— 位置加权精度
 *
 * 核心思想：检索结果里"相关的 chunk 越靠前"，说明检索质量越高。
 * 它惩罚"相关项排在后面"的情况（前面一堆无关结果，即使最终也召回了相关项，分也低）。
 *
 * 公式：CP@k = Σ(i=1..k) precision@i × rel(i) / Σ(i=1..k) rel(i)
 *   rel(i)      = 第 i 位 chunk 是否相关（标注，0 或 1）
 *   precision@i = 前 i 个 chunk 中相关的比例（即 hitCount / i）
 *
 * 直觉理解（面试能讲）：
 *   - 分母 Σrel(i) = 相关 chunk 的总数，是归一化因子
 *   - 每个相关位 i 贡献 precision@i 分，position 越靠前 precision@i 越高
 *   - 相关项全部排在最前面 → CP = 1.0；相关项排在最后 → CP 趋近 0
 */

export interface ContextPrecisionResult {
  score: number;
  /** 每一位的判定明细，供报告展示"为什么是这个分" */
  positions: { index: number; relevant: boolean; precision: number }[];
}

/**
 * 相关 chunk 是否靠前
 * @param ranked   检索排序后的 chunk key 列表（形如 "docId:chunkIndex"）
 * @param relevant 人工标注的相关 chunk key 集合
 * @param k        只看前 k 位
 */
export function contextPrecision(
  ranked: string[],
  relevant: Set<string>,
  k: number,
): ContextPrecisionResult {
  // k 超过数组长度时截断，避免越界
  const limit = Math.min(k, ranked.length);
  const positions: { index: number; relevant: boolean; precision: number }[] = [];

  let hitCount = 0;    // 前 i+1 个位置中相关的累计个数（用于算 precision@i）
  let numerator = 0;   // Σ precision@i × rel(i)
  let denominator = 0; // Σ rel(i)

  for (let i = 0; i < limit; i++) {
    const isRel = relevant.has(ranked[i]);
    if (isRel) hitCount++;

    // precision@i = 前 i+1 个里相关的比例（i 从 0 开始，所以分母是 i+1）
    const precision = hitCount / (i + 1);
    positions.push({ index: i, relevant: isRel, precision });

    // 只有"相关位"才进分子/分母；无关位只影响后续 precision@i 的值
    if (isRel) {
      numerator += precision;
      denominator += 1;
    }
  }

  return {
    score: denominator === 0 ? 0 : numerator / denominator,
    positions,
  };
}
