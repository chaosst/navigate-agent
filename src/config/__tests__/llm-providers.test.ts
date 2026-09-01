import { describe, expect, it } from "vitest";
import { parseProvider, resolveProvider } from "../llm-providers.js";


describe("模型切换注入单测", () => {
    it("parseProvider 缺省与非法值回退 openai", () => {
        [undefined , "" , "ptc" , "Ollama"].forEach(i => {
            expect(parseProvider(i)).toBe("openai")
        })
    })

    it("parseProvider 识别三个本地 provider", () => {
        ["ollama" , "vllm" , "sglang"].forEach(i => {
            expect(parseProvider(i)).toBe(i)
        })
    })

    it("resolveProvider openai 取显式 env 且缺 key 抛错", () => {
        const provider = resolveProvider({ PROVIDER: "openai", OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "deepseek-v4-flash" })
        expect(provider.provider).toEqual("openai")
        expect(provider.baseURL).toEqual("")
        expect(provider.apiKey).toEqual("sk-test")
        expect(provider.embeddingModel).toEqual("text-embedding-3-small")
        expect(provider.model).toEqual("deepseek-v4-flash")
        expect(() => resolveProvider({ PROVIDER: "openai" })).toThrow(
            "OPENAI_API_KEY is required but not set."
        );
    })

    it("resolveProvider ollama 无 key 时占位且用内置默认", () => {
        const provide = resolveProvider({ PROVIDER:"ollama" })
        expect(provide.apiKey).toEqual("ollama")
        expect(provide.baseURL).toEqual("http://localhost:11434/v1")
        expect(provide.model).toEqual("qwen2.5:7b")
        expect(provide.embeddingModel).toEqual("nomic-embed-text")
        // EMBEDDING_BASE_URL 未设置 → embeddingBaseURL 跟随 baseURL
        expect(provide.embeddingBaseURL).toEqual("http://localhost:11434/v1")
    })

    it("resolveProvider EMBEDDING_BASE_URL 显式设置时独立于 baseURL", () => {
        const provide = resolveProvider({
            PROVIDER:"openai",
            OPENAI_API_KEY:"sk-test",
            OPENAI_BASE_URL:"https://api.deepseek.com",
            EMBEDDING_BASE_URL:"http://localhost:11434/v1",
            EMBEDDING_MODEL:"nomic-embed-text",
        })
        expect(provide.baseURL).toEqual("https://api.deepseek.com")
        expect(provide.embeddingBaseURL).toEqual("http://localhost:11434/v1")
        expect(provide.embeddingModel).toEqual("nomic-embed-text")
    })

    it("resolveProvider EMBEDDING_BASE_URL 空白串按未设置回退 baseURL", () => {
        const provide = resolveProvider({ PROVIDER:"ollama", EMBEDDING_BASE_URL:" " })
        expect(provide.embeddingBaseURL).toEqual("http://localhost:11434/v1")
    })

    it("resolveProvider 显式 env 覆盖内置默认", () => {
        const provide = resolveProvider({ PROVIDER:"ollama", OPENAI_MODEL:"qwen2.5:14b" })
        expect(provide.apiKey).toEqual("ollama")
        expect(provide.baseURL).toEqual("http://localhost:11434/v1")
        expect(provide.model).toEqual("qwen2.5:14b")
        expect(provide.embeddingModel).toEqual("nomic-embed-text")
    })

    it("resolveProvider 空白字符串按未设置处理", () => {
        const provide = resolveProvider({ PROVIDER:"vllm", OPENAI_BASE_URL:" " })
        expect(provide.baseURL).toEqual("http://localhost:8000/v1")
    })
})