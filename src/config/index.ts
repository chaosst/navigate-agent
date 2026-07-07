import { config } from "dotenv";

export interface AppConfig {
  openAIApiKey: string;
  modelName: string;
  maxIterations: number;
  baseURL: string;
}

export function loadConfig(): AppConfig {
  config();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required but not set.");
  }

  const maxIterationsRaw = parseInt(process.env.MAX_ITERATIONS ?? "25", 10);
  const maxIterations = Number.isNaN(maxIterationsRaw) ? 25 : maxIterationsRaw;

  return {
    openAIApiKey: apiKey,
    modelName: process.env.OPENAI_MODEL ?? "gpt-4o",
    maxIterations,
    baseURL: process.env.OPENAI_BASE_URL ?? "",
  };
}
