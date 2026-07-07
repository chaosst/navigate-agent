import { config } from "dotenv";

config();

export interface AppConfig {
  openAIApiKey: string;
  modelName: string;
  maxIterations: number;
  baseURL: string;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is required but not set.");
    process.exit(1);
  }

  return {
    openAIApiKey: apiKey,
    modelName: process.env.OPENAI_MODEL ?? "gpt-4o",
    maxIterations: parseInt(process.env.MAX_ITERATIONS ?? "25", 10),
    baseURL: process.env.OPENAI_BASE_URL ?? "",
  };
}
