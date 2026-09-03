/**
 * compare-providers.ts — 三后端「生成质量 × 延迟」对比（一次性脚本，零改造 src/）
 *
 * 为什么单独写这个脚本，而不是直接 `npm run eval -- rag`：
 *   1. 现有 rag 子命令的 judge 与被测**共用同一个 llm** 实例。跨后端对比时，
 *      每个后端自己给自己打分（self-preference bias），分数不可比。
 *      → 本脚本把 judge 固定成同一个模型（DeepSeek），只换被测端。
 *   2. rag 子命令依赖 PG + embedding 检索链路，切 provider 会连带换 embedding 模型，
 *      质量差异无法归因到「生成」还是「检索」。
 *      → 本脚本走 closed-book QA：不检索，变量只有生成模型。
 *
 * 复用的存量能力（均不修改）：
 *   - resolveProvider()      P1 适配层，解析 PROVIDER → { baseURL, apiKey, model }
 *   - createChatModel()      统一的 ChatOpenAI 工厂
 *   - LlmJudge.scoreAnswer()       → answerRelevancy（答案相关性 0-1）
 *   - LlmJudge.verifyClaims()      → claimCoverage（关键断言覆盖度，把模型答案当 context）
 *
 * 用法：
 *   npx tsx scripts/compare-providers.ts --provider deepseek --label "DeepSeek 云端"
 *   npx tsx scripts/compare-providers.ts --provider ollama --model qwen2.5:7b --label "ollama 7B CPU"
 *   npx tsx scripts/compare-providers.ts --provider vllm --model Qwen/Qwen2.5-1.5B-Instruct --label "vLLM 1.5B GPU"
 *   （可选 --rounds 3：judge 每题独立判定 3 次取多数，默认已开，见 §8 改进项）
 *
 * 输出：eval_output/provider-compare/<label>.md 与 .json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, type AppConfig } from "../src/config/index.js";
import { resolveProvider } from "../src/config/llm-providers.js";
import { createChatModel } from "../src/agent/langchain.js";
import { LlmJudge, type ClaimVerdict } from "../src/eval/judge/llm-judge.js";

// ── 数据结构 ────────────────────────────────────────────────────────────────

interface QaSample {
  id: string;
  category: string;
  question: string;
  referenceClaims: string[];
}

/** 单题结果：生成 + 计时 + 评分 三合一 */
interface SampleResult {
  id: string;
  category: string;
  question: string;
  answer: string;
  /** 端到端延迟（ms），超时/失败记 null，不参与均值 */
  totalMs: number | null;
  /** 输出 token 数；后端不返回 usage_metadata 时记 null */
  outputTokens: number | null;
  /** 答案相关性 0-1 */
  answerRelevancy: number | null;
  /** 关键断言覆盖度 0-1 */
  claimCoverage: number | null;
  /** 逐条 claim 判定明细（多数表决后），失败/未测为 null */
  claimVerdicts: ClaimVerdict[] | null;
  /** 失败原因；成功为 null */
  error: string | null;
}

