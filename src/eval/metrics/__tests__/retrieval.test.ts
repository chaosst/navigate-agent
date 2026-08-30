import { describe, expect, it } from "vitest";
import { ndcgAtK, hitRateAtK, mrrAtK } from "../retrieval.js"

const ranked = ["a", "b", "c"]

describe('retrieval 单测', () => {
    it("全命中且相关项在第 1 位", ()=>{
        expect(hitRateAtK(ranked, new Set(["a"]), 3)).toBe(1)
        expect(mrrAtK(ranked, new Set(["a"]), 3)).toBe(1)
        expect(ndcgAtK(ranked, new Set(["a"]), 3)).toBe(1)
    })

    it("部分命中", ()=>{
        expect(hitRateAtK(ranked, new Set(["b"]), 3)).toBe(1)
        expect(mrrAtK(ranked, new Set(["b"]), 3)).toBe(0.5)
        expect(Number(ndcgAtK(ranked, new Set(["b"]), 3).toFixed(2))).toBe(0.63)
    })

    it("全不中", ()=>{
        expect(hitRateAtK(ranked, new Set(["x"]), 3)).toBe(0)
        expect(mrrAtK(ranked, new Set(["x"]), 3)).toBe(0)
        expect(ndcgAtK(ranked, new Set(["x"]), 3)).toBe(0)
    })

    it("相关项在 k 之外", ()=>{
        expect(hitRateAtK(ranked, new Set(["c"]), 2)).toBe(0)
        expect(mrrAtK(ranked, new Set(["c"]), 2)).toBe(0)
        expect(ndcgAtK(ranked, new Set(["c"]), 2)).toBe(0)
    })
})