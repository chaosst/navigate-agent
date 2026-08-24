import { describe, it, expect, afterEach, vi } from "vitest";
import {
  WebSearchTool,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLiteHtml,
  parseBingHtml,
  formatResults,
  decodeHtmlEntities,
  cleanText,
  restoreUrl,
  type SearchResult,
} from "../websearch.js";

/** 模拟 html 主源的一段真实形态 SERP */
const HTML_SERP = `<html><body>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FLangChain&amp;rut=a1b2">LangChain - Wikipedia</a>
    </h2>
    <div class="result__snippet">
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FLangChain&amp;rut=x">LangChain is a framework for developing applications &amp; tools powered by LLMs.</a>
    </div>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://github.com/langchain-ai/langchain">Introduction &#x27;GitHub&#x27; repo</a>
    </h2>
    <div class="result__snippet"><div>Build context-aware reasoning apps.</div></div>
  </div>
</div>
<div class="result results_links web-result no-result">
  <div class="no-result">filtered out without result__body</div>
</div>
</body></html>`;

/** 模拟 lite 兜底源的一段 SERP */
const LITE_SERP = `<html><body>
<table>
<tr><td valign="top">1.</td><td valign="top">
  <a rel="nofollow" class="result-link" href="https://example.com/a">Example A</a>
  <table><tr><td class="result-snippet">First snippet with &amp; symbol.</td></tr></table>
</td></tr>
<tr><td valign="top">2.</td><td valign="top">
  <a rel="nofollow" class="result-link" href="https://example.com/b?x=1&amp;y=2">Example B</a>
  <table><tr><td class="result-snippet">Second snippet.</td></tr></table>
</td></tr>
</table>
</body></html>`;

/** 模拟 Bing 有机结果：真实直链 + b_lineclamp 摘要 + 一条 /ck/ 站内跳转（应被过滤） */
const BING_SERP = `<html><body>
<ol id="b_results">
<li class="b_algo">
  <h2><a href="https://www.langchain.com/langchain">LangChain : Open Source AI Agent Framework</a></h2>
  <div class="b_caption">
    <p class="b_lineclamp2">2 days ago&ensp;&#0183;&ensp;LangChain is an open-source framework for building agent apps with LLMs.</p>
  </div>
</li>
<li class="b_algo">
  <h2><a href="https://en.wikipedia.org/wiki/LangChain">LangChain &amp; Wikipedia</a></h2>
  <div class="b_caption"><p class="b_lineclamp b_algoSlug">Second result snippet with &amp; symbol.</p></div>
</li>
<li class="b_algo">
  <h2><a href="https://www.bing.com/ck/a?key=redirect">An ad-like ck redirect</a></h2>
  <div class="b_caption"><p class="b_lineclamp">Should be skipped.</p></div>
</li>
</ol>
</body></html>`;

/** 构造最小可用的 mock Response（工具仅用到 ok / text） */
function mockRes(body: string, ok = true, status = 200): Response {
  return { ok, status, text: async () => body } as unknown as Response;
}

describe("decodeHtmlEntities", () => {
  it("解码命名实体", () => {
    expect(decodeHtmlEntities("a &amp; b &lt;c&gt; &quot;q&quot; &apos;x&apos;")).toBe(
      "a & b <c> \"q\" 'x'",
    );
  });
  it("解码数字实体（含十六进制与非分号形式）", () => {
    expect(decodeHtmlEntities("&#x27;quote&#39; &#38;")).toBe("'quote' &");
  });
});

describe("cleanText", () => {
  it("剥离标签并压缩空白", () => {
    expect(cleanText("<span> Hello\t world </span>\n  foo")).toBe("Hello world foo");
  });
});

describe("restoreUrl", () => {
  it("还原 uddg 跳转包装为真实 URL", () => {
    expect(
      restoreUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FLangChain&amp;rut=a1b2"),
    ).toBe("https://en.wikipedia.org/wiki/LangChain");
  });
  it("无 uddg 时保留原地址（含实体 &amp;）", () => {
    expect(restoreUrl("https://example.com/b?x=1&amp;y=2")).toBe(
      "https://example.com/b?x=1&y=2",
    );
  });
});

