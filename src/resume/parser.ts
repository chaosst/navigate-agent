import { readFileSync } from "node:fs";
import type { ResumeData, ResumeSection, ResumeItem, SectionType } from "./types.js";

function parseFrontmatter(lines: string[]): { meta: Record<string, string>; rest: string[] } {
  const meta: Record<string, string> = {};
  if (!lines[0]?.trim().startsWith("---")) return { meta, rest: lines };

  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim().startsWith("---")) { i++; break; }
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      meta[lines[i].slice(0, colon).trim()] = lines[i].slice(colon + 1).trim();
    }
  }
  return { meta, rest: lines.slice(i) };
}

/**
 * 分节标题 → SectionType 的有序关键词规则。
 *
 * 旧实现用精确表查（`SECTION_MAP[title]`），只有 `## 技能` 这种逐字匹配才命中，
 * 而真实简历的标题普遍更长——「四、专业技能」「AI 项目经历（重点）」全部落到兜底
 * 的 experience。改为子串匹配后，标题只要含关键词即可归类。
 *
 * ⚠️ 顺序即优先级：「AI 项目经历」同时含「项目」与「经历」，必须先判 projects，
 * 否则会被 experience 抢先命中。
 */
const SECTION_RULES: ReadonlyArray<{ pattern: RegExp; type: SectionType }> = [
  { pattern: /项目|作品|project/i, type: "projects" },
  { pattern: /工作|经历|履历|experience|employment/i, type: "experience" },
  { pattern: /教育|学历|education/i, type: "education" },
  { pattern: /技能|专长|技术栈|skill/i, type: "skills" },
  { pattern: /证书|认证|certificat/i, type: "certifications" },
  { pattern: /语言|language/i, type: "languages" },
];

/**
 * 未命中任何规则时的兜底类型。
 *
 * 旧值是 `experience`，会把「求职意向与定位」「核心亮点」这类叙述型分节伪装成工作经历
 * ——渲染成 💼 + 时间线圆点，检索时也会被 `section=experience` 过滤命中。
 * 改为 `summary`（叙述型）：渲染为正文段落，语义正确且对新分节天然安全。
 */
const DEFAULT_SECTION_TYPE: SectionType = "summary";

function resolveSectionType(title: string): SectionType {
  for (const rule of SECTION_RULES) {
    if (rule.pattern.test(title)) return rule.type;
  }
  return DEFAULT_SECTION_TYPE;
}

// ——— 无 frontmatter 时的头部推断（docx 路径不可能有 frontmatter） ———

const CONTACT_PATTERNS = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  phone: /(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}/,
  github: /github\.com\/[A-Za-z0-9_./-]+/i,
} as const;

/** 首个非 github 的 http(s) 链接视为个人站点 */
function pickWebsite(text: string): string | undefined {
  const urls = text.match(/https?:\/\/[^\s)】\]]+/g) ?? [];
  return urls.find((u) => !/github\.com/i.test(u));
}

/** 判定某行是否像「姓名」/「职位」这类短标题行（排除联系方式、装饰、长句） */
function looksLikeHeaderLabel(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 30) return false;
  if (/[@：:|｜/]/.test(t)) return false; // 含分隔符 → 是信息行而非姓名/职位
  if (/https?:|data:/i.test(t)) return false;
  return true;
}

interface HeaderFallback {
  name: string;
  title: string;
  email: string;
  phone?: string;
  github?: string;
  website?: string;
}

function deriveHeaderFallback(headerLines: string[]): HeaderFallback {
  const joined = headerLines.join(" ");
  const labels = headerLines.filter(looksLikeHeaderLabel);
  return {
    name: labels[0] ?? "",
    title: labels[1] ?? "",
    email: joined.match(CONTACT_PATTERNS.email)?.[0] ?? "",
    phone: joined.match(CONTACT_PATTERNS.phone)?.[0],
    github: joined.match(CONTACT_PATTERNS.github)?.[0],
    website: pickWebsite(joined),
  };
}

