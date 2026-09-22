/**
 * `agent-plan.html` 的「假 DOM」执行器 —— 让 Node 里能跑页面那段真实脚本。
 *
 * 为什么需要它：编排视图的风险不在服务端，而在页面这段状态机里，而且是**沉默**的：
 *   · 用 `plan.currentStepIndex` 定位当前步 → 进行中态永远停在第一步（引擎该字段恒为 0）；
 *   · 工具 chip 归属错步 → 工具全挂到下一步（依赖 plan → tool 的出流顺序）；
 *   · finalizing 阶段没接上 → 全绿之后白屏死等（generateFinalAnswer 是又一次完整 LLM 调用）。
 * 这三种错都不会让接口报错、不会让 tsc 报错，只有真跑一遍页面脚本才暴露。
 *
 * 为什么抽成一份：与 `resume-page-harness.ts` 同一套契约 —— 测试与（将来的）
 * 静态预览脚本共用这一个 shim。**页面脚本用到的每条 DOM 能力都必须在这里实现**，
 * 两处各持一份的旧账（resume 页 `pdfBtn.addEventListener is not a function`）不要重演。
 *
 * 页面侧配合约定（不是巧合，是为了可测）：
 *   · 结构一律 createElement + appendChild，不用 innerHTML 拼骨架；
 *   · 子元素引用缓存在 `node.$`，不靠 querySelector 回读；
 *     ⇒ 因此本 shim 不需要实现 HTML 解析，只需实现 appendChild / textContent 清空语义。
 */

