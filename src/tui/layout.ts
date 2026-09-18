/**
 * TUI 动态区「行预算」与终端视觉宽度工具。
 *
 * 纯函数、零依赖：不碰 React / Ink（只有末尾的 `terminalRows` / `terminalColumns`
 * 读 `process.stdout`），便于单测与复用。
 *
 * ## 为什么要行预算（2026-09-16 的坑）
 *
 * Ink 的动态帧是**原地重画**：每帧 `log-update` 写 `eraseLines(上一帧行数)` 再写新帧
 * （见 `node_modules/ink/build/log-update.js:17`）。`eraseLines(n)` = 光标上移 n-1 行 +
 * 擦到屏幕底部，而**光标最多只能上移到首行**——一旦动态帧行数 ≥ 终端行数，擦除量被
 * 夹在屏幕顶端，于是：
 *
 *   - 帧变高时：超出的行把屏幕顶出去（顶部内容滚走）；
 *   - 帧回落后：`eraseLines(大数)` 只能从顶行开始擦 → 新帧被画在**屏幕上方**，
 *     下面留一大片空白。
 *
 * 用户看到的就是「输入框跑到顶部、下方一大块空隙」——不是样式问题，是帧高失控。
 * 结论：**动态区高度必须永远小于终端行数**。下面三件事共同保证这一点：
 *
 *   1. `tailByRows` —— 流式预览 / 卡片正文按「终端行」而非字符数裁剪；
 *   2. `computeDynamicBudget` —— 按终端高度分配卡片数、卡片正文行数、预览行数；
 *   3. 输入框固定在帧底（思考指示与状态行都在其上方，不再占用输入框下方一行）。
 *
 * 另外：`visualRows` 按**显示列宽**折行，中文/emoji 占 2 列，不能用 `line.length` 估。
 */

/** East Asian Wide / Fullwidth 码点区间（占 2 列） */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK 部首 / 标点
  [0x3041, 0x33ff], // 假名 / 注音 / CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // 全角字符
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK 扩展 B 及以上
];

/** 零宽码点（组合符 / 变体选择符 / 零宽连接符 / 方向标记） */
const ZERO_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
];

/** 单个码点的终端列宽：0=组合符或变体选择符，2=东亚宽 / 全角 / emoji，其余 1 */
export function charWidth(codePoint: number): number {
  for (const [lo, hi] of ZERO_RANGES) if (codePoint >= lo && codePoint <= hi) return 0;
  for (const [lo, hi] of WIDE_RANGES) if (codePoint >= lo && codePoint <= hi) return 2;
  return 1;
}

/** 字符串的终端显示宽度（控制字符不计宽） */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) continue;
    width += charWidth(cp);
  }
  return width;
}

/** 文本占用多少个终端行（按 columns 折行；空串 0 行，空行占 1 行） */
export function visualRows(text: string, columns: number): number {
  if (!text) return 0;
  const cols = columns > 0 ? Math.floor(columns) : 80;
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(textWidth(line) / cols));
  }
  return rows;
}

/**
 * 单行超长时按显示列宽从**行首**切掉，保留尾部（绝不切出半截宽字符）。
 * 返回值以 `…` 开头标记被切过；maxWidth <= 1 时只返回 `…`。
 */
export function tailByWidth(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (textWidth(line) <= maxWidth) return line;
  const chars = Array.from(line);
  let width = 0;
  let i = chars.length;
  while (i > 0) {
    const w = charWidth(chars[i - 1].codePointAt(0) ?? 0);
    // 留 1 列给省略号
    if (width + w > maxWidth - 1) break;
    width += w;
    i--;
  }
  return "…" + chars.slice(i).join("");
}

/**
 * 单行硬截：保留**行首** + `…`，保证结果不超过 maxWidth 显示列。
 * （`tailByWidth` 是保尾部，这个是保头部——表格单元格、省略标记用它。）
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return "…".slice(0, Math.max(0, maxWidth));
  if (textWidth(text) <= maxWidth) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > maxWidth - 1) break;
    out += ch;
    used += w;
  }
  return out + "…";
}

/** 被裁掉的部分 */
export interface TailClipDrop {
  /** 整行被裁掉的行数（逻辑行） */
  lines: number;
  /** 被裁掉的字符数（含"单行硬切"时切掉的字符） */
  chars: number;
}

export interface TailClipOptions {
  /** 行预算（终端行数） */
  rows: number;
  /** 终端列数；给了才按折行计算，缺省按逻辑行计（每行 1 行） */
  columns?: number;
  /**
   * 省略标记文案。一旦发生裁剪**必然**插一行标记，
   * 所以实现必须返回非空字符串（想换措辞就换，别返回空串——否则行预算会算错）。
   */
  marker?: (drop: TailClipDrop) => string;
}

const DEFAULT_MARKER = (drop: TailClipDrop): string =>
  drop.lines > 0 ? `⋯ 已省略前 ${drop.lines} 行` : `⋯ 行首已省略 ${drop.chars} 字符`;

