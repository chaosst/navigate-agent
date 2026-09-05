import { describe, it, expect } from "vitest";
import { parseObservationSources, sourcesFromChunk } from "../sse-sources.js";

describe("parseObservationSources", () => {
  it("extracts source lines from a multi-block observation", () => {
    const obs = [
      "[1] 简历 / experience / 创新科技公司",
      "负责 RAG 检索链路开发，优化召回率。",
      "---",
      "[2] 简历 / skills / 编程语言",
      "TypeScript, Python",
    ].join("\n");
    expect(parseObservationSources(obs)).toEqual([
      "简历 / experience / 创新科技公司",
      "简历 / skills / 编程语言",
    ]);
  });

  it("handles content lines that look like citations (only block-start counts)", () => {
    const obs = "[1] 简历 / experience / A公司\n正文里也写了 [2] 简历 / projects / X\n---\n[2] 简历 / projects / Y";
    expect(parseObservationSources(obs)).toEqual([
      "简历 / experience / A公司",
      "简历 / projects / Y",
    ]);
  });

  it("returns [] for non-string or unmatched input", () => {
    expect(parseObservationSources(null)).toEqual([]);
    expect(parseObservationSources(123)).toEqual([]);
    expect(parseObservationSources("No relevant information found in the resume.")).toEqual([]);
  });
});

describe("sourcesFromChunk", () => {
  it("ignores non-search_resume tool steps", () => {
    const chunk = {
      intermediateSteps: [
        { action: { tool: "read_file" }, observation: "[1] resume.md" },
      ],
    };
    expect(sourcesFromChunk(chunk)).toEqual([]);
  });

  it("collects and dedupes sources across search_resume steps in order", () => {
    const chunk = {
      intermediateSteps: [
        { action: { tool: "search_resume" }, observation: "[1] 简历 / experience / A\n---\n[2] 简历 / skills / B" },
        { action: { tool: "search_resume" }, observation: "[1] 简历 / experience / A" },
      ],
    };
    expect(sourcesFromChunk(chunk)).toEqual([
      "简历 / experience / A",
      "简历 / skills / B",
    ]);
  });

  it("tolerates missing intermediateSteps", () => {
    expect(sourcesFromChunk({})).toEqual([]);
  });
});
