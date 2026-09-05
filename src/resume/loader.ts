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
    const text = await docxToMarkdown(readFile(RESUME_FILE_DOCX));
    return { text, sourcePath: RESUME_FILE_DOCX, format: "docx" };
  }

  return null;
}
