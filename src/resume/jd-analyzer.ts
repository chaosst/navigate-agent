/**
 * resume/jd-analyzer.ts — JD 匹配诊断
 *
 * 场景：访客把目标岗位描述（JD）贴进来，希望知道"我的简历和这个岗位匹不匹配，
 * 差在哪、怎么改"。这是从"被动问答"到"主动诊断"的纵深，也是简历问答的面试谈资点。
 *
 * 设计取舍：简历体量小（<100 chunks），JD 诊断需要的是"全局视角"（逐条比对），
 * 而不是 RAG 的"局部命中"——因此这里把简历全文 + JD 一次性交给 LLM 做结构化输出，
 * 不经过 agent 循环，也不做分块检索。换来：单次调用、低延迟、结果稳定可 parse。
 *
 * 失败策略：LLM 输出不是合法 JSON 时返回 null（由调用方决定 502/重试），
 * 绝不把乱码 JSON 当结果展示。
 */
import type { ChatOpenAI } from "@langchain/openai";
import type { ResumeData } from "./types.js";

/**
 * JD 诊断输入预算：简历紧凑序列化后的最大字符数。
 * 中文 markdown ≈ 0.6~0.7 token/字 → 12000 字符 ≈ 8K tokens，
 * 加上 JD(≤4000 字符 ≈ 2.6K)与输出预留，16K 窗口的小模型也能装下。
 * 超限说明"单次调用放不下全局比对"——应报可读错误而非让 provider 报错/丢质量。
 */
export const MAX_JD_RESUME_CHARS = 12000;

/** 简历超过诊断预算时抛出的可读错误（路由层转 400，区别于其它 502） */
export class ResumeTooLongError extends Error {
  constructor(chars: number) {
    super(
      `简历过长（${chars} 字符，上限 ${MAX_JD_RESUME_CHARS}），当前版本不支持超长简历的自动诊断，请精简后再试`,
    );
    this.name = "ResumeTooLongError";
  }
}

/**
 * 把结构化 ResumeData 紧凑序列化为 LLM 友好的 markdown 文本。
 * 相比 resume.md 原文：去掉 frontmatter / 格式装饰 / 空行噪音，token 更省、信息不丢。
 * 仅 JD 诊断使用——RAG 检索 / 展示页仍走各自的原始结构。
 */
export function serializeResumeForJd(data: ResumeData): string {
  const parts: string[] = [];
  if (data.name || data.title) {
    parts.push(`# ${[data.name, data.title].filter(Boolean).join(" — ")}`);
  }
  if (data.summary) parts.push(data.summary);
  for (const section of data.sections) {
    const lines = [`## ${section.title}`];
    for (const item of section.items) {
      const head = [item.title, item.dateRange ? `(${item.dateRange})` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`### ${head}`);
      if (item.subtitle) lines.push(item.subtitle);
      if (item.description) lines.push(item.description);
      for (const h of item.highlights ?? []) lines.push(`- ${h}`);
    }
    if (lines.length > 1) parts.push(lines.join("\n")); // 空 section 不输出
  }
  return parts.join("\n\n").trim();
}

/** 预算断言：超限抛 ResumeTooLongError（analyzeJdMatch 入口调用） */
export function assertResumeBudget(serialized: string): void {
  if (serialized.length > MAX_JD_RESUME_CHARS) {
    throw new ResumeTooLongError(serialized.length);
  }
}

export interface JdMatchResult {
  /** 0-100 匹配分 */
  score: number;
  /** 一句话总评 */
  summary: string;
  /** 简历与 JD 匹配的优势点 */
  strengths: string[];
  /** 简历相对 JD 的差距（缺失/弱化的技能或经历） */
  gaps: string[];
  /** 按优先级排序的简历修改建议 */
  suggestions: string[];
}

/** 构造 JD 诊断 prompt：简历全文 + JD + 严格 JSON 输出要求 */
export function buildJdPrompt(resumeText: string, jd: string): string {
  return `你是一位资深技术面试官与简历优化顾问。请把下面这份候选人简历与目标岗位 JD 做匹配分析，输出**严格 JSON**（不要 Markdown 代码块包裹之外的任何文字）。

## 候选人简历全文
${resumeText}

## 目标岗位 JD
${jd}

## 输出要求
只输出一个 JSON 对象，字段：
{
  "score": 0-100 的整数（整体匹配度）,
  "summary": "一句话总评",
  "strengths": ["与 JD 匹配的优势点，每条一句"],
  "gaps": ["相对 JD 的差距：缺失或弱化的技能/经历，每条一句"],
  "suggestions": ["按优先级排列的简历修改建议，每条一句，具体可执行"]
}
不要输出 JSON 以外的解释。`;
}

/**
 * 从 LLM 原始输出中稳健地提取 JSON。
 * 容忍：```json fence、前后噪音文字、空串。
 * 失败（不是合法 JSON）→ null。
 */
export function parseJdResult(raw: string): JdMatchResult | null {
  if (!raw || typeof raw !== "string") return null;

  // 1. 去掉 ```json ... ``` / ``` ... ``` fence
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  // 2. 从第一个 { 截到最后一个 }（容忍前后噪音）
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  text = text.slice(start, end + 1);

  // 3. parse + 结构校验
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof obj.score !== "number" ||
      typeof obj.summary !== "string" ||
      !Array.isArray(obj.strengths) ||
      !Array.isArray(obj.gaps) ||
      !Array.isArray(obj.suggestions)
    ) {
      return null;
    }
    return {
      score: Math.max(0, Math.min(100, Math.round(obj.score))),
      summary: obj.summary,
      strengths: obj.strengths.map(String),
      gaps: obj.gaps.map(String),
      suggestions: obj.suggestions.map(String),
    };
  } catch {
    return null;
  }
}

/** 执行 JD 匹配分析（一次 LLM 调用，非 agent 循环）。解析失败时抛出可读错误。 */
export async function analyzeJdMatch(
  llm: ChatOpenAI,
  resumeText: string,
  jd: string,
): Promise<JdMatchResult> {
  assertResumeBudget(resumeText); // 预算护栏：超长简历给出可读错误，而不是烧完上下文后 provider 报错
  const prompt = buildJdPrompt(resumeText, jd);
  const resp = await llm.invoke(prompt);
  const content = Array.isArray(resp.content)
    ? resp.content.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("")
    : resp.content;
  const result = parseJdResult(String(content ?? ""));
  if (!result) {
    throw new Error("JD 分析结果不是合法 JSON，请重试");
  }
  return result;
}