describe("parseDuckDuckGoHtml", () => {
  const result = parseDuckDuckGoHtml(HTML_SERP);
  it("解析出可用的结果（跳过无 result__body 的块）", () => {
    expect(result).toHaveLength(2);
  });
  it("提取 title/url/snippet 三元组", () => {
    const first = result[0] as SearchResult;
    expect(first.title).toBe("LangChain - Wikipedia");
    expect(first.url).toBe("https://en.wikipedia.org/wiki/LangChain");
    expect(first.snippet).toBe(
      "LangChain is a framework for developing applications & tools powered by LLMs.",
    );
  });
  it("解析数字实体与直链 URL", () => {
    const second = result[1] as SearchResult;
    expect(second.title).toBe("Introduction 'GitHub' repo");
    expect(second.url).toBe("https://github.com/langchain-ai/langchain");
    expect(second.snippet).toBe("Build context-aware reasoning apps.");
  });
  it("空输入返回空数组", () => {
    expect(parseDuckDuckGoHtml("<html><body></body></html>")).toEqual([]);
  });
});

describe("parseDuckDuckGoLiteHtml", () => {
  it("解析 result-link / result-snippet", () => {
    const result = parseDuckDuckGoLiteHtml(LITE_SERP);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      title: "Example A",
      url: "https://example.com/a",
      snippet: "First snippet with & symbol.",
    });
    expect(result[1].url).toBe("https://example.com/b?x=1&y=2");
  });
});

describe("parseBingHtml", () => {
  it("解析真实直链结果并剥离摘要日期噪声 / 解码实体", () => {
    const result = parseBingHtml(BING_SERP);
    expect(result).toHaveLength(2); // 第 3 条 /ck/ 跳转被过滤
    expect(result[0]).toEqual({
      title: "LangChain : Open Source AI Agent Framework",
      url: "https://www.langchain.com/langchain",
      snippet:
        "LangChain is an open-source framework for building agent apps with LLMs.",
    });
    expect(result[1]).toEqual({
      title: "LangChain & Wikipedia",
      url: "https://en.wikipedia.org/wiki/LangChain",
      snippet: "Second result snippet with & symbol.",
    });
  });
  it("剥离中文日期噪声", () => {
    const html = `<li class="b_algo"><h2><a href="https://e.com/a">标题A</a></h2><div class="b_caption"><p class="b_lineclamp">2026年2月6日 · 中文摘要正文。</p></div></li>`;
    const result = parseBingHtml(html);
    expect(result[0].snippet).toBe("中文摘要正文。");
  });
  it("空输入返回空数组", () => {
    expect(parseBingHtml("<html><body></body></html>")).toEqual([]);
  });
});

describe("formatResults", () => {
  it("按模板输出紧凑文本", () => {
    const s = formatResults(
      [{ title: "T", url: "https://e.com", snippet: "Snippet" }],
      "q",
    );
    expect(s).toContain("[1] T\n    URL: https://e.com");
    expect(s).toContain("摘要：Snippet");
  });
  it("空结果返回 No results", () => {
    expect(formatResults([], "abc")).toBe('No results for "abc".');
  });
  it("超长摘要被截断", () => {
    const long = "x".repeat(400);
    const s = formatResults([{ title: "T", url: "https://e", snippet: long }], "q");
    expect(s).toContain("…");
    expect(s.length).toBeLessThan(500);
  });
});

