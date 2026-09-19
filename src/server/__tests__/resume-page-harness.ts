/**
 * `resume.html` 的「假 DOM」执行器 —— 让 Node 里能跑页面那段真实脚本。
 *
 * 为什么需要它：`/resume` 的历史缺陷（分节有标题没正文、下载按钮没有监听器）
 * 在解析层单测里完全看不见 —— 数据是对的、页面是错的。只有跑一遍页面脚本才暴露。
 *
 * 为什么抽成一份：`resume-render.test.ts`（断言渲染产物）与
 * `scripts/preview-resume-page.ts`（生成可双击的静态预览）是同一套手艺。
 * 曾经各持一份 shim，页面脚本一加新 DOM 调用，只更新了其中一份 → 另一份在运行期
 * 抛 `pdfBtn.addEventListener is not a function`。**页面脚本用到的每条 DOM 能力
 * 都必须在这里实现**，两个调用方共享同一契约。
 */

/** 浏览器把文本节点的 innerHTML 序列化为转义后的字符串 */
const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 极简事件对象：页面脚本目前只用到 preventDefault() */
export class FakeEvent {
  defaultPrevented = false;
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

export class FakeEl {
  textContent = "";
  /** 被赋值 innerHTML 时捕获原始 HTML（用于读取 #app 的渲染结果） */
  renderedHtml: string | null = null;
  /** 注册的 click 监听器（如 #downloadPdf；测试可手动触发） */
  clickHandlers: Array<(e: FakeEvent) => void> = [];
  /** 元素内联样式（页面脚本会改 display，如隐藏体验账号的 wiki 入口） */
  style: Record<string, string> = {};

  set innerHTML(v: string) {
    this.renderedHtml = v;
    this.textContent = "";
  }
  get innerHTML(): string {
    return escapeText(this.textContent);
  }
  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    if (type === "click") this.clickHandlers.push(fn);
  }
  getAttribute(): string | null {
    return null;
  }
  setAttribute(): void {
    /* noop */
  }
}

/** 挂载页面脚本后可观察到的副作用出口 */
export interface MountedPage {
  /** #app 的渲染结果 */
  app: FakeEl;
  /** #downloadPdf 按钮元素（click 监听器挂在这里） */
  pdfBtn: FakeEl;
  /** window.print() 被调用的次数（getter：点击发生在挂载之后） */
  readonly printCalls: number;
}

export function extractScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("resume.html 中找不到 <script> 块");
  return m[1];
}

/**
 * 跑一遍页面脚本并放行异步渲染，返回副作用出口。
 * `data` 是 /api/resume 的返回体（/api/me 固定返回 isAdmin: true）。
 */
export async function mountResumePage(html: string, data: unknown): Promise<MountedPage> {
  const script = extractScript(html);

  const app = new FakeEl();
  const pdfBtn = new FakeEl();
  const state = { printCalls: 0 };
  const fakeDocument = {
    getElementById: (id: string) => (id === "app" ? app : id === "downloadPdf" ? pdfBtn : new FakeEl()),
    createElement: () => new FakeEl(),
    querySelectorAll: () => [] as unknown[],
  };
  const session = new Map<string, string>([["navigate_token", "test-token"]]);
  const fakeSessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  };
  const fakeLocation = { search: "", pathname: "/resume", href: "" };
  const fakeFetch = async (url: string) => ({
    json: async () => (url.includes("/api/me") ? { isAdmin: true } : data),
  });
  const fakeWindow = {
    print: () => {
      state.printCalls += 1;
    },
  };

  const run = new Function(
    "document",
    "location",
    "sessionStorage",
    "fetch",
    "URLSearchParams",
    "window",
    script,
  );
  run(fakeDocument, fakeLocation, fakeSessionStorage, fakeFetch, URLSearchParams, fakeWindow);

  // loadResume() 是异步的（fetch → json → render），放行微任务后取渲染结果
  await new Promise((r) => setTimeout(r, 20));
  return {
    app,
    pdfBtn,
    // getter：点击发生在 mountResumePage 返回之后，取值必须延后
    get printCalls() {
      return state.printCalls;
    },
  };
}
