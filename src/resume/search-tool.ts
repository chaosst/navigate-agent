import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ResumeStore } from "./store.js";

export class ResumeSearchTool extends StructuredTool {
  name = "search_resume";
  description = "Search the user's resume for professional experience, skills, education, and project details. "
    + "Use this when asked about the user's background, skills, work history, or qualifications. "
    + "You can filter by section type: experience, education, skills, projects, certifications, languages, summary. "
    + "Use section='all' to search everything.";

  schema = z.object({
    query: z.string().describe("The search query for resume content. Use empty string to list all items in a section."),
    // ⚠️ 必须与 SectionType 保持同步：枚举缺项会让 LLM 无法按该分区过滤（静默查不到），
    // 而非报错。languages 曾长期缺失（prompt 却宣称支持），summary 为新增。
    section: z.enum(["experience", "education", "skills", "projects", "certifications", "languages", "summary", "all"])
      .optional()
      .describe("Filter results to a specific resume section. Omit or use 'all' to search everything."),
    k: z.number().optional().describe("Number of results to return (default 5)"),
  });

  constructor(private store: ResumeStore) {
    super();
  }

  async _call({ query, section, k }: z.infer<typeof this.schema>): Promise<string> {
    const results = await this.store.search(query, section || "all", k || 5);
    if (results.length === 0) {
      return "No relevant information found in the resume.";
    }
    return results.map((r, i) =>
      `[${i + 1}] ${r.source}\n${r.content}\n`
    ).join("\n---\n");
  }
}
