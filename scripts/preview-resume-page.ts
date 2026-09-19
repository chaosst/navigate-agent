/**
 * 简历页静态预览 —— 不用起服务、不用 Postgres，直接把 /resume 渲染结果落成一张
 * 可双击打开的 HTML（复用 resume.html 里那段真实脚本 + 一个最小 DOM shim）。
 *
 * 存在的理由：
 *   ① 线上简历页的改动要等部署才看得见，本地起服务又要 Postgres + embedding Key；
 *   ② 「解析层数据是对的」不等于「页面渲染是对的」——resume-render.test.ts 的注释里
 *      已记录过一次「分节有标题没正文」的静默缺陷，只有真跑一遍渲染才暴露。
 *
 * 用法：npm run resume:preview [输出路径]
 *      默认输出 rag_data/resume-page-preview.html（gitignored）
 *
 * 数据源与站点一致：resume.md（优先）→ resume.docx（mammoth 转换）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadResumeSource } from "../src/resume/loader.js";
import { parseResumeText } from "../src/resume/parser.js";
import { mountResumePage } from "../src/server/__tests__/resume-page-harness.js";

const HTML_PATH = path.resolve(process.cwd(), "src/server/public/resume.html");
const OUT = path.resolve(process.argv[2] ?? "rag_data/resume-page-preview.html");

/** 页面必备分节 —— 渲染后缺任何一个都视为失败（避免「改了就少了半页」静默通过） */
const EXPECTED = ["教育背景", "核心亮点", "专业技能", "项目", "工作经历"];

const src = await loadResumeSource();
if (!src) {
  console.error("✗ 未找到简历源文件（resume.md / resume.docx 都不存在）");
  process.exit(1);
}
const data = parseResumeText(src.text);
console.log(`数据源：${src.sourcePath}（${src.format}）`);
console.log(`姓名/职位：${data.name || "—"} / ${data.title || "—"}`);
console.log(`分节 ${data.sections.length} 个：`);
for (const s of data.sections) {
  console.log(`  [${s.type.padEnd(10)}] ${s.title}（${s.items.length} 条）`);
}

// ——— 用页面真实脚本渲染（fake DOM shim 与 resume-render.test.ts 共用一份：
//     页面脚本新增 DOM 调用时必须只在这一处补，否则两边会静默漂移） ———
const pageHtml = readFileSync(HTML_PATH, "utf-8");
const { app } = await mountResumePage(pageHtml, data as unknown);
const rendered = app.renderedHtml ?? "";
if (!rendered) throw new Error("渲染结果为空 —— 页面脚本没有产出 #app 内容");

const missing = EXPECTED.filter((n) => !rendered.includes(n));
if (missing.length) {
  throw new Error(`渲染结果缺少分节：${missing.join("、")}（页面脚本或数据契约可能已变）`);
}

// ——— 固化成静态页：去掉取数脚本，把已渲染好的 HTML 注入 #app ———
const preview = pageHtml
  .replace(/__WIKI_URL__/g, "#")
  .replace(/<script>[\s\S]*?<\/script>/, "")
  .replace(/(<div id="app">)[\s\S]*?(<\/div>\s*<div class="footer">)/, `$1${rendered}$2`)
  .replace(/(<span id="footer-info"><\/span>)/, `<span id="footer-info">静态预览（数据源 ${src.sourcePath}）</span>`);

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, preview, "utf8");
console.log(`\n✓ 预览已生成：${OUT}（${preview.length} 字符）`);
