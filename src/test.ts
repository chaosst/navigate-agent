import { HumanMessage } from "langchain";
import { createHierarchicalAgent } from "./agent/loop.js";
import { loadConfig } from "./config/index.js";
import { createChatModel } from "./agent/langchain.js";
import { createTools } from "./tools/registry.js";

const config = loadConfig();
const llm = createChatModel(config);

const agent = await createHierarchicalAgent(llm, createTools());

for await (const chunk of agent.stream({
  messages: [new HumanMessage("分析项目代码结构")],
  config: {
    maxTokens: 100000,
    maxTimeMs: 300000,
    maxSteps: 20,
  },
})) {
  if (chunk.plan) {
    console.log("Plan updated:", chunk.plan);
  }
  if (chunk.intermediateSteps) {
    for (const step of chunk.intermediateSteps) {
      console.log(`Tool: ${step.action.tool}`);
    }
  }
  if (chunk.output) {
    console.log("Final:", chunk.output);
  }
}