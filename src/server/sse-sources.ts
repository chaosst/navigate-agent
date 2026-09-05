/**
 * server/sse-sources.ts — 从 resume chat 的 executor 流中提取引用来源
 *
 * 背景：/api/resume/chat 通过 executor.stream() 消费 LangGraph 输出。流中的 chunk
 * 有两类：文本 token（chunk.output）与工具调用记录（chunk.intermediateSteps）。
 * search_resume 工具每次调用都会把命中的简历片段按
 *   `[1] 简历 / experience / 某公司\n内容...`
 * 格式返回（见 src/resume/search-tool.ts 的 _call 输出），本模块负责把这类
 * observation 文本解析成结构化来源列表，供服务端通过 SSE 的 `event: sources`
 * 回传给前端渲染引用 chip。
 *
 * 设计点：来源只采信「模型真实调用 search_resume 后拿到的片段」，而不是让模型
 * 在正文里自报引用 —— 后者不可信。这保证前端展示的每个来源都能回溯到一次真实检索。
 */

/** 单次工具调用 observation（LangGraph AgentStep 子集，便于单测注入） */
export interface StepLike {
  action?: { tool?: string };
  observation?: unknown;
}

/**
 * 从一条 search_resume 的 observation 文本中解析来源行。
 * 格式：`[1] 简历 / experience / xxx`（块首行），可多块。
 * 非字符串 / 无匹配 → 空数组。
 */
export function parseObservationSources(obs: unknown): string[] {
  if (typeof obs !== "string") return [];
  const sources: string[] = [];
  const re = /^\[\d+\]\s*(简历\s*\/.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(obs)) !== null) {
    sources.push(m[1]);
  }
  return sources;
}

/**
 * 从单个 stream chunk 中提取来源（仅 search_resume 工具的调用有效）。
 * 返回去重、保序的来源数组。
 */
export function sourcesFromChunk(chunk: {
  intermediateSteps?: StepLike[];
}): string[] {
  const found: string[] = [];
  for (const step of chunk.intermediateSteps ?? []) {
    if (step.action?.tool !== "search_resume") continue;
    found.push(...parseObservationSources(step.observation));
  }
  // 去重保序（同一片段可能被多次检索命中）
  return [...new Set(found)];
}
