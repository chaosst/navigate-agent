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
  L.push("# 推理后端生成质量 × 延迟对比（eval 工具实测）");
  L.push("");
  L.push(`- 汇总时间：${new Date().toISOString()}`);
  // 用相对路径而不是 resolve() 后的绝对路径：报告要入仓 / 贴进博客，
  // 写死 D:\... 这种机器专属路径会让读者看不懂，换台机器就失效。
  L.push(`- 数据来源：\`${relative(process.cwd(), dir).replace(/\\/g, "/")}/*.json\`（由 \`scripts/compare-providers.ts\` 产出）`);
  L.push("- 评测方式：closed-book QA（不检索，变量只有生成模型），judge 固定为 DeepSeek");
  L.push("");
  L.push("### judge 判定口径（§8 改进后，各组一致）");
  L.push("");
  L.push("| 项 | 做法 |");
  L.push("|---|---|");
  L.push("| claim 数 | 每题 ≥ 3 条（数据集已加厚），摊薄单条判定抖动 |");
  L.push("| 重复判定 | 每题 judge 独立判定 3 轮，claim 取布尔多数、分数取众数档 |");
  L.push("| 同义判定 | `verifyClaims` prompt 允许语义等价，杜绝「同义改写即判 0」 |");
  L.push("| 长答案 | judge 单段上下文截断放宽至 1600 字符，避免证据被切 |");
  L.push("| rel 粒度 | `scoreAnswer` 三档化：1.0 全中 / 0.5 部分回答 / 0.0 答非所问 |");
  L.push("");

  // ── 表 1：总体三维 ──
  L.push("## 1. 总体对比");
  L.push("");
  L.push("| 后端 | provider | model | claimCoverage ↑ | answerRelevancy | avg totalMs ↓ | avg tokens | ok/n | judge rounds |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const s of files) {
    L.push(
      `| ${s.label} | \`${s.provider}\` | \`${s.model}\` | **${fmt(s.avg.claimCoverage)}** | ` +
        `${fmt(s.avg.answerRelevancy)} | ${fmt(s.avg.totalMs, 0)} | ${fmt(s.avg.outputTokens, 0)} | ${s.counts.ok}/${s.counts.total} | ${s.judgeRounds ?? 1} |`,
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
  L.push("1. **judge 固定为 DeepSeek，与被测解耦**，组间分数可比。`eval rag` 子命令现支持");
  L.push("   `JUDGE_BASE_URL` / `JUDGE_MODEL` / `JUDGE_API_KEY` 显式拆分独立 judge（未配置时仍共用）。");
  L.push("2. **claimCoverage 语义**：模型答案需**明确表述**出断言才算 supported（判定允许同义改写，");
  L.push("   但不会替模型脑补它没说的内容）。所以它是「答案内容覆盖度」而非「正确答案率」——");
  L.push("   答案正确但没展开的部分仍会计 0，绝对值仍偏保守，**组间相对差是主要读数**。");
  L.push("3. **answerRelevancy 三档化（1.0/0.5/0.0）**：云端大模型通常答满拿 1.0（天花板属正常）；");
  L.push("   0.5/0.0 的区分度主要落在本地小模型上（陷阱题：多子问 fact-04、双段计算 reas-04、");
  L.push("   双句约束 inst-04、schema+计算 fmt-04）。");
  L.push("4. **对比条件不对等**：7B（CPU）vs 1.5B（GPU）vs 云端未知规模，模型大小、硬件、");
  L.push("   网络路径均不同。这是**量级参考**，不是引擎性能上限的 benchmark。");
  L.push("5. **totalMs 为单次端到端含网络往返**，未做多轮取均值，抖动较大（尤其云端）。");
  L.push("6. **样本量小**：16 题（4 类 × 4 题），结论是量级参考，不是统计显著性结论。");
  L.push("");
  L.push("### 已修复的历史缺陷（2026-09 rework，见 provider-eval-compare.md §8）");
  L.push("");
  L.push("| 缺陷 | 旧现象 | 修复 |");
  L.push("|---|---|---|");
  L.push("| 单条 claim 抖动 | `reas-02` 同答案 `[1,2,5,9]` 三后端判定 0.00/1.00/0.00 | claim 加厚至 ≥3 + 每题 3 轮多数表决 |");
  L.push("| 同义改写判 0 | `inst-03` ollama 答「此方案可能不尽如人意」语义已覆盖仍判 0.00 | prompt 明确允许语义等价 |");
  L.push("| 长答案证据被切 | `fact-03` 答案 1790 字、RAG 证据在第 950 字后，500 字截断导致误判 0 | 单段截断放宽到 1600 字符 |");
  L.push("| rel 天花板 | 题目过简，三组 rel 恒 1.000 无区分度 | 数据集加入 4 道多约束陷阱题 + score 三档化 |");
  L.push("| 数据集与题目不匹配 | `inst-01/02/03` 掉分实为 claim 过度指定（细节断言/固定三件套/语义强度放大），非模型缺陷 | 回放标定（replay calibration）逐条修正 claim，合理答案 1.00、负面样本 0.00 |");
  L.push("| judge 与被测共用 | `eval rag` 内 judge 与被测同实例（self-preference bias） | `RagEvalOptions.judge` 支持注入独立 judge |");
  L.push("");
  L.push("**残余局限**：LLM-as-judge 仍有系统性偏差风险（多数表决只压随机抖动，压不掉 judge 自身的");
  L.push("风格倾向），claimCoverage 绝对值仍偏保守 —— 因此本报告结论以**组间相对差**为准。");
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
