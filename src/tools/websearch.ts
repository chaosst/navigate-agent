import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  EnvHttpProxyAgent,
  ProxyAgent,
  type Dispatcher,
} from "undici";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** DuckDuckGo 对无 UA 的脚本请求较敏感，带上常见浏览器 UA 降低被风控概率 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 摘要截断长度，控制返回体积 / token */
const SNIPPET_MAX = 300;

/** 扩展 RequestInit：Node 的全局 fetch 运行期支持 dispatcher 字段 */
type FetchInit = RequestInit & { dispatcher?: Dispatcher };

type Fetcher = (url: string, init?: FetchInit) => Promise<Response>;

export interface WebSearchToolOptions {
  /** 便于单测注入 mock；缺省用全局 fetch */
  fetchImpl?: Fetcher;
  /**
   * 显式代理地址，如 "http://127.0.0.1:7890"。
   * 未显式提供时，回退到环境变量 WEB_SEARCH_PROXY，
   * 再退到标准的 HTTPS_PROXY / HTTP_PROXY / NO_PROXY（经 EnvHttpProxyAgent 自动识别）。
   */
  proxy?: string;
  /** 设 true 时忽略环境变量代理 */
  disableEnvProxy?: boolean;
}

/* ---------------- 纯解析/格式化工具函数（供单测直接调用） ---------------- */

/** 解码 HTML 实体：命名实体 + 数字实体（含不带分号的数字实体） */
export function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ensp: " ",
    emsp: " ",
    mdash: "—",
    ndash: "–",
  };
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+);?/g, (match, ent: string) => {
      const body = ent.slice(1); // 去掉开头的 '#'
      const isHex = body[0].toLowerCase() === "x";
      const code = isHex ? parseInt(body.slice(1), 16) : parseInt(body, 10);
      if (
        !Number.isInteger(code) ||
        code < 0 ||
        code > 0x10ffff
      ) {
        return match;
      }
      return String.fromCodePoint(code!);
    })
    .replace(/&([a-z]+);/gi, (match, name: string) =>
      named[name.toLowerCase()] ?? match,
    );
}

/** 去除标签、压缩空白 */
export function cleanText(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** 把 DuckDuckGo 跳转包装还原为真实目标 URL（解码 uddg 参数） */
export function restoreUrl(href: string): string {
  if (!href) return "";
  const decoded = decodeHtmlEntities(href);
  const u = decoded.startsWith("//") ? "https:" + decoded : decoded;
  try {
    const parsed = new URL(u, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return uddg;
    return parsed.href;
  } catch {
    return decoded;
  }
}

/** 解析 html.duckduckgo.com/html 主源：class="result__body" 块内取 result__a 与 result__snippet */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  // 以「结果块外层 div」为界切块：`class="result ` 后跟空格/引号才命中，
  // 避免误切到 result__body / result__a 等内部 class
  for (const chunk of html.split(/(?=class="result(?: |"))/gi)) {
    if (!/result__body/i.test(chunk)) continue;
    const title = chunk.match(
      /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!title) continue;
    const url = restoreUrl(title[1]);
    const t = decodeHtmlEntities(cleanText(title[2]));
    if (!url || !t) continue;
    const snip = chunk.match(
      /class="result__snippet"[^>]*>([\s\S]*?)(?=<\/a>|<\/div>)/i,
    );
    out.push({
      title: t,
      url,
      snippet: decodeHtmlEntities(cleanText(snip?.[1] ?? "")),
    });
  }
  return out;
}

/** 解析 lite.duckduckgo.com/lite 兜底源：result-link 直链 + result-snippet 摘要 */
export function parseDuckDuckGoLiteHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  // 不按行切块（嵌套的 result-snippet <tr> 会打断行块），改为位置配对：
  // 每条链接取其之后、下一条链接之前的首个 result-snippet
  const linkRe =
    /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>|(<a[^>]*href="(http[^"]*)"[^>]*>([\s\S]*?)<\/a>)/gi;
  const links = [...html.matchAll(linkRe)];
  const snips = [
    ...html.matchAll(
      /class="result-snippet"[^>]*>([\s\S]*?)(?=<\/td>|<\/tr>)/gi,
    ),
  ];
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    const href = link[1] ?? link[4];
    const title = link[2] ?? link[5];
    const from = link.index!;
    const to = i + 1 < links.length ? links[i + 1]!.index! : html.length;
    const snip = snips.find((s) => s.index! >= from && s.index! < to);
    const url = restoreUrl(href ?? "");
    const t = decodeHtmlEntities(cleanText(title ?? ""));
    if (!url || !t) continue;
    out.push({
      title: t,
      url,
      snippet: decodeHtmlEntities(cleanText(snip?.[1] ?? "")),
    });
  }
  return out;
}

