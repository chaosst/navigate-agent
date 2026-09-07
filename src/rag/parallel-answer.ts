import type { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RagDocument, RagResult } from "./types.js";
import { capChunkContent } from "./retriever.js";

// ═══════════════════════════════════════════════
//  类型
// ═══════════════════════════════════════════════

export type WorkerStatus = "done" | "empty" | "error";

export interface WorkerRef {
  docId: string;
  chunkIndex: number;
}

export type ParallelEvent =
  | { type: "plan"; docs: Array<{ id: string; filename: string }> }
  | { type: "worker"; docId: string; filename: string; status: WorkerStatus }
  | { type: "sources"; sources: Array<{ docId: string; filename: string; chunkIndex: number }> }
  | { type: "answer"; text: string }
  | { type: "error"; message: string };

/** 编排器需要的 store 面：listDocs 返回带 id 的文档元信息（PgVectorStore 的 RagDocument[] 天然满足） */
export interface RagStoreLike {
  listDocs(): Promise<RagDocument[]>;
  search(query: string, k?: number, docIds?: string[]): Promise<RagResult[]>;
}

export interface ParallelOptions {
  question: string;
  docIds: string[];
  store: RagStoreLike;
  llm: ChatOpenAI;
  topK?: number;
  maxConcurrency?: number;
  llmTimeoutMs?: number;
}

// ═══════════════════════════════════════════════
//  worker：scoped 检索 + 单次提炼（恒定 1 次 LLM；绝不 reject）
// ═══════════════════════════════════════════════

interface WorkerSummary {
  docId: string;
  status: WorkerStatus;
  summary: string;
  used: WorkerRef[];
}

const WORKER_SYS = `你是文档提炼助手。你会看到一个问题与一份文档的若干检索片段（每段以 [C0]、[C1]…编号）。
规则：
1. 只依据给出的片段作答，禁止使用片段外的知识。
2. 若片段与问题无关或没有相关内容，输出 {"summary":"","used":[]}。
3. 若相关，用中文写一段通顺小结说明该文档与问题相关的要点；把实际引用到的片段编号放入 used。
4. 片段未提及的信息不要编造，可明确写"该文档未提及"。
只输出一个 JSON 对象，不要输出任何多余文字。JSON 形如：{"summary":"小结文本","used":[0,2]}`;

