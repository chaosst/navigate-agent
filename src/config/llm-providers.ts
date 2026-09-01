/**

 * src/config/llm-providers.ts

 * 推理引擎适配层：把 "PROVIDER + env" 解析成一份可消费的 ProviderProfile。

 *

 * 模块硬约束：

 * - 纯函数，不 import dotenv、不读 process.env（只通过参数拿 env）、无 IO

 * （否则 §5.8 单测无法构造输入）

 */

/** 受支持的推理后端标识 */
export type ProviderName = "openai" | "ollama" | "vllm" | "sglang"

/** 一个 provider 解析后的完整配置快照（不可变） */
export interface ProviderProfile {
    /**
    * 归一化后的 provider 名。
    * 契约：必定是四个合法值之一（非法输入已在 parseProvider 收敛为 "openai"），
    * 下游可安全做等值比较，无需再判空/判非法。
    */
    provider: ProviderName

    /**
    * 推理端点。
    * 契约：空串 "" 是合法且有语义的值——表示"不设置 configuration.baseURL，
    * 交给 OpenAI SDK 走默认端点"。下游必须用 `if (baseURL)` 判断后再设，
    * 不能直接塞进 configuration（空串会让 SDK 请求打到相对路径而报错）。
    */
    baseURL: string

    /**

    * API key。
    * 契约：openai → 真实 key（缺失即抛错，不会走到下游）；
    * 本地后端 → provider 名本身作占位（"ollama" / "vllm" / "sglang"），
    * 本地 OpenAI 兼容层不校验 key；用 provider 名而非统一 "local"，
    * 是为了排错时从日志一眼看出命中的后端。
    */

    apiKey: string

    /** 对话模型名（ChatOpenAI 的 model 参数） */
    model: string

    /** embedding 模型名（OpenAIEmbeddings 的 model 参数），RAG/摘要/resume 向量化用 */
    embeddingModel: string

    /**
    * embedding 专用端点（OpenAIEmbeddings 的 configuration.baseURL）。
    * 契约：EMBEDDING_BASE_URL 显式设置时用它；未设置时**跟随 baseURL**（chat 与 embedding 同端点）。
    * 典型场景：chat 走 DeepSeek（云端），embedding 走本地 ollama/vLLM —— 两端点必须分开。
    * 空串语义与 baseURL 一致：不设 configuration.baseURL，交给 SDK 走默认端点。
    */
    embeddingBaseURL: string
}

/**
 * 各 provider 的内置默认值（键覆盖全部 ProviderName，用 Record 保证漏一个 tsc 就报错）。
 * 值是 Omit<ProviderProfile, "provider" | "apiKey" | "embeddingBaseURL">：
 *  - provider 由键决定、apiKey 由运行时决定，都不进默认表，
 *    避免出现"默认值里能配出 openai 的假 key"这类歧义
 *  - embeddingBaseURL 默认语义是"跟随 baseURL"，由 resolveProvider 统一回退，不进默认表
 *    （否则每个 provider 都要写两遍同样的端点，还容易写错）
 *  - openai.baseURL **必须是 ""**：openai 的端点本来就完全来自 OPENAI_BASE_URL，
 *    若在此给默认地址，会覆盖用户 .env 的语义（本表最容易写错的一格）
 */
export const PROVIDER_DEFAULTS: Record<ProviderName, Omit<ProviderProfile, "provider" | "apiKey" | "embeddingBaseURL">>
    = {
        openai: { baseURL: "", model: "gpt-4o", embeddingModel: "text-embedding-3-small" },
        ollama: { baseURL: "http://localhost:11434/v1", model: "qwen2.5:7b",           embeddingModel: "nomic-embed-text" },  
        vllm:   { baseURL: "http://localhost:8000/v1",  model: "Qwen2.5-7B-Instruct",  embeddingModel: "BAAI/bge-m3" },  
        sglang: { baseURL: "http://localhost:30000/v1", model: "Qwen2.5-7B-Instruct",  embeddingModel: "BAAI/bge-m3" }      
    };


