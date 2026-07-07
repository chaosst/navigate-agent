import { ChatOpenAI } from "@langchain/openai";
import type { AppConfig } from "../config/index.js";

export function createChatModel(config: AppConfig): ChatOpenAI {
  const params: ConstructorParameters<typeof ChatOpenAI>[0] = {
    model: config.modelName,
    apiKey: config.openAIApiKey,
    temperature: 0,
    streaming: true,
  };
  if (config.baseURL) {
    params.configuration = { baseURL: config.baseURL };
  }
  return new ChatOpenAI(params);
}