/** 浏览器把文本节点的 innerHTML 序列化为转义后的字符串 */
const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class FakeEvent {
  key = "";
  shiftKey = false;
  defaultPrevented = false;
  constructor(init: Partial<FakeEvent> = {}) {
    Object.assign(this, init);
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

export class FakeEl {
  className = "";
  /** 子节点（appendChild 追加；textContent 赋值会清空，与浏览器一致） */
  children: FakeEl[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = "";
  onclick: (() => void) | null = null;
  /** 被赋值 innerHTML 时捕获原始字符串（用于读 #answer-box 的渲染结果） */
  capturedHtml: string | null = null;
  private handlers: Record<string, Array<(e: FakeEvent) => void>> = {};
  private _text = "";

  get textContent(): string {
    return this._text;
  }
  /**
   * 赋 textContent 在浏览器里会替换元素全部内容（子节点 + innerHTML 一起没了）。
   * 页面的「重绘清屏」依赖这个语义，`capturedHtml` 也必须随之失效 ——
   * 否则新一轮的 `answerEl.textContent = ""` 之后还能读到上一轮的 HTML。
   */
  set textContent(v: string) {
    this._text = v ?? "";
    this.children = [];
    this.capturedHtml = null;
  }
  set innerHTML(v: string) {
    this.capturedHtml = v;
    this._text = "";
    this.children = [];
  }
  get innerHTML(): string {
    return escapeText(this._text);
  }

  appendChild(child: FakeEl): FakeEl {
    // 浏览器语义：已在别处的节点被「移动」而不是复制
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    (this.handlers[type] ||= []).push(fn);
  }
  /** 触发已注册的监听器（测试用来点按钮 / 敲回车） */
  fire(type: string, e: FakeEvent = new FakeEvent()): void {
    for (const fn of this.handlers[type] ?? []) fn(e);
  }
  getAttribute(): string | null {
    return null;
  }
  setAttribute(): void {
    /* noop */
  }

  /** 深度优先收集全部后代（断言辅助） */
  all(): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (el: FakeEl) => {
      for (const c of el.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  /** 按 class 精确匹配取后代 */
  byClass(cls: string): FakeEl[] {
    return this.all().filter((e) => e.className.split(/\s+/).includes(cls));
  }
  /** 直接子节点里按 class 精确匹配 */
  childByClass(cls: string): FakeEl | undefined {
    return this.children.find((e) => e.className.split(/\s+/).includes(cls));
  }
}

/** 一份 plan 快照的 SSE 帧 */
export function sseFrame(ev: unknown): string {
  const type = (ev as { type: string }).type;
  return `event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

export interface MountPlanPageOptions {
  /** SSE 帧文本，按序喂给页面（模拟服务端逐 chunk 写） */
  frames: string[];
  /** 每帧切分成几段传输，用于验证跨 chunk 的半截帧缓冲（默认 1 = 整帧一次到） */
  chunkSize?: number;
  /** 非 200 响应体（用于验证错误分支） */
  errorStatus?: number;
  /** 是否注入 marked / DOMPurify stub（默认注入；传 false 验证降级 escapeHtml 分支） */
  injectMd?: boolean;
  /**
   * 帧吐完后把流**挂住**（下一条 read 悬而不决），用于观察流未结束时的中途态
   * —— 否则 run() 的 finally 会立刻把 phase 推成 done，那就只剩终态可断言了。
   * 挂住后用 `release()` 收尾。
   */
  holdOpen?: boolean;
}

export interface MountedPlanPage {
  stage: FakeEl;
  answerBox: FakeEl;
  answerPanel: FakeEl;
  metrics: FakeEl;
  phaseEls: FakeEl[];
  runBtn: FakeEl;
  input: FakeEl;
  /**
   * 点击「规划并执行」。
   * - 默认（holdOpen 未开）：等流跑完 + finally 收口，返回时可断言终态；
   * - holdOpen 开启：等所有帧被页面 apply 完即返回（流仍挂着），可断言中途态；
   *   之后调 `release()` 让流正常结束。
   */
  clickRun(question: string): Promise<void>;
  /** 放行被 holdOpen 挂住的流，并等 finally 收口 */
  release(): Promise<void>;
  /** 页面实际请求的 URL / body（验证 token 与 question 真的带上了） */
  requests: Array<{ url: string; body: string }>;
  /** marked.parse / DOMPurify.sanitize 的调用记录（验证 XSS 净化路径真的被走） */
  mdCalls: { parsed: string[]; sanitized: string[] };
  alerts: string[];
}

export function extractScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("agent-plan.html 中找不到 <script> 块");
  return m[1];
}

/**
 * 跑一遍页面脚本，返回可驱动的副作用出口。
 * 注意：`alert` 会被收集而不是真弹（空输入分支需要它不炸）。
 */
export async function mountPlanPage(
  html: string,
  opts: MountPlanPageOptions,
): Promise<MountedPlanPage> {
  const script = extractScript(html);

  // getElementById 对同一 id 返回同一实例（页面在模块级取引用，之后反复用）
  const byId = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    let e = byId.get(id);
    if (!e) {
      e = new FakeEl();
      byId.set(id, e);
    }
    return e;
  };

  const mdCalls = { parsed: [] as string[], sanitized: [] as string[] };
  const alerts: string[] = [];

  // SSE 帧切片：默认整帧一次到；chunkSize > 1 时故意把帧切开，验证页面的 buffer 拼接
  const pending = opts.frames.map((f) => f).join("");
  const cuts: string[] = [];
  if (opts.frames.length === 0) {
    /* 无帧：留空 */
  } else if (!opts.chunkSize || opts.chunkSize <= 1) {
    cuts.push(...opts.frames);
  } else {
    for (let i = 0; i < pending.length; i += opts.chunkSize) {
      cuts.push(pending.slice(i, i + opts.chunkSize));
    }
  }
  let cursor = 0;
  let releaseFn: (() => void) | null = null;
  const requests: Array<{ url: string; body: string }> = [];

  /** 让页面把已入队的帧全部消费掉（每次 read 只取一片，故要跨多轮微任务） */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 500 && cursor < cuts.length; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 2));
    for (let i = 0; i < 500; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 2));
  };

  const encoder = new TextEncoder();
  const fakeFetch = async (_url: string, init?: { body?: string }) => {
    requests.push({ url: _url, body: init?.body ?? "" });
    if (opts.errorStatus) {
      return {
        ok: false,
        status: opts.errorStatus,
        statusText: "Error",
        json: async () => ({ error: "Plan agent 未装配（H5_PLAN_AGENT 未开启或装配失败）" }),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({}),
      body: {
        getReader: () => ({
          read: async () => {
            if (cursor >= cuts.length) {
              // holdOpen：悬而不决，模拟「服务端还在跑、客户端在等下一帧」
              if (opts.holdOpen) await new Promise<void>((r) => { releaseFn = r; });
              return { done: true, value: undefined as Uint8Array | undefined };
            }
            const value = encoder.encode(cuts[cursor++]);
            return { done: false, value };
          },
        }),
      },
    };
  };

  const fakeDocument = {
    getElementById: el,
    createElement: () => new FakeEl(),
    querySelectorAll: () => [] as unknown[],
  };
  const session = new Map<string, string>([["navigate_token", "test-token"]]);
  const fakeSessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  };
  const fakeLocation = { search: "", pathname: "/agent/plan", href: "" };
  const stubbed = opts.injectMd !== false;
  const markedStub = stubbed
    ? { parse: (t: string) => { mdCalls.parsed.push(t); return "<p>" + t + "</p>"; } }
    : undefined;
  const domPurifyStub = stubbed
    ? { sanitize: (h: string) => { mdCalls.sanitized.push(h); return h.replace(/<script>[\s\S]*?<\/script>/g, ""); } }
    : undefined;
  const fakeAlert = (msg: string) => void alerts.push(String(msg));

  const run = new Function(
    "document",
    "location",
    "sessionStorage",
    "fetch",
    "URLSearchParams",
    "TextDecoder",
    "marked",
    "DOMPurify",
    "alert",
    "setInterval",
    "clearInterval",
    script,
  );
  run(
    fakeDocument,
    fakeLocation,
    fakeSessionStorage,
    fakeFetch,
    URLSearchParams,
    TextDecoder,
    markedStub,
    domPurifyStub,
    fakeAlert,
    // 页面用 setInterval 只是为了刷新计时数字；测试里不真起定时器，避免残留 handle
    () => 0,
    () => undefined,
  );

  const input = el("question");
  const runBtn = el("run-btn");

  return {
    stage: el("stage"),
    answerBox: el("answer-box"),
    answerPanel: el("answer-panel"),
    metrics: el("metrics"),
    phaseEls: [el("phase-1"), el("phase-2"), el("phase-3"), el("phase-4")],
    runBtn,
    input,
    mdCalls,
    alerts,
    requests,
    async clickRun(question: string) {
      input.value = question;
      runBtn.fire("click");
      await settle();
      if (!opts.holdOpen) {
        // run() 是 async：等它把流读完 + finally 收口
        for (let i = 0; i < 200; i++) await Promise.resolve();
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async release() {
      releaseFn?.();
      releaseFn = null;
      for (let i = 0; i < 200; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}
