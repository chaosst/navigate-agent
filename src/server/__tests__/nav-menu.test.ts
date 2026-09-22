/**
 * 一级导航条「✨ 能力演示 ▾」折叠菜单的回归锁
 *
 * 为什么需要它：导航是 **8 个 HTML 文件各自内联的同一份结构**（没有模板引擎），
 * 任何一次改导航都等于手改 8 处 —— 漏一处、顺序写歪一处、把菜单项又平铺回一级，
 * tsc 一个字都不会说。这套断言把「8 份不许漂移」钉成可重复执行的检查。
 *
 * 分两层：
 *  · 结构层 —— 直接读 public/*.html 的文本，锁菜单项集合/顺序/唯一性/资源挂载；
 *  · 行为层 —— 用假 DOM 真跑 nav.js（点空白收起、Esc 收起、guest 隐藏 admin 入口）。
 *    这条自定义逻辑有个容易踩的时序：点击 <summary> 时原生 toggle 是 click 的默认动作，
 *    发生在事件派发之后，所以监听器里读到的是**旧的** open —— 一旦写成手动 toggle，
 *    就会出现「点一下菜单闪一下又关上」。用假 DOM 把它锁住。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const PUBLIC_DIR = path.resolve(process.cwd(), "src/server/public");

/** 折叠菜单里的四项，顺序在所有页面统一 */
const MENU_ORDER = ["/resume/chat", "/resume/jd", "/rag/ask", "/agent/plan"];
/** 唯一一项「仅管理员可见」的入口（ADMIN_ROLES 门禁页面，不留必然 403 的死链） */
const ADMIN_ONLY_HREF = "/agent/plan";
const SUMMARY_TEXT = "✨ 能力演示 ▾";

const read = (f: string): string => readFileSync(path.join(PUBLIC_DIR, f), "utf8");

const navPages = readdirSync(PUBLIC_DIR).filter(
  (f) => f.endsWith(".html") && read(f).includes('class="nav-bar"'),
);

/** 从 nav-bar 起按 <div>/</div> 配对取整块 —— 菜单里还嵌着一层 div，不能取第一个 </div> */
function navBlock(html: string): string {
  const start = html.indexOf('<div class="nav-bar"');
  if (start < 0) throw new Error("找不到 nav-bar");
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0] === "</div>") {
      depth--;
      if (depth === 0) return html.slice(start, m.index + "</div>".length);
    } else depth++;
  }
  throw new Error("nav-bar 的 div 没配对");
}

/** 菜单块（<details class="nav-menu"> … </details>） */
function menuBlock(html: string): string {
  const nav = navBlock(html);
  const s = nav.indexOf('<details class="nav-menu">');
  if (s < 0) throw new Error("导航里没有折叠菜单");
  const e = nav.indexOf("</details>", s);
  if (e < 0) throw new Error("折叠菜单没闭合");
  return nav.slice(s, e + "</details>".length);
}

