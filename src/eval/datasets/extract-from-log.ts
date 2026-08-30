/**
 * extract-from-log.ts — 从 agent.log 抽取候选评估问题
 *
 * 输入: agent.log（格式: [ISO时间戳] [info] User: <问题>）
 * 输出: eval_output/candidates.json（候选问题 + 首次出现时间 + 出现次数）
 *
 * 用法:
 *   npx tsx src/eval/datasets/extract-from-log.ts --log rag_data/agent.log
 *   npx tsx src/eval/datasets/extract-from-log.ts --log rag_data/agent.log --out eval_output/candidates.json
 *
 * 产出物供人工标注: 从候选里挑 10-15 条 RAG 相关问题，
 * 补 referenceClaims / relevantChunks 后写入 src/eval/datasets/rag-qa.json
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export interface CandidateQuestion {
  question: string;
  /** 首次出现时间戳（ISO） */
  firstSeen: string;
  /** 出现次数，辅助挑选高频真实问题 */
  occurrences: number;
}

/** 匹配 [2026-07-11T13:17:37.562Z] [info] User: xxx */
const USER_RE = /\[([\dT:.Z-]+)\]\s*\[info\]\s*User:\s*(.+)$/gm;

/** 明显非问答的输入，命中即丢弃 */
const COMMAND_PATTERNS = [
  /^(cd|ls|ll|pwd|dir|cat|head|tail)\s/,
  /^git\s/,
  /^npm\s/,
  /^npx\s/,
  /^docker\s/,
  /^[/\\]/,
];

/** 从日志抽取候选问题：去重 + 计次 + 按出现次数降序 */
export function extractCandidates(logPath: string): CandidateQuestion[] {
  const content = readFileSync(logPath, "utf-8");
  const seen = new Map<string, CandidateQuestion>();

  for (const m of content.matchAll(USER_RE)) {
    const ts = m[1];
    const question = (m[2] ?? "").trim();

    if (question.length < 4) continue;
    if (COMMAND_PATTERNS.some((re) => re.test(question))) continue;

    const existing = seen.get(question);
    if (existing) {
      existing.occurrences += 1;
    } else {
      seen.set(question, { question, firstSeen: ts, occurrences: 1 });
    }
  }

  return Array.from(seen.values()).sort((a, b) => b.occurrences - a.occurrences);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      log: { type: "string" },
      out: { type: "string" },
    },
  });

  const logPath = resolve(values.log ?? "rag_data/agent.log");
  const outPath = resolve(values.out ?? "eval_output/candidates.json");

  const candidates = extractCandidates(logPath);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(candidates, null, 2), "utf-8");

  console.log(`[extract] ${logPath} → ${candidates.length} unique candidates`);
  for (const c of candidates.slice(0, 20)) {
    console.log(`  ${String(c.occurrences).padStart(2)}x  ${c.question}`);
  }
  console.log(`[extract] written to ${outPath}`);
}

const isMain =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  main();
}