/**
 * 按**终端行预算**保留文本尾部（旧的 `clipPreview` 只看逻辑行数与字符数，
 * 中文长行会折成多行 → 预算虚低、帧高失控）。
 *
 * 不变式（有单测锁）：**返回文本的 `visualRows` 不会超过 rows**（rows ≥ 2 时成立；
 * rows = 1 属退化输入，`computeDynamicBudget` 已保证不会传进来）。
 * 做法：需要裁剪时给省略标记预留 1 行；连最后一行都超预算时按列宽硬切尾部。
 */
export function tailByRows(text: string, opts: TailClipOptions): string {
  if (!text) return "";
  const rows = Math.max(1, Math.floor(opts.rows));
  const cols = opts.columns && opts.columns > 0 ? Math.floor(opts.columns) : 0;
  const lineRows = (line: string): number =>
    cols > 0 ? Math.max(1, Math.ceil(textWidth(line) / cols)) : 1;

  const lines = text.split("\n");
  let total = 0;
  for (const line of lines) total += lineRows(line);
  if (total <= rows) return text;

  const marker = opts.marker ?? DEFAULT_MARKER;
  // 标记行固定占 1 行，先从预算里扣掉。窄终端里标记文案本身可能超宽 → 硬截，
  // 否则它折成两行就把预算顶破了（不变式在窄终端上就废了）。
  const markerLine = (drop: TailClipDrop): string => {
    const text = marker(drop);
    return cols > 0 ? truncateToWidth(text, cols) : text;
  };
  const budget = Math.max(1, rows - 1);

  let used = 0;
  let i = lines.length;
  while (i > 0) {
    const r = lineRows(lines[i - 1]);
    if (used + r > budget) break;
    used += r;
    i--;
  }

  if (i === lines.length) {
    // 连最后一行自己都超预算 → 只能按列宽硬切尾部
    const last = lines[lines.length - 1] ?? "";
    const kept = tailByWidth(last, cols > 0 ? cols * budget : Math.max(1, budget));
    const keptChars = kept.startsWith("…") ? kept.length - 1 : kept.length;
    const dropped: TailClipDrop = { lines: 0, chars: Math.max(0, last.length - keptChars) };
    return `${markerLine(dropped)}\n${kept}`;
  }

  const dropped: TailClipDrop = {
    lines: i,
    chars: lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0),
  };
  return `${markerLine(dropped)}\n${lines.slice(i).join("\n")}`;
}

/**
 * 动态区固定开销（不参与分配）：预览标题 1 + 预览下边距 1 + 思考指示 1 +
 * 状态行 1 + 输入框 3 = 7。
 *
 * 顺序（2026-09-18）：思考指示、状态行都在**预览之下、输入框之上**——常驻 chrome
 * 必须待在帧底；挂在动态区顶部会被当轮流式输出挤到答案上方、跟着内容滚动。
 */
export const CHROME_ROWS = 7;

export interface DynamicBudget {
  /** 当轮卡片 + 流式预览总共可用的行数 */
  total: number;
  /** dynamic 区最多同时挂几张当轮卡片（超出部分提前落 <Static>） */
  cardsLimit: number;
  /** 单张工具卡片正文最多渲染几行 */
  cardBodyRows: number;
  /** 流式预览正文最多渲染几行 */
  previewRows: number;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 按终端高度分配动态区预算。
 *
 * 分配口径（保证 `卡片数 ×(正文+标题+下边距) + 预览 ≤ total`）：
 * - `cardsLimit`：每张卡片最少按 6 行（标题 1 + 正文 + 下边距 1）估；
 * - `cardBodyRows`：正文按 total/12 收缩，钳在 2~4（running 卡片的参数/观测预览；
 *   下限 2 是因为 `tailByRows` 在 rows=1 时无法同时容纳「正文 1 行 + 省略标记 1 行」）；
 * - `previewRows`：剩下的全给流式预览，至少 2 行。
 *
 * `approvalRows`：审批 / 提问卡片出现时（3~6 行）从预算里先扣掉。
 */
export function computeDynamicBudget(termRows: number, opts: { approvalRows?: number } = {}): DynamicBudget {
  const rows = Number.isFinite(termRows) && termRows > 0 ? Math.floor(termRows) : 24;
  const approval = Math.max(0, Math.floor(opts.approvalRows ?? 0));
  const total = Math.max(8, rows - CHROME_ROWS - approval);

  const cardsLimit = clampInt(Math.floor(total / 6), 1, 6);
  const cardBodyRows = clampInt(Math.floor(total / 12), 2, 4);
  const previewRows = Math.max(2, total - cardsLimit * (cardBodyRows + 2));

  return { total, cardsLimit, cardBodyRows, previewRows };
}

/** 终端行数（非 TTY / 未知时回落 24 行） */
export function terminalRows(): number {
  const rows = process.stdout.rows;
  return Number.isFinite(rows) && (rows as number) > 0 ? (rows as number) : 24;
}

/** 终端列数（非 TTY / 未知时回落 80 列） */
export function terminalColumns(): number {
  const cols = process.stdout.columns;
  return Number.isFinite(cols) && (cols as number) > 0 ? (cols as number) : 80;
}