/** 解析 Bing 有机结果：<li class="b_algo"> 块内 <h2><a href> 标题 + b_lineclamp 摘要 */
export function parseBingHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const chunk of html.split(/(?=<li class="b_algo")/i)) {
    const title = chunk.match(
      /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i,
    );
    if (!title) continue;
    const url = restoreUrl(title[1]);
    const t = decodeHtmlEntities(cleanText(title[2]));
    // 只保留真实 http(s) 直链，跳过 /ck/ 等站内跳转
    if (!url || !/^https?:/i.test(url) || /\/ck\//i.test(url) || !t) continue;
    const snip =
      chunk.match(
        /<p[^>]*class="([^"]*b_lineclamp[^"]*)"[^>]*>([\s\S]*?)<\/p>/i,
      ) ??
      chunk.match(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    let snippet = decodeHtmlEntities(cleanText(snip?.[2] ?? snip?.[1] ?? ""));
    // 去掉摘要开头的日期噪声，如 "2 days ago · " 或 "2026年2月6日 · "
    snippet = snippet
      .replace(
        /^\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b\s*[·,.:]?\s*/i,
        "",
      )
      .replace(/^\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*[·,.:]?\s*/, "");
    out.push({ title: t, url, snippet });
  }
  return out;
}

/* ---------------- WebSearchTool ---------------- */

function clampSnippet(s: string): string {
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) + "…" : s;
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

/** 格式化为紧凑文本，供 LLM 消费 */
export function formatResults(
  results: SearchResult[],
  query: string,
): string {
  if (results.length === 0) return `No results for "${query}".`;
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    摘要：${clampSnippet(r.snippet)}`,
    )
    .join("\n");
}

/* ---------------- WebSearchTool ---------------- */

export class WebSearchTool extends StructuredTool {
  name = "web_search";
  description =
    "互联网关键词搜索工具。当本地工具（文件搜索 / RAG）结果太少或缺失时建议调用。返回匹配的标题 / URL / 摘要列表。";

  schema = z.object({
    query: z.string().describe("搜索关键词（必填）"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("返回条数上限"),
  });

  private fetchImpl: Fetcher;
  private dispatcher: Dispatcher | null | undefined = undefined;
  private useEnvProxy: boolean;

  constructor(options: WebSearchToolOptions = {}) {
    super();
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.useEnvProxy = options.disableEnvProxy !== true;
    this._optionsProxy = options.proxy;
    // 反馈给调用方：实际采用的代理（便于排查）
    this.proxySource = this.resolveProxySource(
      this._optionsProxy,
      this.useEnvProxy,
    );
  }

  /** 实际生效的代理描述，用于日志/排查（仅诊断用） */
  readonly proxySource: string;

  private resolveProxySource(
    explicit: string | undefined,
    useEnv: boolean,
  ): string {
    if (explicit) return `explicit: ${explicit}`;
    if (!useEnv) return "none(disabled)";
    if (process.env.WEB_SEARCH_PROXY)
      return `env WEB_SEARCH_PROXY: ${process.env.WEB_SEARCH_PROXY}`;
    if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY)
      return "env HTTP(S)_PROXY";
    return "none";
  }

  /** 惰性构建请求 dispatcher：显式代理 → WEB_SEARCH_PROXY → HTTP(S)_PROXY env */
  private getDispatcher(): Dispatcher | undefined {
    if (this.dispatcher != null) return this.dispatcher;
    const explicit = this._explicitProxy;
    let agent: Dispatcher | null = null;
    if (explicit) {
      agent = new ProxyAgent(explicit);
    } else if (this.useEnvProxy) {
      const envHas =
        process.env.WEB_SEARCH_PROXY ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.ALL_PROXY;
      if (envHas) agent = new EnvHttpProxyAgent();
    }
    this.dispatcher = agent;
    return agent ?? undefined;
  }

  private get _explicitProxy(): string | undefined {
    if (this._optionsProxy !== undefined) return this._optionsProxy;
    return process.env.WEB_SEARCH_PROXY;
  }

  private _optionsProxy: string | undefined;

  protected async _call(
    arg: z.infer<typeof this.schema>,
  ): Promise<string> {
    const query = (arg.query ?? "").trim();
    if (!query) return "web_search error: query 为空。";
    const maxResults = arg.maxResults ?? 5;
    const q = encodeURIComponent(query);
    const headers = {
      "User-Agent": UA,
      "Accept-Language": "zh-CN,zh;q=0.9",
    };

    // 主源：Bing（国内可达、结果直链、免费无需 key）
    try {
      const html = await this.fetchText(
        `https://www.bing.com/search?q=${q}`,
        headers,
      );
      const results = dedupe(parseBingHtml(html).slice(0, maxResults));
      if (results.length > 0) return formatResults(results, query);
      // 主源解析为空（空结果或风控页）→ 降级 lite
      return await this.searchLite(q, headers, maxResults, query);
    } catch {
      // 主源请求失败 → 降级 lite
      return await this.searchLite(q, headers, maxResults, query);
    }
  }

  private async fetchText(
    url: string,
    headers: Record<string, string>,
  ): Promise<string> {
    const init: FetchInit = { headers };
    const dispatcher = this.getDispatcher();
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await this.fetchImpl(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  private async searchLite(
    q: string,
    headers: Record<string, string>,
    maxResults: number,
    query: string,
  ): Promise<string> {
    let lite: string;
    try {
      lite = await this.fetchText(
        `https://lite.duckduckgo.com/lite/?q=${q}`,
        headers,
      );
    } catch (err) {
      return `web_search error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const results = dedupe(parseDuckDuckGoLiteHtml(lite).slice(0, maxResults));
    return results.length > 0
      ? formatResults(results, query)
      : `No results for "${query}".`;
  }
}