/**
 * 把任意 PROVIDER 原始值归一为 ProviderName。
 *
 * 逻辑：
 *  - raw 严格等于 "ollama" / "vllm" / "sglang" → 返回该值
 *  - 其余一切情况（undefined、空串、大小写不符、拼错、"openai" 本身）→ 返回 "openai"
 *
 * 为什么不抛错：对齐 AGENT_MODE 的宽容惯例（非法 mode 回退 normal）。
 * 注意**不做**大小写归一化——严格等值判断，避免 "Ollama" 被静默接受后难以察觉。
 *
 * @param raw process.env.PROVIDER 的原始值，可能是 undefined
 */
export function parseProvider(raw: string | undefined): ProviderName {
    raw = raw ?? ""
    if (["ollama", "vllm", "sglang"].includes(raw)) {
        return raw as ProviderName
    }
    return "openai"
}

/**
 * 解析出完整的 ProviderProfile —— 本模块主入口。
 *
 * 逻辑（按顺序执行）：
 *  1. provider = parseProvider(env.PROVIDER)，查 PROVIDER_DEFAULTS[provider] 拿内置默认
 *  2. 三个"可覆盖字段"按同一条规则取值：**显式 env > 内置默认**
 *       baseURL        = trim(env.OPENAI_BASE_URL)   || defaults.baseURL
 *       model          = trim(env.OPENAI_MODEL)      || defaults.model
 *       embeddingModel = trim(env.EMBEDDING_MODEL)   || defaults.embeddingModel
 *     只有 trim 后为**空串**才回退默认；此规则对 openai 天然等价（它的默认值就是 OPENAI_*）
 *  2.5 embedding 端点：embeddingBaseURL = trim(env.EMBEDDING_BASE_URL) || baseURL
 *      —— 显式设置则独立于 chat 端点（DeepSeek chat + 本地 ollama embedding 的典型拆分）；
 *         未设置则跟随 baseURL（保持既有行为，向后兼容）
 *  3. apiKey 三分支（顺序不能调换）：
 *       a. trim(env.OPENAI_API_KEY) 非空 → 用它（本地后端也允许显式填真实 key）
 *       b. 为空 且 provider === "openai" → throw new Error("OPENAI_API_KEY is required but not set.")
 *          （文案必须**原样保留**：这是原 loadConfig 的文案，回归与文档/报错搜索依赖它）
 *       c. 为空 且是本地后端 → apiKey = provider（占位）
 *
 * 边界与约束：
 *  - env 中的全空白字符串按"未设置"处理（先 trim 再判空）
 *  - **不得**修改传入的 env 对象（纯函数）
 *  - **不校验** baseURL 格式/连通性——连通性由 §5.5 的 check-provider 实测负责
 *
 * @throws 仅一种情况：provider 为 openai 且 OPENAI_API_KEY 缺失/空白
 */
export function resolveProvider(env: NodeJS.ProcessEnv): ProviderProfile {
    const provider = parseProvider(env.PROVIDER)
    const def = PROVIDER_DEFAULTS[provider]

    const baseURL = env.OPENAI_BASE_URL?.trim() || def.baseURL
    const model = env.OPENAI_MODEL?.trim() || def.model
    const embeddingModel = env.EMBEDDING_MODEL?.trim() || def.embeddingModel
    const embeddingBaseURL = env.EMBEDDING_BASE_URL?.trim() || baseURL

    const profile: ProviderProfile = {
        provider,
        baseURL,
        model,
        embeddingModel,
        embeddingBaseURL,
        apiKey: ""
    }
    let apiKey = env.OPENAI_API_KEY?.trim()
    if (apiKey) {
        profile.apiKey = apiKey
        return profile
    } 
    if (provider === "openai") {
        throw new Error("OPENAI_API_KEY is required but not set.")
    }
    profile.apiKey = provider
    return profile
}