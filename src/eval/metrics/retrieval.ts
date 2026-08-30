/**
 * 检索结果里有没有相关 chunk
 * @param ranked 
 * @param relevant 
 * @param k 
 * @returns 
 */
export function hitRateAtK(ranked: string[], relevant: Set<string>, k: number): number {
    return ranked.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

/**
 * 第一个相关的排第几
 * @param ranked 
 * @param relevant 
 * @param k 
 * @returns 
 */
export function mrrAtK(ranked: string[], relevant: Set<string>, k: number): number {
    const idx = ranked.slice(0, k).findIndex((id) => relevant.has(id));
    return idx === -1 ? 0 : 1 / (idx + 1);
}

/**
 * 相关 chunk 的位置加权
 * @param ranked 
 * @param relevant 
 * @param k 
 * @returns 
 */
export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
    const dcg = ranked.slice(0, k).reduce((s, id, i) => s + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
    const ideal = Math.min(relevant.size, k);
    const idcg = Array.from({ length: ideal }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    return idcg === 0 ? 0 : dcg / idcg;
}