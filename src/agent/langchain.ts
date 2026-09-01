import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import type { AppConfig } from "../config/index.js";

export function createChatModel(config: AppConfig): ChatOpenAI {
  const params: ConstructorParameters<typeof ChatOpenAI>[0] = {
    model: config.modelName,
    apiKey: config.openAIApiKey,
    temperature: 0,
    streaming: true,
    timeout: 30000,       // 30s LLM timeout
    maxRetries: 2,
  };
  if (config.baseURL) {
    params.configuration = { baseURL: config.baseURL };
  }
  return new ChatOpenAI(params);
}

/**
 * 新增：embedding 客户端工厂，与 createChatModel 同源。
 * 为什么要有这个函数（顺带修的历史 bug）：
 *  src/index.ts 与 src/server-entry.ts 此前直接 `new OpenAIEmbeddings({ apiKey, model })`
 *  **没传 baseURL**。当 OPENAI_BASE_URL 指向 DeepSeek 这类自建端点时，embedding 请求实际
 *  发往 OpenAI 官方端点、用 DeepSeek 的 key，必然失败——只是被 PgVectorStore 的
 *  "无模型自动降级关键词"掩盖了。统一收口到本函数后，baseURL 跟着 provider 走。
 */
export function createEmbeddings(config: AppConfig): OpenAIEmbeddings {
  // 参数类型用 OpenAIEmbeddings 自己的构造参数（此前误借用 ChatOpenAI 的，
  // 会带出 temperature/streaming 这类 embedding 根本不认识的字段，类型不严谨）。
  const params: ConstructorParameters<typeof OpenAIEmbeddings>[0] = {
    model: config.embeddingModel,
    apiKey: config.openAIApiKey,
    timeout: 30000,       // 30s embedding timeout
    maxRetries: 2,
  };
  // 端点选择：embeddingBaseURL 优先（EMBEDDING_BASE_URL 显式设置 = chat/embedding 拆分，
  // 典型如 DeepSeek chat + 本地 ollama embedding）；未设置时 resolveProvider 已回退到 baseURL。
  if (config.embeddingBaseURL) {
    params.configuration = { baseURL: config.embeddingBaseURL };
  }
  return new OpenAIEmbeddings(params)
}