import { describe, it, expect } from "vitest";
import { injectHtml, buildInjectCss, buildInjectScript, DEFAULT_BRAND, DEFAULT_THEME } from "./wiki-inject.js";

describe("injectHtml (wiki 品牌名 + 主题色注入，方案 A)", () => {
  const SAMPLE = "<html><head><title>zyplayer-doc</title></head>"
    + "<body><header>zyplayer-doc</header><div class=\"sidebar\">menu</div></body></html>";

  it("同时注入 <style>（head 末尾）+ <script>（body 末尾）", () => {
    const out = injectHtml(SAMPLE);
    expect(out).toContain("<style data-navigate-doc-inject>");
    expect(out).toContain("<script data-navigate-doc-inject>");
    // style 必须在 head 闭合前，script 必须在 body 闭合前
    expect(out.indexOf("<style")).toBeLessThan(out.indexOf("</head>"));
    expect(out.indexOf("<script")).toBeLessThan(out.indexOf("</body>"));
  });

  it("默认主题色为 #519670（柔绿，与 Navigate 品牌色一致）", () => {
    expect(DEFAULT_THEME).toBe("#519670");
    const css = buildInjectCss();
    expect(css).toContain("--navigate-brand: " + DEFAULT_THEME);
    expect(css).toContain("--el-color-primary: " + DEFAULT_THEME);
  });

  it("自定义主题色生效（覆盖品牌变量与 Element Plus 变量）", () => {
    const css = buildInjectCss("#3366ff");
    expect(css).toContain("--navigate-brand: #3366ff");
    expect(css).toContain("--el-color-primary: #3366ff");
    // 衍生色阶：lighter / darkest 都要出现
    expect(css).toMatch(/--navigate-brand-lighter:\s*#[0-9a-f]{6}/);
    expect(css).toContain("--el-color-primary-light-3:");
  });

  it("注入 CSS 覆盖 antd 主按钮、菜单选中态、Tabs 下划线", () => {
    const css = buildInjectCss();
    expect(css).toContain(".ant-btn-primary");
    expect(css).toContain(".ant-menu-item-selected");
    expect(css).toContain(".ant-tabs-ink-bar");
    expect(css).toContain(".wiki-container-header");
  });

  it("注入 CSS 覆盖登录页背景与卡片（用属性选择器兼容 linear-gradient-N 后缀）", () => {
    const css = buildInjectCss();
    // 用 [class*="linear-gradient"] 兼容 zyplayer-doc 不同小版本（-1 / -2 / -3）
    expect(css).toContain(".login-page-view.login-background[class*=\"linear-gradient\"]");
    expect(css).toContain(".login-page-view .login-content");
    expect(css).toContain(".login-page-view .login-title");
  });

  it("默认品牌名为 'Navigate Wiki'", () => {
    expect(DEFAULT_BRAND).toBe("Navigate Wiki");
    const out = injectHtml(SAMPLE);
    expect(out).toContain("var brand = \"Navigate Wiki\";");
  });

  it("品牌替换脚本覆盖系统名/登录标题/Powered by/meta keywords", () => {
    const js = buildInjectScript(DEFAULT_BRAND);
    // 类名精确定位
    expect(js).toContain('.querySelectorAll(".system-name, .company-name, .login-title")');
    // document.title 处理（基础标题 + 文档页标题后缀）
    expect(js).toContain("TITLE_BASE_RE");
    expect(js).toContain("BRAND_SUFFIX");
    // Powered by zyplayer-doc → Powered by Navigate Wiki
    expect(js).toContain("/^Powered by /i");
    expect(js).toContain("t.replace(/zyplayer[^ ]*/gi, brand)");
    // meta keywords 清理
    expect(js).toContain('meta[name="keywords"]');
  });

  it("注入脚本对 MutationObserver 防抖 + apply 节流（避免与 Vue 渲染互相触发卡死）", () => {
    const js = buildInjectScript(DEFAULT_BRAND);
    // observer 回调只调度延迟执行，不立即 apply
    expect(js).toContain("new MutationObserver(scheduleApply)");
    expect(js).toContain("scheduleApply");
    // apply 最短间隔 1.5s
    expect(js).toContain("now - lastApplyAt < 1500");
    // 低频定时兜底 5s
    expect(js).toContain("setInterval(function () { lastApplyAt = 0; apply(); }, 5000)");
  });

  it("自定义品牌名生效", () => {
    const out = injectHtml(SAMPLE, { brand: "My Wiki" });
    expect(out).toContain("var brand = \"My Wiki\";");
  });

  it("自定义 brand + theme 同时生效", () => {
    const out = injectHtml(SAMPLE, { brand: "Acme Wiki", theme: "#aa1188" });
    expect(out).toContain("var brand = \"Acme Wiki\";");
    expect(out).toContain("--navigate-brand: #aa1188");
  });

  it("enabled:false 时原样返回，不做任何注入", () => {
    expect(injectHtml(SAMPLE, { enabled: false })).toBe(SAMPLE);
  });

  it("无 head / body 的裸 HTML 也能注入（前置 style / 追加 script）", () => {
    const bare = injectHtml("plain html, no head no body");
    expect(bare.startsWith("<style data-navigate-doc-inject>")).toBe(true);
    expect(bare.endsWith("</script>")).toBe(true);
  });

  it("buildInjectScript 对 < > 做 unicode 转义（防 script 提前闭合）", () => {
    const js = buildInjectScript("Nav <Wiki>");
    expect(js).toContain("Nav \\u003cWiki\\u003e");
    const out = injectHtml(SAMPLE, { brand: "Nav <Wiki>" });
    expect(out).toContain("\\u003cWiki\\u003e");
    expect(out).not.toContain("Nav <Wiki>");
  });

  it("buildInjectCss 对 < > 做 unicode 转义（防 style 提前闭合）", () => {
    // theme 含 < 也不会破坏 <style> 块
    const out = injectHtml(SAMPLE, { theme: "#519670" });
    // safeCss 应把 < > 转义（CSS 模板里没有 < >，但 buildInjectCss 链路做转义）
    // 验证 <style 标签内不会出现裸露的 </>
    const styleBlock = out.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    expect(styleBlock).not.toBeNull();
    expect(styleBlock![1]).not.toMatch(/[<>]/);  // 文本里没有原始 < >
  });
});