interface ProviderSummary {
  label: string;
  provider: string;
  model: string;
  baseURL: string;
  createdAt: string;
  /** judge 每题的独立判定轮数（>1 = 多数表决，消除单次抖动） */
  judgeRounds: number;
  counts: { total: number; ok: number; failed: number };
  avg: {
    answerRelevancy: number | null;
    claimCoverage: number | null;
    totalMs: number | null;
    outputTokens: number | null;
  };
  byCategory: Record<string, { answerRelevancy: number | null; claimCoverage: number | null; n: number }>;
  samples: SampleResult[];
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 用 provider profile 的三个字段覆盖一份 AppConfig 副本。
 * 为什么这么做：createChatModel 只吃 AppConfig，而 AppConfig 里还有一堆
 * 与 LLM 无关的字段（DB、API 鉴权等）。复用 loadConfig() 的结果再覆盖，
 * 比手工拼一份最小 AppConfig 更省事，也不会漏字段。
 */
function withProfile(base: AppConfig, profile: { baseURL: string; apiKey: string; model: string }): AppConfig {
  return { ...base, baseURL: profile.baseURL, openAIApiKey: profile.apiKey, modelName: profile.model };
}

/** 均值；空数组或全 null 返回 null（绝不返回 0，0 会被误读成"很差"而不是"测不出"） */
function mean(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  return nums.length > 0 ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
}

function fmt(v: number | null, digits = 3): string {
  return v == null ? "n/a" : v.toFixed(digits);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      label: { type: "string" },
      dataset: { type: "string" },
      "judge-model": { type: "string", default: "deepseek-v4-flash" },
      rounds: { type: "string" },
    },
  });

  const label = values.label ?? values.provider ?? "unknown";
  const rounds = Math.max(1, parseInt(values.rounds ?? "3", 10) || 1); // §8 改进项：judge 多数表决轮数
  const datasetPath = resolve(values.dataset ?? "src/eval/datasets/provider-qa.json");
  const samples = JSON.parse(readFileSync(datasetPath, "utf-8")) as QaSample[];

  // ① 被测端：PROVIDER 由命令行指定，未指定则回落 env（保持与 P1 一致的行为）
  const baseConfig = loadConfig();
  const targetProfile = resolveProvider({
    ...process.env,
    ...(values.provider ? { PROVIDER: values.provider } : {}),
    ...(values.model ? { OPENAI_MODEL: values.model } : {}),
    ...(values["base-url"] ? { OPENAI_BASE_URL: values["base-url"] } : {}),
  });
  const target = createChatModel(withProfile(baseConfig, targetProfile));

  // ② judge 端：固定 DeepSeek，保证三组分数在同一把尺子上
  // 注意：key 必须取原始 env。loadConfig() 之后 config.openAIApiKey 可能已被
  // 本地后端的 provider 名占位符（"ollama"/"vllm"）覆盖，拿它当 judge key 会 401。
  const judgeProfile = resolveProvider({
    PROVIDER: "openai",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.JUDGE_BASE_URL ?? "https://api.deepseek.com",
    OPENAI_MODEL: values["judge-model"] as string,
  });
  const judge = new LlmJudge(createChatModel(withProfile(baseConfig, judgeProfile)));

  console.log(`[compare] label    = ${label}`);
  console.log(`[compare] target   = ${targetProfile.provider} / ${targetProfile.model} @ ${targetProfile.baseURL}`);
  console.log(`[compare] judge    = ${judgeProfile.provider} / ${judgeProfile.model} @ ${judgeProfile.baseURL} (fixed)`);
  console.log(`[compare] dataset  = ${datasetPath} (${samples.length} samples)`);
  console.log(`[compare] judge    = ${rounds} round(s) majority voting`);
  console.log("");

  const results: SampleResult[] = [];

  for (const s of samples) {
    const row: SampleResult = {
      id: s.id,
      category: s.category,
      question: s.question,
      answer: "",
      totalMs: null,
      outputTokens: null,
      answerRelevancy: null,
      claimCoverage: null,
      claimVerdicts: null,
      error: null,
    };

    // ── 生成 + 计时。单题失败只记 error，不中断整批 ──
    try {
      const t0 = performance.now();
      const res = await target.invoke(s.question);
      row.totalMs = performance.now() - t0;

      const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      row.answer = text;
      row.outputTokens = (res.usage_metadata?.output_tokens as number | undefined) ?? null;
    } catch (e) {
      row.error = `generate failed: ${e instanceof Error ? e.message : String(e)}`;
      results.push(row);
      console.log(`  ✗ ${s.id}  ${row.error}`);
      continue;
    }

    // ── 评分。judge 出错同样只记 error，保留已测出的延迟 ──
    try {
      row.answerRelevancy = await judge.scoreAnswer(s.question, row.answer, { rounds });
    } catch (e) {
      row.error = `judge scoreAnswer failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      // 把模型自己的答案当作 context，判它是否覆盖了标准答案的关键断言 → 正确性/覆盖度
      const verdicts = await judge.verifyClaims(s.referenceClaims, [row.answer], { rounds });
      row.claimVerdicts = verdicts;
      row.claimCoverage = verdicts.filter((v) => v.supported).length / verdicts.length;
    } catch (e) {
      row.error = `judge verifyClaims failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    results.push(row);
    console.log(
      `  ✓ ${s.id}  rel=${fmt(row.answerRelevancy, 2)}  cov=${fmt(row.claimCoverage, 2)}  ` +
        `${row.totalMs == null ? "n/a" : row.totalMs.toFixed(0) + "ms"}  ${row.outputTokens ?? "?"}tok`,
    );
  }

  // ── 汇总 ──
  const okRows = results.filter((r) => r.error === null);
  const byCategory: ProviderSummary["byCategory"] = {};
  for (const cat of new Set(results.map((r) => r.category))) {
    const rows = results.filter((r) => r.category === cat);
    byCategory[cat] = {
      answerRelevancy: mean(rows.map((r) => r.answerRelevancy)),
      claimCoverage: mean(rows.map((r) => r.claimCoverage)),
      n: rows.length,
    };
  }

  const summary: ProviderSummary = {
    label,
    provider: targetProfile.provider,
    model: targetProfile.model,
    baseURL: targetProfile.baseURL,
    createdAt: new Date().toISOString(),
    judgeRounds: rounds,
    counts: { total: results.length, ok: okRows.length, failed: results.length - okRows.length },
    avg: {
      answerRelevancy: mean(okRows.map((r) => r.answerRelevancy)),
      claimCoverage: mean(okRows.map((r) => r.claimCoverage)),
      totalMs: mean(okRows.map((r) => r.totalMs)),
      outputTokens: mean(okRows.map((r) => r.outputTokens)),
    },
    byCategory,
    samples: results,
  };

  // ── 落盘 ──
  const outDir = resolve("eval_output/provider-compare");
  mkdirSync(outDir, { recursive: true });
  const slug = label.replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
  const jsonPath = `${outDir}/${slug}.json`;
  const mdPath = `${outDir}/${slug}.md`;
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf-8");
  writeFileSync(mdPath, renderMarkdown(summary), "utf-8");

  console.log("");
  console.log(`[compare] avg answerRelevancy = ${fmt(summary.avg.answerRelevancy)}`);
  console.log(`[compare] avg claimCoverage   = ${fmt(summary.avg.claimCoverage)}`);
  console.log(`[compare] avg totalMs         = ${fmt(summary.avg.totalMs, 0)}`);
  console.log(`[compare] ok/failed           = ${summary.counts.ok}/${summary.counts.failed}`);
  console.log(`[compare] md   ${mdPath}`);
  console.log(`[compare] json ${jsonPath}`);
}