describe("WebSearchTool._call", () => {
  it("主源正常时返回格式化结果并 URL 编码 query（默认源为 Bing）", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("bing.com/search");
      expect(url).toContain("q=hello%20world");
      return mockRes(BING_SERP);
    });
    const tool = new WebSearchTool({ fetchImpl });
    const out = await tool.invoke({ query: "hello world", maxResults: 2 });
    expect(out).toContain("[1] LangChain : Open Source AI Agent Framework");
    expect(out).toContain("URL: https://www.langchain.com/langchain");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maxResults 生效（截断条数）", async () => {
    const fetchImpl = vi.fn(async () => mockRes(BING_SERP));
    const tool = new WebSearchTool({ fetchImpl });
    const out = await tool.invoke({ query: "q", maxResults: 1 });
    const lines = out.split("\n").filter((l: string) => l.startsWith("["));
    expect(lines).toHaveLength(1);
  });

  it("主源 !ok 时降级 lite", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockRes("", false, 403))
      .mockResolvedValueOnce(mockRes(LITE_SERP));
    const tool = new WebSearchTool({ fetchImpl });
    const out = await tool.invoke({ query: "q", maxResults: 5 });
    expect(out).toContain("[1] Example A");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toContain("lite.duckduckgo.com");
  });

  it("主源解析为空（风控页）时降级 lite", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockRes("<html><body>anomaly</body></html>"))
      .mockResolvedValueOnce(mockRes(LITE_SERP));
    const tool = new WebSearchTool({ fetchImpl });
    const out = await tool.invoke({ query: "q", maxResults: 5 });
    expect(out).toContain("[1] Example A");
  });

  it("主源抛错时降级 lite", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(mockRes(LITE_SERP));
    const tool = new WebSearchTool({ fetchImpl });
    const out = await tool.invoke({ query: "q", maxResults: 5 });
    expect(out).toContain("[1] Example A");
  });

  it("双源都失败时返回可读错误而非抛异常", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("html down"))
      .mockRejectedValueOnce(new Error("lite down"));
    const tool = new WebSearchTool({ fetchImpl });
    const out = await tool.invoke({ query: "q", maxResults: 5 });
    expect(out).toContain("web_search error");
    expect(out).toContain("lite down");
  });

  it("双源均无结果时返回 No results", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockRes("<html></html>"))
      .mockResolvedValueOnce(mockRes("<html></html>"));
    const tool = new WebSearchTool({ fetchImpl });
    const out = await tool.invoke({ query: "zzz", maxResults: 5 });
    expect(out).toBe('No results for "zzz".');
  });

  it("空 query 返回友好错误", async () => {
    const fetchImpl = vi.fn();
    const tool = new WebSearchTool({ fetchImpl });
    const out = await tool.invoke({ query: "   ", maxResults: 5 });
    expect(out).toContain("web_search error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("WebSearchTool 代理配置", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("显式 proxy 时 dispatcher 被注入请求，proxySource 显式", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: { dispatcher?: unknown }) => {
        expect(init?.dispatcher).toBeTruthy();
        return mockRes(BING_SERP);
      },
    );
    const tool = new WebSearchTool({ fetchImpl, proxy: "http://127.0.0.1:7890" });
    expect(tool.proxySource).toBe("explicit: http://127.0.0.1:7890");
    await tool.invoke({ query: "q", maxResults: 5 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("读取环境变量 WEB_SEARCH_PROXY", async () => {
    vi.stubEnv("WEB_SEARCH_PROXY", "http://127.0.0.1:7890");
    const fetchImpl = vi.fn(
      async (_url: string, init?: { dispatcher?: unknown }) => {
        expect(init?.dispatcher).toBeTruthy();
        return mockRes(BING_SERP);
      },
    );
    const tool = new WebSearchTool({ fetchImpl });
    expect(tool.proxySource).toContain("WEB_SEARCH_PROXY");
    await tool.invoke({ query: "q", maxResults: 5 });
  });

  it("无任何代理时 dispatcher 为空、proxySource 为 none", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: { dispatcher?: unknown }) => {
        expect(init?.dispatcher).toBeUndefined();
        return mockRes(BING_SERP);
      },
    );
    const tool = new WebSearchTool({ fetchImpl });
    expect(tool.proxySource).toBe("none");
    await tool.invoke({ query: "q", maxResults: 5 });
  });

  it("disableEnvProxy 时忽略环境变量代理", async () => {
    vi.stubEnv("WEB_SEARCH_PROXY", "http://127.0.0.1:7890");
    const tool = new WebSearchTool({ disableEnvProxy: true });
    expect(tool.proxySource).toBe("none(disabled)");
  });
});