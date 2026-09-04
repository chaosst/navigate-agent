/**
 * run.ts — agent 项目自身开销性能测试（perf batch runner）
 *
 * 口径（与 docs/agent-perf-testing.md 一致）：
 *   overheadMs = totalMs − Σ(llmMs) − Σ(toolMs)   ← 项目自身开销（parse/路由/状态/DB/流式…）
 *   llmMs 落在 DeepSeek 上，不属于本项目瓶颈，单独剔除。
 *
 * 三种模式：
 *   real（默认）    DeepSeek 真实跑，残差法算 overhead
 *   --mock          MockModel 注入，0 token ≈ 纯项目开销（A/B 隔离 DeepSeek 净贡献）
 *   --concurrency N 进程内并行 N 个 runAgent，探测本地争用（embedding 排队/内存）导致的 overhead 劣化
 *
 * 用法：
 *   npm run perf
 *   npm run perf -- --mock --limit 5
 *   npm run perf -- --concurrency 4 --max-iterations 8
 *   npm run perf -- --corpus <path> --out <dir>
 *
 * 产出（默认 eval_output/）：
 *   perf-report.md     聚合报告（per-category p50/p90、最慢工具 topN、最慢任务 topN）
 *   perf-traces.jsonl  TraceSession 明细，可直接喂 `npm run eval -- agent --file ...`
 *   perf-metrics.jsonl PerfMetrics 明细
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ChatOpenAI } from "@langchain/openai";
import { bootstrapAgent, type BootstrapResult } from "../bootstrap.js";
import { Tracer, type TraceSession } from "../agent/tracer.js";
import { createAgentExecutor, runAgent } from "../agent/loop.js";
import type { GraphAgentExecutor } from "../agent/graph-agent-executor.js";
import type { AgentMessage } from "../agent/types.js";
import { MockModel } from "./mock-model.js";
import { JsonlTraceExporter } from "../eval/trace/trace-export.js";

// ════════════════════════════════════════
//  指标
// ════════════════════════════════════════

/** 一次任务内各工具的耗时归属（来自 toolStatsRegistry 快照差） */
export interface ToolAttribution {
  tool: string;
  count: number;
  totalMs: number;
}

export interface PerfMetrics {
  id: string;
  category: string;
  userInput: string;
  /** 任务总耗时（session startedAt → finishedAt） */
  totalMs: number;
  /** Σ LLM 调用耗时（DeepSeek 时间，排除项） */
  llmMs: number;
  /** Σ 工具执行耗时（tools 数组求和；LangGraph 路径 Tracer 不记 tool_result，故以 registry 快照差为准） */
  toolMs: number;
  /** 工具耗时明细（registry 快照差） */
  tools: ToolAttribution[];
  /** LangGraph 围墙耗时（LLM+工具+路由全含） */
  graphMs: number | null;
  /** history parse 耗时 */
  parseMs: number | null;
  /** 图内路由/状态开销 = graphMs − llmMs − toolMs */
  routeMs: number | null;
  /** 图外开销 = totalMs − graphMs − parseMs（流式转发/持久化等） */
  outsideMs: number | null;
  /** 项目自身开销 = totalMs − llmMs − toolMs */
  overheadMs: number;
  /** overheadMs / totalMs */
  overheadPct: number;
  /** turn 持久化耗时（--persist 开启才记录） */
  persistMs: number | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export interface PerfComputeOptions {
  /** 工具耗时归属（per-tool busy 累计，供 topN）；缺省回落到 trace 里的 tool_result 求和 */
  tools?: ToolAttribution[];
  /** 工具真实墙钟（并行 tool_call 去重后的区间并集）；缺省用 tools 求和 */
  toolWallMs?: number;
  persistMs?: number | null;
}

/** 区间并集墙钟：把各工具调用窗口按时间合并，求不重叠的总占用（解决并行调用重复计耗时） */
export function unionWall(intervals: Array<{ start: number; dur: number }>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let wall = 0;
  let curStart = sorted[0].start;
  let curEnd = sorted[0].start + sorted[0].dur;
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.start > curEnd) {
      wall += curEnd - curStart;
      curStart = s.start;
      curEnd = s.start + s.dur;
    } else if (s.start + s.dur > curEnd) {
      curEnd = s.start + s.dur;
    }
  }
  wall += curEnd - curStart;
  return wall;
}

