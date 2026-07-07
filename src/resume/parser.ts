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

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Section heading (##)
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      if (currentItem) finalizeItem(currentItem, descriptionLines, highlights);
      if (currentSection && currentSection.items.length === 0 && currentItem) {
        currentSection.items.push(currentItem);
      }
      if (currentSection) sections.push(currentSection);
      const title = sectionMatch[1].trim();
      currentSection = {
        type: SECTION_MAP[title] || "experience",
        title,
        items: [],
      };
      currentItem = null;
      descriptionLines = [];
      highlights = [];
      continue;
    }

    // Item heading (###)
    const itemMatch = line.match(/^###\s+(.+)/);
    if (itemMatch && currentSection) {
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
    if (bulletMatch && currentItem) {
      highlights.push(bulletMatch[1].trim());
      continue;
    }

    // Empty line between items
    if (line === "" && currentItem && descriptionLines.length > 0) {
      descriptionLines.push("");
      continue;
    }

    // Regular description text (for subtitle detection)
    if (currentItem && line && !line.startsWith("#")) {
      descriptionLines.push(line);
    }
  }

  // Finalize last item/section
  if (currentItem) finalizeItem(currentItem, descriptionLines, highlights);
  if (currentSection) {
    if (currentItem && !currentSection.items.includes(currentItem)) {
      currentSection.items.push(currentItem);
    }
    sections.push(currentSection);
  }

  return sections;
}

function finalizeItem(item: ResumeItem, descLines: string[], highlights: string[]) {
  // First line of description is often the subtitle (company / school name)
  const nonEmpty = descLines.filter(l => l.trim());
  if (nonEmpty.length > 0 && !item.subtitle) {
    // Check if first non-empty line looks like a subtitle (not markdown, short)
    const first = nonEmpty[0].trim();
    if (!first.startsWith("[") && !first.startsWith("!") && first.length < 80) {
      item.subtitle = first;
      descLines = descLines.filter(l => l.trim() !== first);
    }
  }
  item.description = descLines.join("\n").trim();
  item.highlights = highlights;
}

export function parseResume(filePath: string): ResumeData {
  const content = readFileSync(filePath, "utf-8");
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
