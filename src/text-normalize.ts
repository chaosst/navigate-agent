/**
 * text-normalize.ts — mammoth 输出 → 结构化文本的通用归一化
 *
 * 从 src/resume/loader.ts 原样上移（两类消费方）：
 *   ① 简历链路：mammoth 的裸输出不符合 parseResumeText 的契约（详见下方注释）；
 *   ② RAG docx 路径：convertToHtml → htmlToMarkdown 之后仍需要「中文编号提升」这一条。
 *
 * ⚠️ normalizeConvertedMarkdown 是**逐字搬运**，不要"顺手重写"——它已被真实简历
 *    （中文排版 + 证件照 + OMML 公式）验证过。唯一的结构调整是把第 ③ 步拆成
 *    独立的 promoteChineseHeadings，供 docx 抽取路径单独复用。
 */

/**
 * mammoth 输出 → 解析器契约（`##` 分节 / `###` 条目）的归一化。
 *
 * 背景：mammoth 只做「docx 语义 → markdown 语法」的机械映射，产出的形态与
 * parseResumeText 期望的契约并不一致。实测一份真实简历（中文排版、含证件照）会暴露三类偏差：
 *   ① 内嵌图片被转成 base64 data URI —— 单张证件照即可让正文膨胀到 MB 级（实测 1.44M 字符），
 *      对检索零价值，且会污染 raw_md 存储与 token 预算；
 *   ② 正文被文档工具写进公式域（OMML）时，标点全部被转义（`\+86 135\-9059\-7722`、`Node\.js`）；
 *   ③ 中文简历惯用「一、教育背景」这种**加粗普通段落**而非 Word 标题样式，mammoth 不会输出 `##`。
 * 这三条任一都足以让 parseSections 解析出 0 个章节 → 索引为空 → 简历问答答不出任何问题。
 *
 * 只在 docx 路径调用：resume.md 是手工维护的单一事实源，原样透传不做任何改写。
 * 对已符合契约的输入是幂等的（无 base64、无转义、无中文编号时输出不变）。
 */
export function normalizeConvertedMarkdown(md: string): string {
  // ① 剥离内嵌 base64 图片（data URI 的 base64 字母表不含 ")"，可安全匹配到首个 ")"）
  let text = md.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, "");

  // ② 还原转义：mammoth 对公式/特殊字符会加反斜杠，解析器不消费转义
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, "$1");

  // ③ 中文编号小标题 → markdown 二级标题（解析器的分节依据）
  text = promoteChineseHeadings(text);

  // ④ 图片剥离后可能残留空强调标记行（`__`），并收敛多余空行
  text = text.replace(/^[ \t]*_+[ \t]*$/gm, "").replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * 中文编号小标题（`一、教育背景`）→ markdown 二级标题（`## 教育背景`）。幂等。
 *
 * 中文简历/文档惯用这种**加粗普通段落**而非 Word 标题样式，
 * mammoth 只给 `<p><strong>一、教育背景</strong></p>`，不产出 `#`。
 * 单独拆出是为了让「HTML → markdown」的 docx 路径也能复用这一条规则。
 */
export function promoteChineseHeadings(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*([一二三四五六七八九十]+)\s*[、.．]\s*(\S.*)$/);
      return m ? `## ${m[2].trim()}` : line;
    })
    .join("\n");
}