/** 纯函数：TraceSession → PerfMetrics（可单测） */
export function computePerfMetrics(
  session: TraceSession,
  id: string,
  category: string,
  opts: PerfComputeOptions = {},
): PerfMetrics {
  const totalMs = session.finishedAt ? session.finishedAt - session.startedAt : 0;
  const llmMs = session.steps.reduce(
    (s, x) => (x.type === "llm_call" ? s + (x.durationMs ?? 0) : s), 0);
  const tools = opts.tools ?? [];
  const toolsSum = tools.length > 0
    ? tools.reduce((s, t) => s + t.totalMs, 0)
    : session.steps.reduce((s, x) => (x.type === "tool_result" ? s + (x.durationMs ?? 0) : s), 0);
  // 工具墙钟优先用并集；未提供时退化为求和（并集 ≤ 求和，二者只在无并行时相等）
  let toolMs = opts.toolWallMs ?? toolsSum;
  // 防御钳制：任何情况下工具墙钟不能超过「总耗时 − LLM 耗时」（并发模式跨任务串账的兜底）
  toolMs = Math.min(toolMs, Math.max(totalMs - llmMs, 0));
  const overheadMs = Math.max(totalMs - llmMs - toolMs, 0);
  const graphMs = session.graphMs ?? null;
  const parseMs = session.parseMs ?? null;
  const routeMs = graphMs !== null ? Math.max(graphMs - llmMs - toolMs, 0) : null;
  const outsideMs =
    graphMs !== null ? Math.max(totalMs - graphMs - (parseMs ?? 0), 0) : null;
  const iterations = new Set(session.steps.map((s) => s.iteration)).size;

  return {
    id,
    category,
    userInput: session.userInput,
    totalMs,
    llmMs,
    toolMs,
    tools,
    graphMs,
    parseMs,
    routeMs,
    outsideMs,
    overheadMs,
    overheadPct: totalMs > 0 ? (overheadMs / totalMs) * 100 : 0,
    persistMs: opts.persistMs ?? null,
    iterations,
    inputTokens: session.totalInputTokens,
    outputTokens: session.totalOutputTokens,
  };
}

// ════════════════════════════════════════
//  聚合
// ════════════════════════════════════════

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)));
  return Math.round(sorted[idx]);
}

interface CategoryRow {
  category: string;
  n: number;
  totalP50: number;
  totalP90: number;
  overheadP50: number;
  overheadP90: number;
  overheadPctP50: number;
  llmAvg: number;
}

export interface PerfReport {
  mode: "real" | "mock";
  concurrency: number;
  corpusSize: number;
  rows: CategoryRow[];
  overall: CategoryRow;
  topSlowTools: { tool: string; count: number; totalMs: number }[];
  topSlowTasks: PerfMetrics[];
  bottlenecks: PerfMetrics[];
}

