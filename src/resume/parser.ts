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

const SECTION_MAP: Record<string, SectionType> = {
  "工作经历": "experience",
  "工作经验": "experience",
  "教育背景": "education",
  "教育": "education",
  "技能": "skills",
  "项目": "projects",
  "项目经历": "projects",
  "证书": "certifications",
  "语言": "languages",
};

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
        type: SECTION_MAP[title] || "experience",
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

      if (currentItem) finalizeItem(currentItem, descriptionLines, highlights);
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
  const sections = parseSections(rest);

  // Combine description-less text before any section as summary
  let summary = "";
  if (sections.length > 0) {
    const firstSectionStart = lines.findIndex(l => l.startsWith("## "));
    if (firstSectionStart > 0) {
      const preLines = lines.slice(meta.name ? lines.indexOf("---", 1) + 1 : 0, firstSectionStart)
        .filter(l => l.trim() && !l.startsWith("---"))
        .join(" ")
        .trim();
      if (preLines) summary = preLines;
    }
  }

  return {
    name: meta.name || "",
    title: meta.title || "",
    summary,
    contact: {
      email: meta.email || "",
      phone: meta.phone || undefined,
      github: meta.github || undefined,
      website: meta.website || undefined,
      linkedin: meta.linkedin || undefined,
    },
    sections,
  };
}
