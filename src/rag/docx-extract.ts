/**
 * docx-extract.ts — `.docx` → markdown（RAG 侧的 docx 适配器）
 *
 * **为什么不用 `mammoth.convertToMarkdown`：** 实测它把表格全丢了
 * （`resume.docx` 有 3 张表，markdown 输出里含 `|` 的行数 = 0）。
 * `convertToHtml` 则把 `table`/`ol`/`ul`/`h1-h6` 全部保住，所以走
 * `convertToHtml + styleMap` → **手写 HTML 子集解析器** → markdown。
 *
 * ⚠️ 这不等于支持 `.html` 上传（格式范围锁定 4 种）。这个解析器只为 docx 抽取服务。
 * ⚠️ `<img>` 必须在解析阶段直接丢弃：实测 2 张内嵌证件照把 HTML 从 6.5K 撑到 1.44M（218 倍）。
 */
import { readFileSync } from "node:fs";
import mammoth from "mammoth";
import { promoteChineseHeadings } from "../text-normalize.js";

// mammoth@1.12 自带 d.ts 未收录 convertToHtml（运行时导出存在）。
// resume/loader.ts 有同样的断言写法，照抄。
const mammothConv = mammoth as unknown as {
  convertToHtml: (
    input: { buffer: Buffer },
    options?: Record<string, unknown>,
  ) => Promise<{ value: string; messages: unknown[] }>;
};

/**
 * 让 mammoth 把 Word 的列表样式还原成 `<ol>/<ul>`。
 * 实测：不加会报 2 条 `Unrecognised paragraph style: 'List Number' / 'List Bullet'`，
 *       列表被拍平成普通段落；加上后 `messages` 为空数组，列表恢复。
 */
export const DOCX_STYLE_MAP = [
  "p[style-name='List Number'] => ol > li:fresh",
  "p[style-name='List Bullet'] => ul > li:fresh",
];

// ────────────────────────────── HTML 子集解析（约 80 行，白名单） ──────────────────────────────

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlNode | string)[];
}

const VOID_TAGS = new Set([
  "img", "br", "hr", "input", "meta", "link", "col", "source", "area", "base", "embed", "param", "track", "wbr",
]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ldquo: "“",
  rdquo: "”",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 从 `<` 之后找到标签结束的 `>`（跳过引号内的 `>`） */
function findTagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return attrs;
}

/** 把 mammoth 的有限标签集解析成树；未知标签一律当透明容器 */
function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlNode[] = [root];
  const top = (): HtmlNode => stack[stack.length - 1];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      top().children.push(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) top().children.push(decodeEntities(html.slice(i, lt)));

    // 注释
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }

    const gt = findTagEnd(html, lt + 1);
    if (gt < 0) {
      top().children.push(decodeEntities(html.slice(lt)));
      break;
    }
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      // 容错闭合：从栈顶向下找第一个同名节点
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].tag === name) {
          stack.length = d;
          break;
        }
      }
      continue;
    }

    const nameMatch = raw.match(/^([a-zA-Z][\w-]*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const attrs = parseAttrs(raw.slice(nameMatch[0].length));

    if (raw.endsWith("/") || VOID_TAGS.has(name)) {
      top().children.push({ tag: name, attrs, children: [] });
      continue;
    }
    const node: HtmlNode = { tag: name, attrs, children: [] };
    top().children.push(node);
    stack.push(node);
  }

  return root;
}

// ────────────────────────────── 渲染 ──────────────────────────────

const isNode = (c: HtmlNode | string): c is HtmlNode => typeof c !== "string";

/** 行内内容渲染（不含块级换行） */
function renderInline(node: HtmlNode): string {
  return node.children.map(renderChild).join("");
}

function renderChild(child: HtmlNode | string): string {
  if (typeof child === "string") return child;
  const { tag } = child;
  switch (tag) {
    case "br":
      return "\n";
    case "img":
    case "script":
    case "style":
      return "";
    case "strong":
    case "b":
      return `**${renderInline(child)}**`;
    case "em":
    case "i":
      return `*${renderInline(child)}*`;
    case "a":
      return renderInline(child); // 只留文字，丢 URL
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${"#".repeat(Number(tag[1]))} ${renderInline(child).trim()}\n\n`;
    case "p":
      return `${renderInline(child).trim()}\n\n`;
    case "ol":
      return renderList(child, true);
    case "ul":
      return renderList(child, false);
    case "table":
      return renderTable(child);
    default:
      return renderInline(child); // 未知标签 = 透明容器
  }
}

function renderList(node: HtmlNode, ordered: boolean): string {
  const items = node.children
    .filter(isNode)
    .filter((c) => c.tag === "li")
    .map((li, i) => `${ordered ? `${i + 1}. ` : "- "}${renderInline(li).trim()}`);
  return items.length > 0 ? `${items.join("\n")}\n\n` : "";
}

/** 单元格：把块级内容压成单行（GFM 单元格不能含换行） */
function renderCell(cell: HtmlNode): string {
  return renderInline(cell)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function renderTable(node: HtmlNode): string {
  const rows = node.children
    .filter(isNode)
    .filter((c) => c.tag === "tr")
    .map((tr) =>
      tr.children
        .filter(isNode)
        .filter((c) => c.tag === "td" || c.tag === "th")
        .map(renderCell),
    );
  if (rows.length === 0) return "";

  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => [...r, ...Array(Math.max(0, cols - r.length)).fill("")];
  const lines = [
    `| ${pad(rows[0]).join(" | ")} |`,
    `| ${Array(cols).fill("---").join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${pad(r).join(" | ")} |`),
  ];
  return `${lines.join("\n")}\n\n`;
}

/**
 * mammoth 的 HTML 子集 → markdown（纯函数）。
 *
 * 标签集有限且良构（实测枚举）：`p / h1-h6 / table / tr / td / ol / ul / li / strong / em / a / img`。
 * 不做通用 HTML 解析——只处理这个白名单，未知标签当透明容器处理。
 */
export function htmlToMarkdown(html: string): string {
  const root = parseHtml(html);
  const text = root.children.map(renderChild).join("");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * `.docx` 文件 → markdown。**本模块唯一碰 fs 的函数**。
 * 流程：readFileSync → convertToHtml({buffer}, {styleMap}) → htmlToMarkdown → promoteChineseHeadings
 *
 * 中文简历/文档惯用「一、教育背景」这种**加粗普通段落**而非 Word 标题样式，
 * 所以最后一步还要把中文编号提升为 `##`，否则标题感知切块拿不到任何标题。
 */
export async function extractDocxMarkdown(filePath: string): Promise<string> {
  const buffer = readFileSync(filePath);
  const { value } = await mammothConv.convertToHtml({ buffer }, { styleMap: DOCX_STYLE_MAP });
  return promoteChineseHeadings(htmlToMarkdown(value));
}