export function aggregate(metrics: PerfMetrics[]): PerfReport {
  const byCat = new Map<string, PerfMetrics[]>();
  for (const m of metrics) {
    if (!byCat.has(m.category)) byCat.set(m.category, []);
    byCat.get(m.category)!.push(m);
  }

  const row = (list: PerfMetrics[]): CategoryRow => {
    const sortedTotal = [...list].map((m) => m.totalMs).sort((a, b) => a - b);
    const sortedOverhead = [...list].map((m) => m.overheadMs).sort((a, b) => a - b);
    const sortedPct = [...list].map((m) => m.overheadPct).sort((a, b) => a - b);
    const llmAvg =
      list.length === 0 ? 0 : Math.round(list.reduce((s, m) => s + m.llmMs, 0) / list.length);
    return {
      category: list[0]?.category ?? "?",
      n: list.length,
      totalP50: percentile(sortedTotal, 50),
      totalP90: percentile(sortedTotal, 90),
      overheadP50: percentile(sortedOverhead, 50),
      overheadP90: percentile(sortedOverhead, 90),
      overheadPctP50: Math.round(percentile(sortedPct, 50)),
      llmAvg,
    };
  };

  const rows: CategoryRow[] = [...byCat.entries()].map(([cat, list]) => row(list));
  rows.sort((a, b) => b.n - a.n);

  // 最慢工具：聚合每条 metric 的 tools 明细（来源 registry 快照差）
  const toolMap = new Map<string, { count: number; totalMs: number }>();
  for (const m of metrics) {
    for (const t of m.tools ?? []) {
      const cur = toolMap.get(t.tool) ?? { count: 0, totalMs: 0 };
      cur.count += t.count;
      cur.totalMs += t.totalMs;
      toolMap.set(t.tool, cur);
    }
  }
  const topSlowTools = [...toolMap.entries()]
    .map(([tool, v]) => ({ tool, ...v }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 8);

  const sorted = [...metrics].sort((a, b) => b.totalMs - a.totalMs);
  return {
    mode: "real",
    concurrency: 1,
    corpusSize: metrics.length,
    rows,
    overall: row(metrics),
    topSlowTools,
    topSlowTasks: sorted.slice(0, 8),
    bottlenecks: metrics.filter((m) => m.overheadPct > 30 || m.overheadMs > 2_000),
  };
}

// ════════════════════════════════════════
//  报告渲染
// ════════════════════════════════════════

function renderReport(report: PerfReport): string {
  const L: string[] = [];
  L.push(`# Agent 性能测试报告（${report.mode === "mock" ? "MOCK 模式 · 纯项目开销" : "real 模式 · DeepSeek"}）`);
  L.push("");
  L.push(`- 语料规模: ${report.corpusSize} 条 · 并发: ${report.concurrency} · 生成时间: ${new Date().toISOString()}`);
  L.push("");
  L.push("## 判定线：overheadPct > 30% 或 overheadMs > 2s 记为项目瓶颈");
  L.push("");
  L.push("| 类别 | n | totalMs p50/p90 | overheadMs p50/p90 | overheadPct p50 | llmMs avg |");
  L.push("|---|---|---|---|---|---|");
  const rowLine = (r: CategoryRow) =>
    `| ${r.category} | ${r.n} | ${r.totalP50} / ${r.totalP90} | ${r.overheadP50} / ${r.overheadP90} | ${r.overheadPctP50}% | ${r.llmAvg} |`;
  for (const r of report.rows) L.push(rowLine(r));
  L.push(`| **all** | ${report.overall.n} | ${report.overall.totalP50} / ${report.overall.totalP90} | ${report.overall.overheadP50} / ${report.overall.overheadP90} | ${report.overall.overheadPctP50}% | ${report.overall.llmAvg} |`);
  L.push("");

  L.push("## 最慢工具 topN（本地执行耗时）");
  L.push("");
  L.push("| 工具 | 调用次数 | 累计耗时 ms |");
  L.push("|---|---|---|");
  for (const t of report.topSlowTools) L.push(`| ${t.tool} | ${t.count} | ${t.totalMs} |`);
  L.push("");

  L.push("## 最慢任务 topN");
  L.push("");
  L.push("| id | category | totalMs | overheadMs | overheadPct | iters | in/out tokens | error |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const m of report.topSlowTasks) {
    L.push(`| ${m.id} | ${m.category} | ${m.totalMs} | ${m.overheadMs} | ${m.overheadPct.toFixed(0)}% | ${m.iterations} | ${m.inputTokens}/${m.outputTokens} | ${m.error ?? ""} |`);
  }
  L.push("");

  if (report.bottlenecks.length > 0) {
    L.push("## ⚠️ 项目瓶颈清单");
    L.push("");
    for (const m of report.bottlenecks) {
      L.push(`- \`${m.id}\` (${m.category}): overheadMs=${m.overheadMs} (${m.overheadPct.toFixed(0)}%), graphMs=${m.graphMs ?? "-"}, parseMs=${m.parseMs ?? "-"}, routeMs=${m.routeMs ?? "-"}, outsideMs=${m.outsideMs ?? "-"}`);
    }
  }
  L.push("");
  return L.join("\n");
}

// ════════════════════════════════════════
//  语料
// ════════════════════════════════════════

interface CorpusItem {
  id: string;
  category: string;
  task: string;
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf-8")) as T;
}

/** 兼容 {id,category,task}/provider-qa 的 {id,category,question,...}/纯字符串 三种形态 */
function normalizeCorpusItem(item: unknown, fallbackId: number): CorpusItem {
  if (typeof item === "string") {
    return { id: `t${fallbackId}`, category: "misc", task: item };
  }
  const o = item as Record<string, unknown>;
  const task = (o.task ?? o.question) as string | undefined;
  return {
    id: (o.id as string) ?? `t${fallbackId}`,
    category: (o.category as string) ?? "misc",
    task: task ?? String(fallbackId),
  };
}

function loadCorpus(customPath?: string): CorpusItem[] {
  const paths = customPath
    ? [customPath]
    : ["src/eval/datasets/provider-qa.json", "src/perf/corpus.agent.json"];
  const items: CorpusItem[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    const raw = readJson<unknown[]>(abs);
    items.push(...raw.map((it, i) => normalizeCorpusItem(it, i + 1)));
  }
  return items;
}

// ════════════════════════════════════════
//  执行
// ════════════════════════════════════════

function buildWarmupHistory(n: number): AgentMessage[] {
  const history: AgentMessage[] = [];
  for (let i = 0; i < n; i++) {
    history.push({ role: "user", content: `热身问题 ${i + 1}` });
    history.push({ role: "assistant", content: `热身回答 ${i + 1}` });
  }
  return history;
}

function createExecutor(
  bs: BootstrapResult,
  llm: ChatOpenAI,
  tracer: Tracer,
  maxIterations: number,
  timeoutMs: number,
): GraphAgentExecutor {
  return createAgentExecutor(
    llm,
    bs.tools,
    bs.systemPrompt,
    maxIterations,
    bs.toolStatsRegistry,
    undefined, // toolFilter：压测不过滤，工具全量可见
    tracer,
    timeoutMs,
  );
}

interface RunOneOptions {
  bs: BootstrapResult;
  llm: ChatOpenAI;
  maxIterations: number;
  timeoutMs: number;
  warmup: number;
  persist: boolean;
}

async function runOneTask(item: CorpusItem, opts: RunOneOptions): Promise<{ metric: PerfMetrics; session: TraceSession }> {
  const tracer = new Tracer();
  // parseMs/graphMs 会经 executor.tracer 落进 session
  const executor = createExecutor(
    opts.bs,
    opts.llm,
    tracer,
    opts.maxIterations,
    opts.timeoutMs,
  );

  tracer.startSession(item.task);
  let persistMs: number | null = null;
  if (opts.persist) {
    const t0 = performance.now();
    await opts.bs.memory.addUserMessage(item.task);
    persistMs = performance.now() - t0;
  }

  // 工具耗时归属：LangGraph 路径 Tracer 不记 tool_result，用 registry 的调用窗口。
  // taskStartWall 记录任务开始时刻；结束后 collectCallsSince 取本任务窗口内的调用。
  const reg = opts.bs.toolStatsRegistry;
  const taskStartWall = performance.now();

  let error: string | undefined;
  let output = "";
  try {
    output = await runAgent(
      executor,
      item.task,
      opts.warmup > 0 ? buildWarmupHistory(opts.warmup) : undefined,
      undefined,
      opts.timeoutMs,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (opts.persist) {
    const t0 = performance.now();
    if (error) {
      await opts.bs.memory.addAssistantMessage(`[perf error] ${error}`);
    } else {
      await opts.bs.memory.addAssistantMessage(output || "（无输出）");
    }
    persistMs = (persistMs ?? 0) + (performance.now() - t0);
  }

  // finishSession 在图内已被 finalize/fallback 调用；此处补一次兜底（不幂等也没副作用）
  tracer.finishSession();
  const sessions = tracer.getSessions();
  const session = sessions[sessions.length - 1];

  // 收集任务窗口内的调用窗口 → per-tool busy（topN） + 区间并集墙钟（overhead 口径）
  const windowsByTool = reg.collectCallsSince(taskStartWall);
  const tools: ToolAttribution[] = [];
  const allIntervals: { start: number; dur: number }[] = [];
  for (const [tool, calls] of windowsByTool) {
    const busy = calls.reduce((s, c) => s + c.dur, 0);
    tools.push({ tool, count: calls.length, totalMs: Math.round(busy) });
    allIntervals.push(...calls);
  }
  tools.sort((a, b) => b.totalMs - a.totalMs);
  const toolWallMs = unionWall(allIntervals);

  const metric = computePerfMetrics(session, item.id, item.category, { tools, toolWallMs, persistMs });
  if (error) metric.error = error;
  return { metric, session };
}

interface PerfArgs {
  mock: boolean;
  mockDelayMs: number;
  limit: number;
  concurrency: number;
  warmup: number;
  persist: boolean;
  maxIterations: number;
  timeoutMs: number;
  corpus?: string;
  out: string;
}

function parseArgs2(args: string[]): PerfArgs {
  const { values } = parseArgs({
    args,
    options: {
      mock: { type: "boolean", default: false },
      "mock-delay-ms": { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "1" },
      warmup: { type: "string", default: "0" },
      persist: { type: "boolean", default: false },
      "max-iterations": { type: "string" },
      "timeout-ms": { type: "string" },
      corpus: { type: "string" },
      out: { type: "string", default: "eval_output" },
    },
  });
  return {
    mock: values.mock ?? false,
    mockDelayMs: parseInt(values["mock-delay-ms"] ?? "0", 10) || 0,
    limit: parseInt(values.limit ?? "0", 10) || 0,
    concurrency: parseInt(values.concurrency ?? "1", 10) || 1,
    warmup: parseInt(values.warmup ?? "0", 10) || 0,
    persist: values.persist ?? false,
    maxIterations: parseInt(values["max-iterations"] ?? "8", 10) || 8,
    timeoutMs: parseInt(values["timeout-ms"] ?? "120000", 10) || 120_000,
    corpus: values.corpus,
    out: values.out ?? "eval_output",
  };
}

export async function perfMain(): Promise<void> {
  const args = parseArgs2(process.argv.slice(2));
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  console.log(`[perf] corpus=${args.corpus ?? "default(provider-qa + agent-typical)"} mock=${args.mock} concurrency=${args.concurrency} warmup=${args.warmup} maxIterations=${args.maxIterations}`);

  // 接线：mock 注入假 llm；real 走默认 DeepSeek
  const isMock = args.mock; // 存 const 避免 await 调用使 TS 属性收窄失效
  let mock: MockModel | undefined;
  let llm: ChatOpenAI;
  let bs: BootstrapResult;
  if (isMock) {
    mock = new MockModel({ delayMs: args.mockDelayMs });
    llm = mock as unknown as ChatOpenAI; // executor 只用 bindTools/invoke，结构注入
    bs = await bootstrapAgent({ llm });
  } else {
    bs = await bootstrapAgent();
    llm = bs.llm;
  }

  const corpus = loadCorpus(args.corpus);
  const tasks = args.limit > 0 ? corpus.slice(0, args.limit) : corpus;
  console.log(`[perf] tasks=${tasks.length}`);

  const optsRun: RunOneOptions = {
    bs,
    llm,
    maxIterations: args.maxIterations,
    timeoutMs: args.timeoutMs,
    warmup: args.warmup,
    persist: args.persist,
  };

  const metrics: PerfMetrics[] = [];
  const sessions: TraceSession[] = [];
  const exporter = new JsonlTraceExporter(resolve(outDir, "perf-traces.jsonl"));

  for (let i = 0; i < tasks.length; i += args.concurrency) {
    const chunk = tasks.slice(i, i + args.concurrency);
    const results = await Promise.all(chunk.map((item) => runOneTask(item, optsRun)));
    for (const { metric, session } of results) {
      metrics.push(metric);
      sessions.push(session);
      exporter.export(session);
      const flag = metric.error ? "❌" : metric.overheadPct > 30 ? "⚠️" : "  ";
      console.log(
        `${flag} [${String(metrics.length).padStart(3)}] ${metric.id} total=${metric.totalMs}ms ` +
        `llm=${metric.llmMs} tool=${metric.toolMs} overhead=${metric.overheadMs}(${metric.overheadPct.toFixed(0)}%) ` +
        `graph=${metric.graphMs ?? "-"} parse=${metric.parseMs ?? "-"} route=${metric.routeMs ?? "-"} ` +
        `iters=${metric.iterations}` + (metric.error ? ` err=${metric.error}` : ""),
      );
    }
  }

  // 聚合报告（topSlowTools 已由 aggregate 从各 metric 的 tools 明细算出）
  const report = aggregate(metrics);
  report.mode = args.mock ? "mock" : "real";
  report.concurrency = args.concurrency;
  report.corpusSize = tasks.length;

  const md = renderReport(report);
  writeFileSync(resolve(outDir, "perf-report.md"), md, "utf-8");
  appendFileSync(resolve(outDir, "perf-metrics.jsonl"),
    metrics.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");

  console.log("");
  console.log(md);
  console.log(`[perf] report: ${resolve(outDir, "perf-report.md")}`);
  console.log(`[perf] traces: ${resolve(outDir, "perf-traces.jsonl")}`);

  // 两种模式都要关池：不关的话 PG keepalive 会让事件循环挂着，进程不退出（看起来像卡死）
  await bs.pool.end();
}

const isMain =
  process.argv[1]
  && (process.argv[1].endsWith("run.ts") || resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  perfMain().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}