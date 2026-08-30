/**
 * report.ts — 评估报告渲染与落盘
 *
 * 输入: runRagEval 的结果（RagEvalSampleResult[]）
 * 输出: Markdown 报告（人类可读）+ JSON（机器可读），落盘 eval_output/
 *
 * 设计点：
 *  - 失败样本（result.failed 有值）不参与均值统计，避免 0 分污染
 *  - null 指标（样本没标注 relevantChunks/referenceClaims）跳过统计，标注"有效样本"数
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RagEvalSampleResult } from "../runner/rag-eval.js";

export interface ReportSummary {
  mean: number;
  min: number;
  max: number;
  /** 参与统计的有效样本数（排除 failed 与 null） */
  validCount: number;
}

type MetricKey = keyof RagEvalSampleResult["metrics"];

const METRIC_LABELS: Record<MetricKey, string> = {
  hitRate: "hitRate@k（找没找到）",
  mrr: "MRR@k（首个相关排名）",
  ndcg: "nDCG@k（排序质量）",
  contextPrecision: "contextPrecision@k（检索精度）",
  contextRecall: "contextRecall（召回）",
  faithfulness: "faithfulness（忠实度）",
  answerRelevancy: "answerRelevancy（相关性）",
};

const METRIC_KEYS = Object.keys(METRIC_LABELS) as MetricKey[];

/** 聚合一组指标值：跳过 null 与非有限数；全空返回 null */
function summarize(values: (number | null)[]): ReportSummary | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length === 0) return null;
  return {
    mean: nums.reduce((a, b) => a + b, 0) / nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
    validCount: nums.length,
  };
}

const fmt = (n: number) => n.toFixed(3);

export function renderMarkdown(results: RagEvalSampleResult[], k: number): string {
  const failed = results.filter((r) => r.failed);
  const ok = results.filter((r) => !r.failed);
  const lines: string[] = [];

  lines.push("# RAG 评估报告");
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 样本数：${results.length}（失败 ${failed.length}）`);
  lines.push(`- 检索 top-k：${k}`);
  lines.push("");

  // ── 汇总表 ──
  lines.push("## 指标汇总");
  lines.push("");
  lines.push("| 指标 | mean | min | max | 有效样本 |");
  lines.push("|---|---|---|---|---|");
  for (const key of METRIC_KEYS) {
    const s = summarize(ok.map((r) => r.metrics[key]));
    lines.push(
      `| ${METRIC_LABELS[key]} | ${s ? fmt(s.mean) : "-"} | ${s ? fmt(s.min) : "-"} | ${s ? fmt(s.max) : "-"} | ${s ? s.validCount : 0} |`,
    );
  }
  lines.push("");

  // ── 样本明细 ──
  lines.push("## 样本明细");
  lines.push("");
  for (const r of results) {
    if (r.failed) {
      lines.push(`### [${r.sample.id}] ${r.sample.question}（⚠️ 失败）`);
      lines.push("");
      lines.push(`- error: ${r.failed}`);
      lines.push("");
      continue;
    }

    const hitCount = r.contextKeys.filter((ck) => r.sample.relevantChunks?.includes(ck)).length;
    lines.push(`### [${r.sample.id}] ${r.sample.question}`);
    lines.push("");
    lines.push(`- 检索命中：${hitCount}/${r.contextKeys.length}`);
    if (r.contextKeys.length > 0) {
      lines.push(`- contextKeys: \`${r.contextKeys.join("`, `")}\``);
    }
    const parts = METRIC_KEYS.map((key) => {
      const v = r.metrics[key];
      return `${METRIC_LABELS[key]}=${v === null ? "-" : fmt(v)}`;
    });
    lines.push(`- 指标：${parts.join("；")}`);
    lines.push("");
    lines.push(`- 答案：${r.answer.length > 300 ? r.answer.slice(0, 300) + "..." : r.answer}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function renderJson(results: RagEvalSampleResult[], k: number): string {
  const ok = results.filter((r) => !r.failed);
  const summary: Record<MetricKey, ReportSummary | null> = {} as never;
  for (const key of METRIC_KEYS) {
    summary[key] = summarize(ok.map((r) => r.metrics[key]));
  }
  return JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      k,
      sampleCount: results.length,
      failedCount: results.length - ok.length,
      summary,
      samples: results,
    },
    null,
    2,
  );
}

/** 渲染并落盘 md + json，返回两个路径 */
export function writeReports(
  results: RagEvalSampleResult[],
  k: number,
  outDir = "eval_output",
): { mdPath: string; jsonPath: string } {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const mdPath = resolve(outDir, `report-${ts}.md`);
  const jsonPath = resolve(outDir, `report-${ts}.json`);

  mkdirSync(resolve(outDir), { recursive: true });
  writeFileSync(mdPath, renderMarkdown(results, k), "utf-8");
  writeFileSync(jsonPath, renderJson(results, k), "utf-8");

  return { mdPath, jsonPath };
}