/** passage 编号数组 → WorkerRef（chunkIndex 为空则丢弃，保证引用键稳定） */
function refsOf(hits: RagResult[], used: number[]): WorkerRef[] {
  const seen = new Set<string>();
  const out: WorkerRef[] = [];
  for (const i of used) {
    const hit = hits[i];
    if (!hit || hit.chunkIndex === undefined) continue;
    const key = `${hit.docId}:${hit.chunkIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ docId: hit.docId, chunkIndex: hit.chunkIndex });
  }
  return out;
}

/** 容忍代码围栏/前后空白的 JSON 解析；失败返回 null */
function parseWorkerJson(text: string): { summary: string; used: number[] } | null {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const o = JSON.parse(t);
    if (o && typeof o.summary === "string") {
      const used = Array.isArray(o.used)
        ? o.used.filter((x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0)
        : [];
      return { summary: o.summary, used };
    }
  } catch { /* fall through */ }
  return null;
}

/** worker user 片段块：编号 + 截断；总长超限则丢尾部并标注 */
function buildPassageBlock(hits: RagResult[]): string {
  const MAX_TOTAL = 30_000;
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < hits.length; i++) {
    const text = capChunkContent(hits[i].content);
    const seg = `[C${i}] ${text}`;
    if (total + seg.length > MAX_TOTAL) break;
    parts.push(seg);
    total += seg.length;
  }
  return parts.join("\n\n");
}

async function runOneWorker(
  doc: RagDocument,
  question: string,
  topK: number,
  store: RagStoreLike,
  llm: ChatOpenAI,
  timeoutMs: number,
): Promise<WorkerSummary> {
  let hits: RagResult[] = [];
  try {
    hits = await store.search(question, topK, [doc.id]);
  } catch (e) {
    console.warn(`[parallel-answer] worker search failed (${doc.id}):`, (e as Error).message);
    return { docId: doc.id, status: "error", summary: "", used: [] };
  }
  if (hits.length === 0) return { docId: doc.id, status: "empty", summary: "", used: [] };

  const block = buildPassageBlock(hits);
  const user = `【问题】${question}\n【文档】${doc.filename}\n【检索片段】\n${block}`;
  let text: string;
  try {
    const raw = await llm.invoke([new SystemMessage(WORKER_SYS), new HumanMessage(user)], { timeout: timeoutMs });
    const content = raw.content;
    text = typeof content === "string" ? content : JSON.stringify(content);
  } catch (e) {
    console.warn(`[parallel-answer] worker LLM failed (${doc.id}):`, (e as Error).message);
    return { docId: doc.id, status: "error", summary: "", used: [] };
  }

  const parsed = parseWorkerJson(text);
  if (!parsed) {
    // JSON 兜底：摘要退化、used 取全部检索（不让 worker 白跑）
    return {
      docId: doc.id, status: "done",
      summary: block.slice(0, 2000),
      used: refsOf(hits, hits.map((_, i) => i)),
    };
  }
  if (parsed.summary.trim() === "") return { docId: doc.id, status: "empty", summary: "", used: [] };
  return { docId: doc.id, status: "done", summary: parsed.summary.trim(), used: refsOf(hits, parsed.used) };
}

// ═══════════════════════════════════════════════
//  合成：把各文档提炼汇成统一答案
// ═══════════════════════════════════════════════

const SYNTH_SYS = `你是综合分析助手。下面是针对同一个问题、来自不同文档的提炼小结（已按文档归类）。
请综合成一段可直接展示的统一中文答案：
1. 只依据给定的提炼内容作答，不得编造。
2. 若某些要点来自特定文档，用【文档名】标注来源。
3. 若不同文档信息矛盾，明确指出矛盾点与各自说法。
4. 若给定内容不足以回答，明确说明"材料不足以回答"，并指出缺什么。
结构清晰、分点作答，正文可直接展示。`;

async function synthesize(
  question: string,
  doneWorkers: Array<{ summary: string; filename: string }>,
  llm: ChatOpenAI,
  timeoutMs: number,
): Promise<string> {
  const block = doneWorkers
    .map((w) => `【文档：${w.filename}】\n${w.summary}`)
    .join("\n\n");
  const user = `【问题】${question}\n【各文档提炼】\n${block}`;
  const raw = await llm.invoke([new SystemMessage(SYNTH_SYS), new HumanMessage(user)], { timeout: timeoutMs });
  const content = raw.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

// ═══════════════════════════════════════════════
//  Orchestrator：校验 → 信号量并发 worker（完成即推事件）→ sources → 合成
// ═══════════════════════════════════════════════

export async function* answerAcrossDocs(opts: ParallelOptions): AsyncGenerator<ParallelEvent> {
  const { question, docIds, store, llm } = opts;
  const topK = opts.topK ?? 6;
  const timeoutMs = opts.llmTimeoutMs ?? 120_000;
  const concurrency = Math.max(1, opts.maxConcurrency ?? 4);

  // 1) 校验 docIds
  let allDocs: RagDocument[];
  try {
    allDocs = await store.listDocs();
  } catch (e) {
    yield { type: "error", message: `无法读取文档列表：${(e as Error).message}` };
    return;
  }
  const byId = new Map(allDocs.map((d) => [d.id, d]));
  const unknown = docIds.filter((id) => !byId.has(id));
  const targets = docIds.map((id) => byId.get(id)).filter((d): d is RagDocument => !!d);
  if (targets.length === 0) {
    yield { type: "error", message: unknown.length ? `未知文档 id：${unknown.join("，")}` : "未选择文档" };
    return;
  }
  yield { type: "plan", docs: targets.map((d) => ({ id: d.id, filename: d.filename })) };

  // 2) 信号量并发 worker；每完成一个就推 worker 事件（保顺序可用索引占位）
  const pendingQ: Array<{ o: number; w: WorkerSummary }> = [];
  const waitersQ: Array<(v: { o: number; w: WorkerSummary }) => void> = [];
  const pushQ = (v: { o: number; w: WorkerSummary }) => {
    const waiter = waitersQ.shift();
    if (waiter) waiter(v);
    else pendingQ.push(v);
  };
  const popQ = () =>
    pendingQ.length
      ? Promise.resolve(pendingQ.shift()!)
      : new Promise<{ o: number; w: WorkerSummary }>((r) => waitersQ.push(r));

  const results: WorkerSummary[] = new Array(targets.length);
  let cursor = 0;
  let active = 0;
  const pump = () => {
    while (active < concurrency && cursor < targets.length) {
      const o = cursor++;
      const doc = targets[o];
      active++;
      // runOneWorker 内部全量 catch，这里不会 reject
      void runOneWorker(doc, question, topK, store, llm, timeoutMs).then((w) => {
        results[o] = w;
        active--;
        pushQ({ o, w });
        pump();
      });
    }
  };
  pump();
  for (let k = 0; k < targets.length; k++) {
    const { o, w } = await popQ();
    yield { type: "worker", docId: w.docId, filename: targets[o].filename, status: w.status };
  }

  // 3) 空/全失败短路
  const doneWorkers = results.filter((w) => w.status === "done" && w.summary.trim() !== "");
  if (doneWorkers.length === 0) {
    yield {
      type: "answer",
      text: "文档库中没有找到与该问题相关的内容。可尝试：更换关键词、勾选其他文档，或先上传相关文档。",
    };
    return;
  }

  // 4) sources 并集（(docId, chunkIndex) 去重，按首次出现保序）
  const srcMap = new Map<string, { docId: string; filename: string; chunkIndex: number }>();
  for (const w of doneWorkers) {
    const doc = byId.get(w.docId);
    const filename = doc?.filename ?? w.docId;
    for (const ref of w.used) {
      const key = `${ref.docId}:${ref.chunkIndex}`;
      if (!srcMap.has(key)) srcMap.set(key, { docId: ref.docId, filename, chunkIndex: ref.chunkIndex });
    }
  }
  if (srcMap.size > 0) yield { type: "sources", sources: [...srcMap.values()] };

  // 5) 合成终答
  const finalText = await synthesize(
    question,
    doneWorkers.map((w) => ({ summary: w.summary, filename: byId.get(w.docId)?.filename ?? w.docId })),
    llm,
    timeoutMs,
  );
  yield { type: "answer", text: finalText };
}
