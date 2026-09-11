/**
 * resume/loader.ts — 简历入口归一化（文件格式无关 → markdown 单一事实源）
 *
 * 现状：整条简历链路（结构化解析 / RAG chunk+embedding / JD 诊断全文 / 展示页）
 * 只认 markdown。本模块负责探测磁盘上的简历源文件，把 docx 用 mammoth
 * 在本地进程内转为 markdown（简历是敏感数据，绝不调云端文档解析 API），
 * 下游一律只消费归一化后的 md 文本 —— 加新格式只需扩展这里。
 *
 * 优先级：resume.md（手工维护的单一事实源）> resume.docx（自动转换）。
 * .doc 老二进制格式 mammoth 不支持 → 检测到只告警、不处理。
 */
import { existsSync, readFileSync } from "node:fs";
import mammoth from "mammoth";

export const RESUME_FILE_MD = "resume.md";
export const RESUME_FILE_DOCX = "resume.docx";
export const RESUME_FILE_DOC = "resume.doc";

export interface ResumeSource {
  /** 归一化后的 markdown 文本（docx 已转换） */
  text: string;
  /** 源文件路径（用于日志 / 展示） */
  sourcePath: string;
  format: "md" | "docx";
}

/** 注入依赖便于单测：默认走真实 fs + mammoth */
export interface LoaderDeps {
  exists: (p: string) => boolean;
  readFile: (p: string) => Buffer;
  docxToMarkdown: (buf: Buffer) => Promise<string>;
}

// mammoth@1.12 自带 d.ts 未收录 convertToMarkdown（运行时导出存在）。
// 上游类型更新后可移除断言。
const mammothConv = mammoth as unknown as {
  convertToMarkdown: (
    input: { buffer: Buffer },
    options?: Record<string, unknown>,
  ) => Promise<{ value: string }>;
};

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
  text = text
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*([一二三四五六七八九十]+)\s*[、.．]\s*(\S.*)$/);
      return m ? `## ${m[2].trim()}` : line;
    })
    .join("\n");

  // ④ 图片剥离后可能残留空强调标记行（`__`），并收敛多余空行
  text = text.replace(/^[ \t]*_+[ \t]*$/gm, "").replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

export async function loadResumeSource(deps?: LoaderDeps): Promise<ResumeSource | null> {
  const { exists, readFile, docxToMarkdown } = deps ?? {
    exists: existsSync,
    readFile: readFileSync,
    docxToMarkdown: (buf: Buffer) =>
      mammothConv.convertToMarkdown({ buffer: buf }).then((r) => r.value),
  };

  if (exists(RESUME_FILE_MD)) {
    return {
      text: readFile(RESUME_FILE_MD).toString("utf-8"),
      sourcePath: RESUME_FILE_MD,
      format: "md",
    };
  }

  if (exists(RESUME_FILE_DOC)) {
    console.warn(
      `[resume] 检测到 ${RESUME_FILE_DOC}，但 .doc 老二进制格式不受支持；` +
        "请另存为 .docx（将自动转换），或直接提供 resume.md",
    );
  }

  if (exists(RESUME_FILE_DOCX)) {
    const raw = await docxToMarkdown(readFile(RESUME_FILE_DOCX));
    // 必须归一化：mammoth 的裸输出不符合 parseResumeText 的契约（详见上方注释）
    return {
      text: normalizeConvertedMarkdown(raw),
      sourcePath: RESUME_FILE_DOCX,
      format: "docx",
    };
  }

  return null;
}