// ── 报告渲染 ────────────────────────────────────────────────────────────────

function renderMarkdown(s: ProviderSummary): string {
  const L: string[] = [];
  L.push(`# ${s.label}`);
  L.push("");
  L.push(`- provider: \`${s.provider}\` / model: \`${s.model}\` @ \`${s.baseURL}\``);
  L.push(`- judge: 固定 DeepSeek（**与被测解耦**，避免 self-preference bias）`);
  L.push(`- judge 判定：每题 ${s.judgeRounds} 轮独立判定取多数（claim 布尔多数 / 分数众数档）；claim 判定允许语义等价`);
  L.push(`- createdAt: ${s.createdAt}`);
  L.push(`- samples: ${s.counts.total}（成功 ${s.counts.ok} / 失败 ${s.counts.failed}）`);
  L.push("");
  L.push("## 汇总");
  L.push("");
  L.push("| 指标 | 均值 |");
  L.push("|---|---|");
  L.push(`| answerRelevancy（答案相关性） | ${fmt(s.avg.answerRelevancy)} |`);
  L.push(`| claimCoverage（关键断言覆盖度） | ${fmt(s.avg.claimCoverage)} |`);
  L.push(`| totalMs（端到端延迟） | ${fmt(s.avg.totalMs, 0)} |`);
  L.push(`| outputTokens | ${fmt(s.avg.outputTokens, 1)} |`);
  L.push("");
  L.push("## 按题型分组");
  L.push("");
  L.push("| 题型 | n | answerRelevancy | claimCoverage |");
  L.push("|---|---|---|---|");
  for (const [cat, v] of Object.entries(s.byCategory)) {
    L.push(`| ${cat} | ${v.n} | ${fmt(v.answerRelevancy)} | ${fmt(v.claimCoverage)} |`);
  }
  L.push("");
  L.push("## 明细");
  L.push("");
  L.push("| id | 题型 | answerRelevancy | claimCoverage | totalMs | tokens | status |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of s.samples) {
    L.push(
      `| ${r.id} | ${r.category} | ${fmt(r.answerRelevancy, 2)} | ${fmt(r.claimCoverage, 2)} | ` +
        `${r.totalMs == null ? "n/a" : r.totalMs.toFixed(0)} | ${r.outputTokens ?? "n/a"} | ${r.error ?? "ok"} |`,
    );
  }
  L.push("");

  // ── 低分题逐条判定明细（claimCoverage < 1 才展开，便于归因是 judge 误判还是真实偏差）──
  const lowScores = s.samples.filter((r) => r.claimVerdicts && (r.claimCoverage ?? 1) < 1);
  if (lowScores.length > 0) {
    L.push("## 低分题 claim 判定明细");
    L.push("");
    for (const r of lowScores) {
      L.push(`### ${r.id}（${r.category}，claimCoverage=${fmt(r.claimCoverage, 2)}）`);
      L.push("");
      L.push("| # | claim | supported | reason |");
      L.push("|---|---|---|---|");
      r.claimVerdicts!.forEach((v, i) => {
        L.push(`| ${i} | ${v.claim} | ${v.supported ? "✅" : "❌"} | ${v.reason} |`);
      });
      L.push("");
    }
  }

  return L.join("\n");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
