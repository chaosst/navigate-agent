/**
 * zyplayer-doc 品牌名 + 主题色 + 轻度布局注入（wiki 代理注入，方案 A）
 *
 * 通过 wiki 鉴权反向代理（3003 → zyplayer-doc 8083）在 HTML 响应里注入：
 *   1) <style>：覆盖 Element Plus（变量级）+ Ant Design Vue（cssinjs 编译后的颜色）
 *      与少量布局微调，把 zyplayer-doc 界面统一为 Navigate Wiki 主题（#519670 柔绿）。
 *      改动的都是品牌色 / 阴影 / 字距 / 卡片圆角等「表层视觉」属性，DOM 结构与
 *      zyplayer-doc 原生保持一致，框架布局 / 功能行为不受影响。
 *   2) <script>：把品牌名统一替换为 "Navigate Wiki"（系统名、公司名、登录标题、
 *      document.title、Powered by 前缀、meta keywords）。
 *
 * 不修改 zyplayer-doc 容器 / JAR / MySQL；代码版本化、可单测、可回滚（enabled:false
 * 或不传 htmlInject 时退化为纯透传）。仅对从代理入口（3003）访问的页面生效。
 */

/** 默认品牌名（"Navigate Wiki"） */
export const DEFAULT_BRAND = "Navigate Wiki";

/** 默认主题色（柔绿，与 Navigate logo / 品牌色一致） */
export const DEFAULT_THEME = "#519670";

export interface WikiInjectOptions {
  /** 是否启用注入，默认 true */
  enabled?: boolean;
  /** 品牌名，默认 "Navigate Wiki" */
  brand?: string;
  /** 主题色（hex），默认 "#519670" */
  theme?: string;
}

/** 品牌替换脚本模板：__BRAND_JSON__ 为占位符 */
const SCRIPT_TEMPLATE = [
"(function () {",
"  var brand = __BRAND_JSON__;",
"  var BRAND_SUFFIX = \" | \" + brand;",
"  // 基础标题（不含页面名）整体替换",
"  var TITLE_BASE_RE = /zyplayer|文档管理系统|^知识库$|^工作台$|^Home$|^Wiki Knowledge Base$/i;",
"  // 叶子文本品牌关键词",
"  var LEAF_RE = /zyplayer|文档管理系统/i;",
"",
"  function apply() {",
"    // 1) 类名精确定位：系统名 / 公司名 / 登录标题",
"    var branded = document.querySelectorAll(\".system-name, .company-name, .login-title\");",
"    for (var i = 0; i < branded.length; i++) branded[i].textContent = brand;",
"",
"    // 2) document.title：基础标题→品牌名；文档页标题→\"页面名 | Navigate Wiki\"",
"    var title = document.title || \"\";",
"    if (title && title.indexOf(brand) === -1) {",
"      if (TITLE_BASE_RE.test(title)) {",
"        document.title = brand;",
"      } else if (title.length > 6) {",
"        document.title = title + BRAND_SUFFIX;",
"      }",
"    }",
"",
"    // 3) 叶子文本：含品牌关键词的短文本整体替换；Powered by 前缀保留",
"    var els = document.querySelectorAll(\"body *\");",
"    for (var j = 0; j < els.length; j++) {",
"      var el = els[j];",
"      if (el.children && el.children.length > 0) continue;",
"      var t = (el.textContent || \"\").trim();",
"      if (!t || t.length > 60) continue;",
"      if (/^Powered by /i.test(t) && /zyplayer/i.test(t)) {",
"        el.textContent = t.replace(/zyplayer[^ ]*/gi, brand);",
"      } else if (LEAF_RE.test(t)) {",
"        el.textContent = brand;",
"      }",
"    }",
"",
"    // 4) meta keywords 里的 zyplayer → navigate",
"    var meta = document.querySelector('meta[name=\"keywords\"]');",
"    if (meta && /zyplayer/i.test(meta.getAttribute(\"content\") || \"\")) {",
"      meta.setAttribute(\"content\", (meta.getAttribute(\"content\") || \"\").replace(/zyplayer[^,]*/gi, \"navigate\"));",
"    }",
"  }",
"  // 首次应用",
"  apply();",
"  // SPA 路由切换 / 异步渲染后再次应用：observer 防抖 + apply 节流。",
"  // 直接对 DOM 改文本会触发 Vue 重渲染，若在 observer 回调里立即 apply，",
"  // 会与 Vue 的 patch 互相触发导致主线程繁忙（页面卡死、截图挂起）。",
"  // mutation 只调度一次延迟执行，并保证 apply 最短间隔 1.5s。",
"  var applyPending = false;",
"  var lastApplyAt = 0;",
"  function scheduleApply() {",
"    if (applyPending) return;",
"    applyPending = true;",
"    setTimeout(function () {",
"      applyPending = false;",
"      var now = Date.now();",
"      if (now - lastApplyAt < 1500) { scheduleApply(); return; }",
"      lastApplyAt = now;",
"      apply();",
"    }, 120);",
"  }",
"  if (window.MutationObserver) {",
"    var mo = new MutationObserver(scheduleApply);",
"    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });",
"  }",
"  // 低频定时兜底",
"  setInterval(function () { lastApplyAt = 0; apply(); }, 5000);",
"})();",
].join("\n");

