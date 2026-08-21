import { describe, it, expect } from "vitest";
import { Tracer } from "../tracer.js";

describe("Tracer PTC events", () => {
  it("records ptc_program with truncated code and description", () => {
    const t = new Tracer();
    t.startSession("scan dir");
    t.addPtcProgram("return 1;".repeat(200), "scan the dir", 0);
    const entry = t
      .getCurrentSession()!
      .steps.find((s) => s.type === "ptc_program")!;
    expect(entry.ptcDescription).toBe("scan the dir");
    expect(entry.ptcCode!.length).toBeLessThanOrEqual(500);
    expect(entry.ptcCode!.startsWith("return 1;")).toBe(true);
  });

  it("records ptc_dispatch with tool name and outcome", () => {
    const t = new Tracer();
    t.startSession("x");
    t.addPtcDispatch("run_1", "list_files", { path: "src" }, { files: ["a.ts"] }, false, 0);
    t.addPtcDispatch("run_1", "execute_command", { command: "x" }, "Error: boom", true, 0);
    const steps = t
      .getCurrentSession()!
      .steps.filter((s) => s.type === "ptc_dispatch");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      toolName: "list_files",
      toolSuccess: true,
      ptcParentId: "run_1",
    });
    expect(steps[1]).toMatchObject({
      toolName: "execute_command",
      toolSuccess: false,
    });
  });

  it("records ptc_result kinds and renders them in the report", () => {
    const t = new Tracer();
    t.startSession("x");
    t.addPtcResult("ok", 3, 120, 0);
    t.addPtcResult("timeout", 0, 0, 1);
    const steps = t.getCurrentSession()!.steps.filter((s) => s.type === "ptc_result");
    expect(steps[0].ptcKind).toBe("ok");
    expect(steps[0].ptcLogCount).toBe(3);
    expect(steps[1].ptcKind).toBe("timeout");
    const rendered = t.getReport();
    expect(rendered).toContain("📊 PTC ok");
    expect(rendered).toContain("📊 PTC timeout");
  });

  it("renders ptc_program and ptc_dispatch entries in the report", () => {
    const t = new Tracer();
    t.startSession("x");
    t.addPtcProgram("const a = 1;", "scan", 0);
    t.addPtcDispatch("run_1", "read_file", { file_path: "a.ts" }, "content", false, 0);
    const rendered = t.getReport();
    expect(rendered).toContain("📦 run_code: scan");
    expect(rendered).toContain('tools["read_file"]');
  });
});
