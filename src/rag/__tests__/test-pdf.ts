/**
 * 测试用最小 PDF 生成器（不进产品代码）。
 *
 * 为什么手写：仓库里没有任何 .pdf 样例，而 `extractPdfPages` 的 P0 修复必须用
 * **真实 PDF 字节流**验证（mock 掉 pdf-parse 就等于什么都没测）。
 * 这里手写一个结构合法、可用 pdfjs 解析的多页 PDF（ASCII 文本，避免字体嵌入）。
 *
 * 注意：只支持 ASCII 文本 —— PDF 的 Type1 字体不带 CJK 字形表，中文会渲染成空白。
 * 单测只需要验证「页数 / 页号 / 文本能取到」，ASCII 足够。
 */

/** PDF 字面量字符串转义：\ ( ) 三个字符必须转义 */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * 生成 pages.length 页的 PDF，第 i 页正文为 pages[i]。
 * 结构：Catalog → Pages → 每页 (Page + Contents) → 共享 Font。
 */
export function makeTestPdf(pages: string[]): Buffer {
  // 对象编号：1=Catalog, 2=Pages, 3=Font, 之后每页占 2 个（Page, Contents）
  const fontId = 3;
  const firstPageId = 4;
  const totalObjs = fontId + pages.length * 2;

  const bodies: string[] = [];
  const pageRefs: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    pageRefs.push(`${firstPageId + i * 2} 0 R`);
  }

  bodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  bodies[2] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pages.length} >>`;
  bodies[fontId] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  for (let i = 0; i < pages.length; i++) {
    const pageId = firstPageId + i * 2;
    const contentId = pageId + 1;
    bodies[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 18 Tf 72 700 Td (${esc(pages[i])}) Tj ET`;
    bodies[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  }

  // 逐对象序列化，同时记录字节偏移（xref 表要求）
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id <= totalObjs; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${bodies[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${totalObjs + 1}\n`;
  out += `0000000000 65535 f \n`;
  for (let id = 1; id <= totalObjs; id++) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}
