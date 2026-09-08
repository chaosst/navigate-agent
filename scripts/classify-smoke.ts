import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { resolveProvider } from "../src/config/llm-providers.js";
import { applyModeRules, CLASSIFIER_SYSTEM } from "../src/agent/mode-router.js";
import type { RouteDecision } from "../src/agent/mode-router.js";

/**
 * classify-smoke.ts — auto 档 LLM 分类提示词（CLASSIFIER_SYSTEM）真实打表。
 *
 * 干什么：把「输入 → 规则层 → LLM 兜底分类」全链路对着真实 LLM（默认 DeepSeek）逐条跑，
 *         打印 LLM 原始返回（验证"只输出 JSON"约束是否稳定），并给出解析后的 mode/reason。
 * 看什么：
 *   1) JSON 合法性（坏 JSON = 提示词约束失效，会走 fallback normal，需调提示词）
 *   2) 分类符合预期（plan/normal 倾向是否对——决定升档质量）
 *   3) 规则层拦截了多少（零成本路径，不该花钱的样例不进 LLM）
 * 用法：npm run mode:classify   （.env 需已配好 provider；离线会逐条 fallback）
 */
interface Sample {
  input: string;
  /** 期望档位；null = 不预设（观察用） */
  expect: "plan" | "normal" | null;
  note: string;
}

const SAMPLES: Sample[] = [
  // ---- 规则层应拦截（零 LLM 成本）----
  { input: "你好", expect: "normal", note: "寒暄→规则层直接 normal" },
  { input: "把 src 下所有模块重构一遍，并按模块补单元测试", expect: "plan", note: "重构→规则层 plan" },
  { input: "先读取配置再更新引用然后跑测试", expect: "plan", note: "先…再…然后→规则层 plan" },
  { input: "对整个项目做一次梳理，给出模块化建议", expect: "plan", note: "梳理/模块化→规则层 plan" },
  // ---- LLM 兜底（规则 miss、长度够，真实走分类器）----
  { input: "解释一下什么是 pgvector 的工作原理吧", expect: "normal", note: "单步解释，应判 normal" },
  { input: "对比一下 LangGraph 和 Autogen 的编排差异，并给出选型建议", expect: "plan", note: "多对象对比+选型，语义多步" },
  { input: "帮我调研最近三个月 RAG 评测的主流方案，汇总成一份对比清单", expect: "plan", note: "调研+汇总=多来源报告" },
  { input: "今天天气怎么样？顺便帮我看看最近有哪些新的开源大模型发布", expect: null, note: "混合意图，观察倾向" },
];

const MAX_CLASSIFY_CHARS = 2000;

function extractJson(content: string): { mode: string; reason: string } | null {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { mode?: unknown; reason?: unknown };
    return {
      mode: parsed.mode === "plan" ? "plan" : parsed.mode === "normal" ? "normal" : `??${String(parsed.mode)}`,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return null;
  }
}

async function classifyOnce(llm: ChatOpenAI, input: string): Promise<{
  raw: string;
  parsed: { mode: string; reason: string } | null;
  elapsedMs: number;
}> {
  const started = Date.now();
  const res = await llm.invoke(
    [new SystemMessage(CLASSIFIER_SYSTEM), new HumanMessage(input.slice(0, MAX_CLASSIFY_CHARS))],
    { signal: AbortSignal.timeout(8000) },
  );
  const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  return { raw: content, parsed: extractJson(content), elapsedMs: Date.now() - started };
}

async function main() {
  const profile = resolveProvider(process.env);
  console.log(`[classify-smoke] provider=${profile.provider} model=${profile.model} baseURL=${profile.baseURL || "(default)"}\n`);

  const llm = new ChatOpenAI({
    model: profile.model,
    apiKey: profile.apiKey,
    temperature: 0,
    timeout: 15000,
    maxRetries: 1,
    ...(profile.baseURL ? { configuration: { baseURL: profile.baseURL } } : {}),
  });

  let jsonOk = 0;
  let jsonBad = 0;
  let llmPlan = 0;
  let llmNormal = 0;
  let llmFallback = 0;
  const results: string[] = [];

  for (const s of SAMPLES) {
    // 1) 规则层先行（真实 onSubmit 里这一层零 LLM 成本）
    const ruled = applyModeRules(s.input);
    const ruledLine = ruled
      ? `rule → ${ruled.mode} (${ruled.reason})`
      : "rule → miss（交 LLM）";

    // 2) 规则已决策的样例不调 LLM（与运行时行为一致）
    let llmLine = "（未调用——规则层已决策）";
    if (!ruled) {
      try {
        const r = await classifyOnce(llm, s.input);
        const rawShort = r.raw.replace(/\s+/g, " ").slice(0, 160);
        if (!r.parsed) {
          jsonBad++;
          llmFallback++;
          llmLine = `LLM → ⚠️ 原始返回无合法 JSON: ${rawShort}`;
        } else {
          if (r.parsed.mode === "plan") llmPlan++;
          else if (r.parsed.mode === "normal") llmNormal++;
          else llmFallback++;
          if (r.parsed.mode === "plan" || r.parsed.mode === "normal") jsonOk++;
          else jsonBad++;
          llmLine = `LLM → ${r.parsed.mode} (${r.parsed.reason}) [${r.elapsedMs}ms] 原始: ${rawShort}`;
        }
      } catch (e) {
        jsonBad++;
        llmFallback++;
        llmLine = `LLM → ⚠️ 调用失败/超时: ${(e as Error).message.slice(0, 80)}`;
      }
    }

    const pass = ruled
      ? ruled.mode === s.expect
      : s.expect === null
        ? null
        : llmLine.startsWith(`LLM → ${s.expect}`);
    const verdict = pass === null ? "观察" : pass ? "✓ 符合" : "✗ 偏离";
    const line = `\n[${verdict}] ${s.note}\n  输入: ${s.input}\n  期望: ${s.expect ?? "—"}\n  ${ruledLine}\n  ${llmLine}`;
    console.log(line);
    results.push(`${verdict}\t${s.input}\t${s.expect ?? "-"}`);
  }

  console.log("\n================ 汇总 ================");
  console.log(`样例总数: ${SAMPLES.length}`);
  console.log(`规则层拦截: ${SAMPLES.length - (llmPlan + llmNormal + llmFallback)} | LLM 兜底: ${llmPlan + llmNormal + llmFallback}`);
  console.log(`LLM 判定: plan=${llmPlan} normal=${llmNormal} 坏JSON/失败(→fallback normal)=${jsonBad}`);
  console.log(`JSON 合法率: ${jsonOk}/${jsonOk + jsonBad}`);
  console.log("\n[classify-smoke] done —— 提示词稳定性看 JSON 合法率，升档质量看 plan/normal 是否符合语义预期");
}

main().catch((e) => {
  console.error("[classify-smoke] FAIL:", e);
  process.exit(1);
});
