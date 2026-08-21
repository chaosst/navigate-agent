import { describe, it, expect } from "vitest";
import { buildStatsFooter } from "../graph-utils.js";
import { Tracer } from "../tracer.js";
import { ToolStatsRegistry } from "../../tools/stats-registry.js";
import { createTools } from "../../tools/registry.js";
import { PermissionWrapper } from "../../tools/permission.js";

describe("buildStatsFooter", () => {
  it("includes token usage when tracer recorded LLM calls", () => {
    const tracer = new Tracer();
    tracer.startSession("test");
    tracer.addLLMCall(0, "input-summary", "output", null, 10, 100, 50);
    const footer = buildStatsFooter(undefined, tracer);
    expect(footer).toContain("Tokens: 100 in / 50 out");
  });

  it("returns empty string when nothing recorded", () => {
    const tracer = new Tracer();
    tracer.startSession("test");
    expect(buildStatsFooter(undefined, tracer)).toBe("");
  });

  it("returns empty string when tracer has no session", () => {
    expect(buildStatsFooter(undefined, new Tracer())).toBe("");
  });

  it("combines tool stats and token stats", async () => {
    const registry = new ToolStatsRegistry();
    const list = createTools(registry).find((t) => t.name === "list_files") as PermissionWrapper;
    await list.invoke({ path: "/nonexistent-footer-test" }).catch(() => {});

    const tracer = new Tracer();
    tracer.startSession("test");
    tracer.addLLMCall(0, "in", "out", null, 10, 10, 5);

    const footer = buildStatsFooter(registry, tracer);
    expect(footer).toContain("📊 工具调用统计");
    expect(footer).toContain("Tokens: 10 in / 5 out");
  });
});
