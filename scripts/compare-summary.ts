/**
 * compare-summary.ts — 把 provider-compare 目录下各组结果汇总成一张横向对比表
 *
 * 为什么单独拆：compare-providers.ts 一次只跑一个后端（便于分别启动/重跑），
 * 汇总需要横向对齐多组，拆开后任一组重跑都不会影响其他组。
 *
 * 用法：
 *   npx tsx scripts/compare-summary.ts
 *   npx tsx scripts/compare-summary.ts --dir eval_output/provider-compare --out docs/interview-notes/provider-compare.md
 *
 * 输入：--dir 下所有 *.json（由 compare-providers.ts 产出）
 * 输出：横向对比 Markdown（三维：质量 × 延迟 × 分词题型）
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";

interface SampleResult {
  id: string;
  category: string;
  answerRelevancy: number | null;
  claimCoverage: number | null;
  totalMs: number | null;
  outputTokens: number | null;
  error: string | null;
}

interface ProviderSummary {
  label: string;
  provider: string;
  model: string;
  baseURL: string;
  createdAt: string;
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

function fmt(v: number | null, digits = 3): string {
  return v == null ? "n/a" : v.toFixed(digits);
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { dir: { type: "string" }, out: { type: "string" } },
  });

  const dir = resolve(values.dir ?? "eval_output/provider-compare");
  const outPath = resolve(values.out ?? "eval_output/provider-compare/SUMMARY.md");

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf-8")) as ProviderSummary)
    // 按 claimCoverage 降序，让"质量排名"一眼可见
    .sort((a, b) => (b.avg.claimCoverage ?? -1) - (a.avg.claimCoverage ?? -1));

  if (files.length === 0) {
    console.error(`[summary] no *.json found in ${dir}`);
    process.exit(1);
  }

  const L: string[] = [];
  L.push("# 三后端生成质量 × 延迟对比（eval 工具实测）");
  L.push("");
  L.push(`- 汇总时间：${new Date().toISOString()}`);
  // 用相对路径而不是 resolve() 后的绝对路径：报告要入仓 / 贴进博客，
  // 写死 D:\... 这种机器专属路径会让读者看不懂，换台机器就失效。
  L.push(`- 数据来源：\`${relative(process.cwd(), dir).replace(/\\/g, "/")}/*.json\`（由 \`scripts/compare-providers.ts\` 产出）`);
  L.push("- 评测方式：closed-book QA（不检索，变量只有生成模型），judge 固定为 DeepSeek");
  L.push("");

  // ── 表 1：总体三维 ──
  L.push("## 1. 总体对比");
  L.push("");
  L.push("| 后端 | provider | model | claimCoverage ↑ | answerRelevancy | avg totalMs ↓ | avg tokens | ok/n |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const s of files) {
    L.push(
      `| ${s.label} | \`${s.provider}\` | \`${s.model}\` | **${fmt(s.avg.claimCoverage)}** | ` +
        `${fmt(s.avg.answerRelevancy)} | ${fmt(s.avg.totalMs, 0)} | ${fmt(s.avg.outputTokens, 0)} | ${s.counts.ok}/${s.counts.total} |`,
    );
  }
  L.push("");

  // ── 表 2：按题型分组（覆盖度）──
  const cats = [...new Set(files.flatMap((f) => Object.keys(f.byCategory)))];
  L.push("## 2. 按题型分组 · claimCoverage");
  L.push("");
  L.push(`| 题型 | ${files.map((f) => f.label).join(" | ")} |`);
  L.push(`|---|${files.map(() => "---").join("|")}|`);
  for (const cat of cats) {
    const cells = files.map((f) => fmt(f.byCategory[cat]?.claimCoverage ?? null, 2));
    L.push(`| ${cat} | ${cells.join(" | ")} |`);
  }
  L.push("");

  // ── 表 3：逐题覆盖度矩阵（能看出"哪类题拉开差距"）──
  const sampleIds = files[0]?.samples.map((s) => s.id) ?? [];
  L.push("## 3. 逐题 claimCoverage 矩阵");
  L.push("");
  L.push(`| 题目 | 题型 | ${files.map((f) => f.label).join(" | ")} |`);
  L.push(`|---|---|${files.map(() => "---").join("|")}|`);
  for (const id of sampleIds) {
    const cat = files[0].samples.find((s) => s.id === id)?.category ?? "";
    const cells = files.map((f) => {
      const r = f.samples.find((s) => s.id === id);
      if (!r) return "n/a";
      return r.error ? "ERR" : fmt(r.claimCoverage, 2);
    });
    L.push(`| ${id} | ${cat} | ${cells.join(" | ")} |`);
  }
  L.push("");

  // ── 表 4：逐题延迟矩阵 ──
  L.push("## 4. 逐题 totalMs 矩阵");
  L.push("");
  L.push(`| 题目 | ${files.map((f) => f.label).join(" | ")} |`);
  L.push(`|---|${files.map(() => "---").join("|")}|`);
  for (const id of sampleIds) {
    const cells = files.map((f) => {
      const r = f.samples.find((s) => s.id === id);
      if (!r || r.totalMs == null) return "n/a";
      return r.totalMs.toFixed(0);
    });
    L.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  L.push("");

  // ── 口径声明 ──
  L.push("## 5. 口径与局限（读数据前必看）");
  L.push("");
  L.push("1. **judge 固定为 DeepSeek**，与被测解耦，组间分数可比。若沿用 `eval rag` 的默认行为");
  L.push("   （judge 与被测共用同一实例），会产生 self-preference bias，分数不可比。");
  L.push("2. **claimCoverage 绝对值偏保守**：`LlmJudge.verifyClaims` 的 system prompt 要求");
  L.push("   「上下文没提到的一律 false」，对同义表述容忍度低（例如答案 `[1, 2, 5, 9]` 正确");
  L.push("   却可能被判 unsupported）。因此**绝对值不可直接当准确率引用，组间相对差才有意义**。");
  L.push("3. **answerRelevancy 出现天花板效应**：本批题目偏简单，三组的 rel 均为 1.000，");
  L.push("   该指标在此数据集上无分辨力，结论以 claimCoverage 为准。");
  L.push("4. **对比条件不对等**：7B（CPU）vs 1.5B（GPU）vs 云端未知规模，模型大小、硬件、");
  L.push("   网络路径均不同。这是**量级参考**，不是引擎性能上限的 benchmark。");
  L.push("5. **totalMs 为单次端到端含网络往返**，未做多轮取均值，抖动较大（尤其云端）。");
  L.push("");
  L.push("### judge 自身缺陷的实证（为什么只能看相对差）");
  L.push("");
  L.push("| 现象 | 证据 | 影响 |");
  L.push("|---|---|---|");
  L.push("| **同一答案，judge 给分不一致** | `reas-02` 三后端答案**完全相同** `[1, 2, 5, 9]`，");
  L.push("  覆盖度却是 DeepSeek `0.00` / vLLM `1.00` / ollama `0.00` | LLM-as-judge 固有抖动。");
  L.push("  该题只有 1 条 claim（非 0 即 1），单次抖动被放大到整题粒度 |");
  L.push("| **同义表述被判 unsupported** | `inst-03` ollama 答「此方案可能不尽如人意，建议再行斟酌」，");
  L.push("  语义已覆盖「方案不可行、需重新考虑」，仍判 0.00 | `verifyClaims` 的 prompt 要求");
  L.push("  「上下文没提到的一律 false」，对复述/改写容忍度低，绝对值系统性偏低 |");
  L.push("| **小模型语言跑偏判 0 是合理的** | `inst-03` vLLM 1.5B 用**英文**回答中文问题 | ");
  L.push("  这类 0 分是真实质量差异，不是 judge 误判 |");
  L.push("");
  L.push("**结论**：claimCoverage 的**绝对值不可当准确率引用**，只能在同一数据集、同一 judge 下看");
  L.push("**组间相对差**。要拿可信绝对值需要：① claim 数 ≥ 3 摊薄单条抖动；② 每题重复判定 3 次取众数；");
  L.push("③ 放宽 `verifyClaims` 的 prompt，允许语义等价。");
  L.push("");

  writeFileSync(outPath, L.join("\n"), "utf-8");
  console.log(`[summary] ${files.length} group(s) → ${outPath}`);
  for (const f of files) {
    console.log(
      `  ${f.label.padEnd(16)} cov=${fmt(f.avg.claimCoverage)}  rel=${fmt(f.avg.answerRelevancy)}  ` +
        `ms=${fmt(f.avg.totalMs, 0)}`,
    );
  }
}

main();
