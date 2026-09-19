/**
 * /admin 页「🕵️ 访客记录」渲染回归
 *
 * 为什么需要它：这段渲染是**手写的 DOM 字符串拼接**，tsc/类型系统完全管不到，
 * 而真实缺陷恰恰出在这里 —— 例如 `e.region` 为 null 时 `null + ""` 会渲染出字符串
 * "null"（属地还没解析出来时每行都会出现）。下面用假 DOM 跑页面真实脚本，
 * 喂入含 null / self / bot / 空数据等边界的接口响应，对渲染产物做断言。
 *
 * 与 resume-page-harness 同一手法（唯一区别：admin 页不需要供预览脚本复用，故 shim 内联在本文件）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const HTML_PATH = path.resolve(process.cwd(), "src/server/public/admin.html");

const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

class FakeEl {
  textContent = "";
  renderedHtml: string | null = null;
  className = "";
  disabled = false;
  value = "";
  style: Record<string, string> = {};
  checked = false;
  readonly listeners: Record<string, Array<() => void>> = {};

  set innerHTML(v: string) {
    this.renderedHtml = v;
  }
  get innerHTML(): string {
    return this.renderedHtml ?? escapeText(this.textContent);
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
}

/** 与 admin.html 里 id 对应的假 DOM，初始勾选状态与页面 HTML 一致 */
function mountAdminPage(visitsResponse: unknown) {
  const appState = {
    meAdmin: true,
  };
  const inputs: Record<string, boolean> = { fGuest: true, fBots: false, fSelf: true };
  const els = new Map<string, FakeEl>();

  const el = (id: string): FakeEl => {
    let e = els.get(id);
    if (!e) {
      e = new FakeEl();
      if (id in inputs) e.checked = inputs[id];
      els.set(id, e);
    }
    return e;
  };

  const calls: string[] = [];
  const fakeFetch = async (url: string) => {
    calls.push(url);
    const body = url.includes("/api/me")
      ? { username: "admin", isAdmin: appState.meAdmin }
      : url.includes("/api/admin/guest")
        ? { username: "guest" }
        : visitsResponse;
    return { ok: true, status: 200, json: async () => body };
  };

  const script = readFileSync(HTML_PATH, "utf-8").match(/<script>([\s\S]*?)<\/script>/)![1];
  const session = new Map<string, string>([["navigate_token", "test-token"]]);
  const run = new Function(
    "document",
    "location",
    "sessionStorage",
    "fetch",
    "URLSearchParams",
    "setTimeout",
    script,
  );
  run(
    {
      getElementById: el,
      createElement: () => new FakeEl(),
      querySelectorAll: () => [] as unknown[],
    },
    { search: "", pathname: "/admin", href: "", origin: "http://localhost" },
    {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    },
    fakeFetch,
    URLSearchParams,
    () => 0,
  );

  return { el, calls, ready: new Promise((r) => setTimeout(r, 30)) };
}

const VISITS_RESPONSE = {
  enabled: true,
  kind: "guest",
  includeBots: false,
  stats: { events: 5, ips: 3, recent24h: 2, pendingGeo: 1, selfIpsConfigured: true },
  summary: [
    {
      ip: "203.0.113.9", ipPrefix: "203.0.113.0/24", region: "中国·北京市", isp: "联通",
      device: "Chrome 128 · Windows 10/11", referer: "", src: "boss", username: "guest",
      firstTs: "2026-09-19T01:00:00.000Z", lastTs: "2026-09-19T02:00:00.000Z",
      hits: 2, isBot: false, self: false,
    },
    {
      ip: "198.51.100.7", ipPrefix: "198.51.100.0/24", region: "中国·上海市", isp: "",
      device: "Safari 17 · iOS", referer: "", src: "", username: "guest",
      firstTs: "2026-09-19T03:00:00.000Z", lastTs: "2026-09-19T03:00:00.000Z",
      hits: 1, isBot: false, self: true,
    },
  ],
  events: [
    {
      id: 1, ts: "2026-09-19T02:00:00.000Z", kind: "guest", username: "guest", role: "guest",
      ip: "203.0.113.9", ipPrefix: "203.0.113.0/24", region: "中国·北京市", isp: "联通",
      geoSource: "ip-api", device: "Chrome 128 · Windows 10/11", isBot: false,
      referer: "", src: "boss", landing: "/resume",
    },
    {
      // 属地还没解析出来（解析失败 / 在排队）——绝不能渲染成 "null"
      id: 2, ts: "2026-09-19T03:30:00.000Z", kind: "guest", username: "guest", role: "guest",
      ip: "198.51.100.7", ipPrefix: "198.51.100.0/24", region: null, isp: null,
      geoSource: null, device: "curl", isBot: true, referer: null, src: null, landing: null,
    },
  ],
};

describe("/admin 访客记录渲染", () => {
  it("统计行给出独立访客/登录次数/近 24 小时，并提示待补属地", async () => {
    const { el, ready } = mountAdminPage(VISITS_RESPONSE);
    await ready;
    const stats = el("visitStats").innerHTML;
    expect(stats).toContain("独立访客 <b>3</b>");
    expect(stats).toContain("登录 <b>5</b> 次");
    expect(stats).toContain("近 24 小时 <b>2</b> 次");
    expect(stats).toContain("1 个 IP 待补属地");
  });

  it("默认「只看游客」，且把 kind=guest 传给接口", async () => {
    const { el, calls, ready } = mountAdminPage(VISITS_RESPONSE);
    await ready;
    expect(calls.some((u) => u.includes("/api/admin/visits?kind=guest&bots=0"))).toBe(true);
    // 「隐藏我自己」默认勾选且已配 TRAFFIC_SELF_IPS → self 行被过滤，只剩 1 行数据
    const rows = el("visitSummary").innerHTML;
    expect(rows).toContain("203.0.113.9");
    expect(rows).not.toContain("198.51.100.7");
  });

  it("明细表：属地缺失时渲染占位符而不是字符串 null", async () => {
    const { el, ready } = mountAdminPage(VISITS_RESPONSE);
    await ready;
    const events = el("visitEvents").innerHTML;
    expect(events).toContain("中国·北京市");
    expect(events).not.toContain("null");
    expect(events).not.toContain("undefined");
    // 无属地的行给「—」，脚本 UA 额外标注
    expect(events).toContain('class="dim">—</span>');
    expect(events).toContain("(脚本)");
  });

  it("未装配（enabled=false）时不显示表格，给出原因", async () => {
    const { el, ready } = mountAdminPage({ enabled: false, reason: "访客记录未装配（需要 PostgreSQL 连接池）" });
    await ready;
    expect(el("visitStats").textContent).toContain("未装配");
    expect(el("visitSummary").innerHTML).toContain("未装配");
  });

  it("无记录时给出空态文案", async () => {
    const { el, ready } = mountAdminPage({
      ...VISITS_RESPONSE,
      stats: { events: 0, ips: 0, recent24h: 0, pendingGeo: 0, selfIpsConfigured: false },
      summary: [],
      events: [],
    });
    await ready;
    expect(el("visitSummary").innerHTML).toContain("还没有访客记录");
    expect(el("visitEvents").innerHTML).toContain("暂无明细");
    // 没配 TRAFFIC_SELF_IPS → 隐藏「隐藏我自己」开关（否则给了个永远无效的选项）
    expect(el("selfWrap").style.display).toBe("none");
  });
});