/**
 * hex 颜色 → "R, G, B"。仅做最简校验，长度 / 字符正确才解析；失败返回 undefined。
 * 用于生成 --el-color-primary-rgb 等 CSS 变量（Element Plus 半透明色阶依赖 rgb 通道）。
 */
function hexToRgb(hex: string): string | undefined {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(", ");
}

/**
 * 颜色混合（hex a 与 hex b 之间按 alpha 比例线性插值，alpha=0 返回 a，=1 返回 b）。
 * 仅用于生成主题色阶（lighter / darker / lightest），不做透明度叠加；不处理 alpha 通道。
 */
function mixHex(a: string, b: string, alpha: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  if (pa === undefined || pb === undefined) return a;
  const ar = pa.split(",").map(Number);
  const br = pb.split(",").map(Number);
  const r = Math.round(ar[0] * (1 - alpha) + br[0] * alpha);
  const g = Math.round(ar[1] * (1 - alpha) + br[1] * alpha);
  const bl = Math.round(ar[2] * (1 - alpha) + br[2] * alpha);
  return "#" + [r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("");
}

/**
 * 构建注入用 <style> 内容：Navigate Wiki 主题色（默认 #519670）+ 布局微调。
 * 设计原则：
 *   - 改动仅限品牌色 / 阴影 / 字距 / 卡片圆角 / 滚动条 等「表层视觉」属性，
 *     不动 DOM 结构、布局尺寸、组件交互，保留 zyplayer-doc 原生框架布局。
 *   - Element Plus 通过 CSS 变量一次覆盖（--el-color-primary + rgb 通道 + 浅深色阶），
 *     所有 el 组件自动换肤。
 *   - Ant Design Vue（cssinjs 编译产物）用具体类 + !important 直接覆盖渲染颜色，
 *     cssinjs 把 #1677ff 写死在 [class*="css-"] 类里，变量覆盖无效。
 *   - 主题色通过 --navigate-brand 等内部变量集中管理，CSS 集中维护。
 */
export function buildInjectCss(theme: string = DEFAULT_THEME): string {
  const rgb = hexToRgb(theme) ?? "81, 150, 112";
  // 浅 / 深色阶：明度线性插值（仅视觉估算，覆盖外观色感即可）
  const lighter = mixHex(theme, "#ffffff", 0.45);   // hover bg
  const lightest = mixHex(theme, "#ffffff", 0.85);  // 选中态背景
  const darker = mixHex(theme, "#000000", 0.15);    // hover fg / pressed

  return [
"/* === Navigate Wiki 主题注入（仅代理入口 3003 生效）===",
"   主题色：" + theme + "（可通过 wiki-inject buildInjectCss(theme) 覆盖） */",

"/* --- 0) 内部变量集中管理 --- */",
":root {",
"  --navigate-brand: " + theme + ";",
"  --navigate-brand-rgb: " + rgb + ";",
"  --navigate-brand-lighter: " + lighter + ";",
"  --navigate-brand-lightest: " + lightest + ";",
"  --navigate-brand-darker: " + darker + ";",
"}",

"/* --- 1) Element Plus：CSS 变量全局换肤（编辑器 / 表单组件） --- */",
":root {",
"  --el-color-primary: " + theme + ";",
"  --el-color-primary-rgb: " + rgb + ";",
"  --el-color-primary-light-3: " + mixHex(theme, "#ffffff", 0.3) + ";",
"  --el-color-primary-light-5: " + mixHex(theme, "#ffffff", 0.5) + ";",
"  --el-color-primary-light-7: " + mixHex(theme, "#ffffff", 0.7) + ";",
"  --el-color-primary-light-8: " + mixHex(theme, "#ffffff", 0.8) + ";",
"  --el-color-primary-light-9: " + mixHex(theme, "#ffffff", 0.9) + ";",
"  --el-color-primary-dark-2: " + darker + ";",
"}",

"/* --- 2) 顶部 header：横向柔绿渐变 + 字距优化 --- */",
".wiki-container-header,",
".wiki-container-header.ant-layout-header {",
"  background: linear-gradient(90deg, " + theme + " 0%, " + lighter + " 100%) !important;",
"  border-bottom: 1px solid rgba(0, 0, 0, 0.06);",
"  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);",
"}",
".wiki-container-header .system-name,",
".wiki-container-header .company-name {",
"  color: #ffffff !important;",
"  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);",
"  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif;",
"}",
".wiki-container-header .system-name {",
"  font-weight: 600 !important;",
"  letter-spacing: 0.5px;",
"  font-size: 22px !important;",
"}",
".wiki-container-header .company-name {",
"  font-weight: 400 !important;",
"  letter-spacing: 0.3px;",
"  opacity: 0.88;",
"  margin-left: 10px;",
"  font-size: 14px !important;",
"}",

"/* --- 3) 左侧菜单选中态 / hover（antd menu） --- */",
".ant-menu-light .ant-menu-item-selected {",
"  background-color: var(--navigate-brand-lightest) !important;",
"  color: var(--navigate-brand) !important;",
"}",
".ant-menu-light .ant-menu-item:hover:not(.ant-menu-item-selected) {",
"  color: var(--navigate-brand) !important;",
"}",
".ant-menu-light .ant-menu-submenu-selected > .ant-menu-submenu-title,",
".ant-menu-light .ant-menu-submenu-title:hover {",
"  color: var(--navigate-brand) !important;",
"}",

"/* --- 4) Tabs 下划线 + 选中色 --- */",
".ant-tabs-ink-bar { background: var(--navigate-brand) !important; }",
".ant-tabs-tab.ant-tabs-tab-active .ant-tabs-tab-btn { color: var(--navigate-brand) !important; }",
".ant-tabs-tab:hover .ant-tabs-tab-btn { color: var(--navigate-brand) !important; }",

"/* --- 5) 主按钮：ant-btn-primary + el-button--primary 双覆盖 --- */",
".ant-btn-primary {",
"  background-color: var(--navigate-brand) !important;",
"  border-color: var(--navigate-brand) !important;",
"  text-shadow: none;",
"}",
".ant-btn-primary:not(:disabled):hover {",
"  background-color: var(--navigate-brand-darker) !important;",
"  border-color: var(--navigate-brand-darker) !important;",
"}",
".ant-btn-primary:not(:disabled):active {",
"  background-color: var(--navigate-brand-darker) !important;",
"  border-color: var(--navigate-brand-darker) !important;",
"}",
".el-button--primary {",
"  --el-button-bg-color: var(--navigate-brand);",
"  --el-button-border-color: var(--navigate-brand);",
"  --el-button-hover-bg-color: var(--navigate-brand-darker);",
"  --el-button-hover-border-color: var(--navigate-brand-darker);",
"  --el-button-active-bg-color: var(--navigate-brand-darker);",
"  --el-button-active-border-color: var(--navigate-brand-darker);",
"}",

"/* --- 6) 链接 / 高亮色（markdown / 编辑器 / 普通 a） --- */",
".wiki-container a:not(.ant-btn):not(.ant-menu-title-content) {",
"  color: var(--navigate-brand);",
"  text-decoration-color: rgba(var(--navigate-brand-rgb), 0.35);",
"}",
".wiki-container a:not(.ant-btn):not(.ant-menu-title-content):hover {",
"  color: var(--navigate-brand-darker);",
"}",
".markdown-body a, .ProseMirror a, .prose a {",
"  color: var(--navigate-brand) !important;",
"  text-decoration: underline;",
"  text-decoration-color: rgba(var(--navigate-brand-rgb), 0.3);",
"}",

"/* --- 7) 登录页：绿系柔和渐变 + 玻璃感卡片 --- */",
"/* 不写死 linear-gradient-N 后缀（zyplayer-doc 不同小版本会用 -1/-2/-3），用属性选择器 */",
".login-page-view.login-background[class*=\"linear-gradient\"] {",
"  background:",
"    radial-gradient(at 18% 28%, rgba(var(--navigate-brand-rgb), 0.28), transparent 60%),",
"    radial-gradient(at 82% 72%, rgba(var(--navigate-brand-rgb), 0.22), transparent 65%),",
"    linear-gradient(135deg, " + lightest + " 0%, #f4f9f6 50%, " + mixHex(theme, "#ffffff", 0.7) + " 100%) !important;",
"}",
".login-page-view .login-content {",
"  background: rgba(255, 255, 255, 0.88) !important;",
"  backdrop-filter: blur(14px);",
"  -webkit-backdrop-filter: blur(14px);",
"  border-radius: 14px !important;",
"  box-shadow: 0 14px 44px rgba(var(--navigate-brand-rgb), 0.18), 0 2px 6px rgba(0, 0, 0, 0.04) !important;",
"  padding: 40px 36px 32px !important;",
"  border: 1px solid rgba(var(--navigate-brand-rgb), 0.08);",
"}",
".login-page-view .login-title {",
"  color: #2c4a3a !important;",
"  font-weight: 600 !important;",
"  font-size: 22px !important;",
"  margin: 0 auto 36px !important;",
"}",
".login-page-view .login-footer {",
"  color: #6c8074 !important;",
"  font-size: 13px !important;",
"}",

"/* --- 8) 输入框焦点：绿色高亮 --- */",
".ant-input:focus, .ant-input-affix-wrapper:focus, .ant-input-affix-wrapper-focused,",
".ant-input-focused {",
"  border-color: var(--navigate-brand) !important;",
"  box-shadow: 0 0 0 2px rgba(var(--navigate-brand-rgb), 0.12) !important;",
"}",

"/* --- 9) 空间卡片：hover 浮起 + 绿阴影 --- */",
".wiki-space-card {",
"  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;",
"  border: 1px solid #e8eaed;",
"}",
".wiki-space-card:hover {",
"  transform: translateY(-3px);",
"  border-color: var(--navigate-brand-lighter) !important;",
"  box-shadow: 0 12px 28px rgba(var(--navigate-brand-rgb), 0.16) !important;",
"}",

"/* --- 10) 滚动条：绿色低调 --- */",
"::-webkit-scrollbar { width: 10px; height: 10px; }",
"::-webkit-scrollbar-thumb { background: " + mixHex(theme, "#ffffff", 0.7) + "; border-radius: 5px; }",
"::-webkit-scrollbar-thumb:hover { background: var(--navigate-brand-lighter); }",
"::-webkit-scrollbar-track { background: transparent; }",

"/* --- 11) 整体圆角 / 字距微调（轻度改造） --- */",
".ant-btn { border-radius: 6px; }",
".ant-input, .ant-input-affix-wrapper { border-radius: 6px; }",
".ant-modal-content, .ant-card { border-radius: 10px; }",
".wiki-container-header { letter-spacing: 0.2px; }",

"/* --- 12) Powered-by 与元数据柔和化 --- */",
".login-page-view .login-footer a,",
".login-page-view .login-footer { color: #6c8074 !important; }",

].join("\n");
}

/**
 * 构建注入用 <script> 内容：品牌名替换。
 * zyplayer-doc 是 SPA（Vue 动态渲染），MutationObserver 防抖 + 定时兜底
 * 防止标题/Logo 文字被框架重渲染覆盖；< > 做 unicode 转义防 XSS。
 */
export function buildInjectScript(brand: string): string {
  // 先 JSON.stringify 得到带引号的安全字符串，再把 < > 换成 \u003c / \u003e，
  // 保证嵌入 <script> 后浏览器解析出原始字符而不会误解 HTML。
  const json = JSON.stringify(brand)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return SCRIPT_TEMPLATE.replace("__BRAND_JSON__", json);
}

/**
 * 在 HTML 字符串中注入 <style>（head 末尾）+ <script>（body 末尾）。
 * enabled:false 时原样返回，缺失 head/body 时做兼容降级（追加）。
 */
export function injectHtml(html: string, opts: WikiInjectOptions = {}): string {
  if (opts.enabled === false) return html;
  const brand = opts.brand || DEFAULT_BRAND;
  const theme = opts.theme || DEFAULT_THEME;

  const css = buildInjectCss(theme);
  // 对 < > 做 unicode 转义，防止嵌入 <style> 后被 HTML 解析器提前闭合（CSS 一般不含
  // < >，但用户的 theme 字符串理论上可能含，万一解析错会让后续样式丢失）。
  const safeCss = css.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const styleTag = "<style data-navigate-doc-inject>\n" + safeCss + "\n</style>";

  const scriptTag = "<script data-navigate-doc-inject>\n" + buildInjectScript(brand) + "\n</script>";

  let out = html;
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, styleTag + "</head>");
  } else {
    out = styleTag + out;
  }
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, scriptTag + "</body>");
  } else {
    out = out + scriptTag;
  }
  return out;
}