function parseSections(lines: string[]): ResumeSection[] {
  const sections: ResumeSection[] = [];
  let currentSection: ResumeSection | null = null;
  let currentItem: ResumeItem | null = null;
  let descriptionLines: string[] = [];
  let highlights: string[] = [];
  // Accumulate content at section level (for flat-list sections like skills)
  let sectionDescLines: string[] = [];
  let sectionHighlights: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Section heading (##)
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      if (currentItem) finalizeItem(currentItem, descriptionLines, highlights);
      if (currentSection) {
        finalizeSection(currentSection, currentItem, sectionDescLines, sectionHighlights);
        sections.push(currentSection);
      }
      const title = sectionMatch[1].trim();
      currentSection = {
        type: resolveSectionType(title),
        title,
        items: [],
      };
      currentItem = null;
      descriptionLines = [];
      highlights = [];
      sectionDescLines = [];
      sectionHighlights = [];
      continue;
    }

    // Item heading (###)
    const itemMatch = line.match(/^###\s+(.+)/);
    if (itemMatch && currentSection) {
      // If there is accumulated section content before the first ###,
      // create a synthetic item for it first
      if (currentItem === null && (sectionDescLines.length > 0 || sectionHighlights.length > 0)) {
        currentSection.items.push({
          title: currentSection.title,
          description: sectionDescLines.join("\n").trim(),
          highlights: [...sectionHighlights],
        });
        sectionDescLines = [];
        sectionHighlights = [];
      }

      // ⚠️ finalizeItem 只做收尾，**不会**把条目放进 section.items ——
      // 必须在这里显式 push，否则进入下一个 ### 时上一个条目就被丢弃。
      // 历史缺陷：只有每个分节的最后一个条目能被 finalizeSection 推入，
      // 导致「工作经历」这类多条目分节只剩最后一段（实测丢了华为 OD 那段经历）。
      if (currentItem) {
        finalizeItem(currentItem, descriptionLines, highlights);
        currentSection.items.push(currentItem);
      }
      const title = itemMatch[1].trim();
      currentItem = {
        title,
        description: "",
        highlights: [],
      };
      // Check for date range in parenthes e.g. "Company (2020-2023)"
      const dateMatch = title.match(/\(([^)]+)\)$/);
      if (dateMatch) {
        currentItem.dateRange = dateMatch[1];
        currentItem.title = title.slice(0, title.lastIndexOf("(")).trim();
      }
      descriptionLines = [];
      highlights = [];
      continue;
    }

    // Bullet — highlight
    const bulletMatch = line.match(/^-\s+(.+)/);
    if (bulletMatch) {
      if (currentItem) {
        highlights.push(bulletMatch[1].trim());
      } else if (currentSection) {
        // Capture bullets at section level (flat-list sections like skills)
        sectionHighlights.push(bulletMatch[1].trim());
      }
      continue;
    }

    // Empty line between items
    if (line === "" && currentItem && descriptionLines.length > 0) {
      descriptionLines.push("");
      continue;
    }

    // Regular description text (for subtitle detection)
    if (line && !line.startsWith("#")) {
      if (currentItem) {
        descriptionLines.push(line);
      } else if (currentSection) {
        // Capture text at section level
        sectionDescLines.push(line);
      }
    }
  }

  // Finalize last item/section
  if (currentItem) finalizeItem(currentItem, descriptionLines, highlights);
  if (currentSection) {
    finalizeSection(currentSection, currentItem, sectionDescLines, sectionHighlights);
    sections.push(currentSection);
  }

  return sections;
}

/** Finalize a section: add pending item and create synthetic item for flat content. */
function finalizeSection(
  section: ResumeSection,
  lastItem: ResumeItem | null,
  descLines: string[],
  highlights: string[],
): void {
  if (lastItem && !section.items.includes(lastItem)) {
    section.items.push(lastItem);
  }
  // If no items were created from ### headings but there is accumulated
  // content, create a synthetic ResumeItem for the whole section.
  if (section.items.length === 0 && (descLines.length > 0 || highlights.length > 0)) {
    section.items.push({
      title: section.title,
      description: descLines.join("\n").trim(),
      highlights,
    });
  }
}

function finalizeItem(item: ResumeItem, descLines: string[], highlights: string[]) {
  // First line of description is often the subtitle (company / school name)
  const nonEmpty = descLines.filter(l => l.trim());
  if (nonEmpty.length > 0 && !item.subtitle) {
    // Check if first non-empty line looks like a subtitle (not markdown, short)
    const first = nonEmpty[0].trim();
    if (!first.startsWith("[") && !first.startsWith("!") && first.length < 80) {
      item.subtitle = first;
      const idx = descLines.findIndex(l => l.trim() === first);
      if (idx >= 0) descLines.splice(idx, 1);
    }
  }
  item.description = descLines.join("\n").trim();
  item.highlights = highlights;
}

export function parseResume(filePath: string): ResumeData {
  return parseResumeText(readFileSync(filePath, "utf-8"));
}

/** 从 markdown 文本解析结构化简历（loader 归一化后 docx 也是 markdown，入口统一走这里） */
export function parseResumeText(content: string): ResumeData {
  const lines = content.split("\n");

  const { meta, rest } = parseFrontmatter(lines);
  const hasFrontmatter = Object.keys(meta).length > 0;
  const sections = parseSections(rest);

  const clean = (ls: string[]): string[] =>
    ls.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  const firstSectionIdx = rest.findIndex((l) => /^##\s+/.test(l));
  const preSectionLines = clean(firstSectionIdx >= 0 ? rest.slice(0, firstSectionIdx) : []);
  // 头部推断的取样范围比 summary 宽：完全没有分节时退化为全文，仍能取到首行姓名
  const headerLines = firstSectionIdx >= 0 ? preSectionLines : clean(rest);

  // frontmatter 缺失时的头部推断：docx 路径不可能带 frontmatter，
  // 若不推断则 name/title/contact 全空（实测「谭泳超」这种首行姓名也拿不到）。
  const fallback = hasFrontmatter ? null : deriveHeaderFallback(headerLines);

  // 有 frontmatter：分节前的正文整体作 summary（保持旧行为）。
  // 无 frontmatter：头部块是姓名/职位/联系方式/装饰徽章等噪声，不作 summary——
  // 真正的自我介绍由「求职意向与定位」这类分节承载，会正常切块入索引。
  const summary = hasFrontmatter ? preSectionLines.join(" ").trim() : "";

  return {
    name: meta.name || fallback?.name || "",
    title: meta.title || fallback?.title || "",
    summary,
    contact: {
      email: meta.email || fallback?.email || "",
      phone: meta.phone || fallback?.phone,
      github: meta.github || fallback?.github,
      website: meta.website || fallback?.website,
      linkedin: meta.linkedin || undefined,
    },
    sections,
  };
}