/** 菜单项 href，按出现顺序 */
function menuHrefs(html: string): string[] {
  return [...menuBlock(html).matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
}

describe("一级导航条 · 折叠菜单结构（8 个页面）", () => {
  it("导航页面清单稳定 —— 新增页面必须一并接入折叠菜单", () => {
    expect([...navPages].sort()).toEqual(
      [
        "admin.html",
        "agent-plan.html",
        "index.html",
        "portfolio.html",
        "rag-ask.html",
        "resume-chat.html",
        "resume-jd.html",
        "resume.html",
      ].sort(),
    );
  });

  it.each(navPages)("%s 挂载了共享的 nav.css / nav.js", (file) => {
    const html = read(file);
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('<link rel="stylesheet" href="/nav.css">');
    expect(head).toContain('<script src="/nav.js" defer></script>');
  });

  it.each(navPages)("%s 正好一个折叠菜单，按钮文案统一", (file) => {
    const html = read(file);
    const nav = navBlock(html); // 只在导航块内数：admin 页面体里另有一个 <details><summary>明细…</summary>
    expect([...nav.matchAll(/<details class="nav-menu">/g)]).toHaveLength(1);
    expect([...nav.matchAll(/<summary>/g)]).toHaveLength(1);
    expect(menuBlock(html)).toContain(`<summary>${SUMMARY_TEXT}</summary>`);
  });

  it.each(navPages)("%s 菜单项 = 四项且顺序全站一致", (file) => {
    expect(menuHrefs(read(file))).toEqual(MENU_ORDER);
  });

  it.each(navPages)("%s 四个入口都只出现一次，且都在折叠菜单里（没有平铺回一级）", (file) => {
    const html = read(file);
    const menu = menuBlock(html);
    for (const href of MENU_ORDER) {
      const all = [...html.matchAll(new RegExp(`<a href="${href.replace(/\//g, "\\/")}"`, "g"))];
      expect(all, `${href} 出现次数`).toHaveLength(1);
      expect(menu, `${href} 应在折叠菜单内`).toContain(`<a href="${href}"`);
    }
  });

  it.each(navPages)("%s 编排视图是 data-admin-only（guest 由 nav.js 摘掉）", (file) => {
    const link = menuBlock(read(file))
      .split("\n")
      .find((l) => l.includes(`href="${ADMIN_ONLY_HREF}"`))!;
    expect(link, "编排视图这一项缺少 data-admin-only").toContain("data-admin-only");
  });

  it("8 份菜单结构不许漂移（去掉各页的 active 标记后应逐字相同）", () => {
    const normalized = navPages.map((f) =>
      menuBlock(read(f)).replace(/ class="active"/g, "").replace(/\s+/g, " ").trim(),
    );
    for (let i = 1; i < normalized.length; i++) {
      expect(normalized[i], `${navPages[i]} 的菜单与 ${navPages[0]} 不一致`).toBe(normalized[0]);
    }
  });

  it("菜单里的当前页标记与页面自身路由一致", () => {
    const cases: Array<[string, string]> = [
      ["resume-chat.html", "/resume/chat"],
      ["resume-jd.html", "/resume/jd"],
      ["rag-ask.html", "/rag/ask"],
      ["agent-plan.html", "/agent/plan"],
    ];
    for (const [file, href] of cases) {
      const line = read(file)
        .split("\n")
        .find((l) => l.includes(`href="${href}"`))!;
      expect(line, `${file} 应在菜单里把自己标成 active`).toContain('class="active"');
    }
  });

  it("portfolio 把「编排视图」放在功能卡片最前面（在长图卡之前）", () => {
    const html = read("portfolio.html");
    const plan = html.indexOf("编排视图（Plan 模式可视化）");
    // 用带 class= 的形式定位元素 —— 裸 "poster-wrap" 会先命中 <style> 里的 .poster-wrap 选择器
    const poster = html.indexOf('class="poster-wrap"');
    expect(plan).toBeGreaterThan(-1);
    expect(plan).toBeLessThan(poster);
  });
});

// ─────────────────────────── nav.js 行为（假 DOM 真跑脚本） ───────────────────────────

class FakeEl {
  tag: string;
  classes: string[];
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  open = false;
  dataAdminOnly = false;
  /** 被 el.remove() 摘掉（nav.js 用它隐藏 guest 不该看到的入口） */
  removed = false;

  constructor(tag: string, classes: string[] = []) {
    this.tag = tag;
    this.classes = classes;
  }
  append(child: FakeEl): FakeEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  closest(sel: string): FakeEl | null {
    let cur: FakeEl | null = this;
    while (cur) {
      if (matchesSel(cur, sel)) return cur;
      cur = cur.parent;
    }
    return null;
  }
  remove(): void {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
}

/** 只实现 nav.js 用到的三个选择器 —— 一旦它改用别的选择器，这里直接抛错而不是静默放过 */
function matchesSel(el: FakeEl, sel: string): boolean {
  if (sel === "details.nav-menu[open]") {
    return el.tag === "details" && el.classes.includes("nav-menu") && el.open;
  }
  if (sel === "details.nav-menu") return el.tag === "details" && el.classes.includes("nav-menu");
  if (sel === "[data-admin-only]") return el.dataAdminOnly;
  throw new Error(`假 DOM 未实现的选择器：${sel}`);
}

function walk(el: FakeEl, out: FakeEl[] = []): FakeEl[] {
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}

function makeDoc(root: FakeEl) {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  return {
    listeners,
    querySelectorAll(sel: string) {
      return walk(root).filter((el) => matchesSel(el, sel));
    },
    addEventListener(type: string, fn: (e: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    fire(type: string, ev: unknown) {
      (listeners[type] ?? []).forEach((fn) => fn(ev));
    },
  };
}

type MeResult = { isAdmin: boolean } | "network-fail";

function runNavJs(opts: { search?: string; me?: MeResult; session?: Map<string, string> }) {
  const body = new FakeEl("body");
  const menu = body.append(new FakeEl("details", ["nav-menu"]));
  const summary = menu.append(new FakeEl("summary"));
  const outside = body.append(new FakeEl("a", []));
  const adminOnly = body.append(new FakeEl("a", []));
  adminOnly.dataAdminOnly = true;

  const doc = makeDoc(body);
  const session = opts.session ?? new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
  };
  const calls: string[] = [];
  const fetchStub = (url: string) => {
    calls.push(url);
    if (opts.me === "network-fail") return Promise.reject(new Error("offline"));
    return Promise.resolve({ json: async () => opts.me ?? { isAdmin: false } });
  };

  const src = read("nav.js");
  new Function("document", "location", "sessionStorage", "fetch", src)(
    doc,
    { search: opts.search ?? "" },
    sessionStorage,
    fetchStub,
  );

  return { doc, menu, summary, outside, adminOnly, session, calls };
}

/** 让 fetch 的 then 链跑完 */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("nav.js 行为（假 DOM 真跑脚本）", () => {
  it("点菜单以外的地方 → 已展开的菜单收起", () => {
    const p = runNavJs({});
    p.menu.open = true;
    p.doc.fire("click", { target: p.outside });
    expect(p.menu.open).toBe(false);
  });

  it("点在 summary 上时不动它的 open —— 交给 <details> 原生 toggle，避免一次点击翻转两次", () => {
    const p = runNavJs({});
    p.menu.open = false;
    p.doc.fire("click", { target: p.summary });
    expect(p.menu.open).toBe(false); // 若这里被改成手动 toggle，菜单会「闪一下就关上」
  });

  it("Esc 收起全部菜单", () => {
    const p = runNavJs({});
    p.menu.open = true;
    p.doc.fire("keydown", { key: "Escape" });
    expect(p.menu.open).toBe(false);
  });

  /** 已登录页面上 token 必然存在（无 token 的页面早被 requirePage 302 走了） */
  const loggedIn = () => new Map([["navigate_token", "tk-test"]]);

  it("体验账号（isAdmin:false）→ data-admin-only 入口被摘掉", async () => {
    const p = runNavJs({ me: { isAdmin: false }, session: loggedIn() });
    await flush();
    expect(p.calls).toHaveLength(1);
    expect(p.adminOnly.removed).toBe(true);
  });

  it("管理员（isAdmin:true）→ 入口保留", async () => {
    const p = runNavJs({ me: { isAdmin: true }, session: loggedIn() });
    await flush();
    expect(p.adminOnly.removed).toBe(false);
  });

  it("/api/me 请求失败 → 保留入口（fail-open，服务端 403 兜底）", async () => {
    const p = runNavJs({ me: "network-fail", session: loggedIn() });
    await flush();
    expect(p.adminOnly.removed).toBe(false);
  });

  it("URL 上的 ?token= 落到 sessionStorage —— 从 TUI 复制的链接不会丢身份", () => {
    const p = runNavJs({ search: "?token=tk-123" });
    expect(p.session.get("navigate_token")).toBe("tk-123");
  });

  it("没有 token 时不发 /api/me 请求（交给 requirePage 的 302）", () => {
    const p = runNavJs({ me: { isAdmin: true } });
    expect(p.calls).toHaveLength(0);
  });
});
