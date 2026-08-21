import { describe, it, expect } from "vitest";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { Tracer } from "../agent/tracer.js";
import { WorkerThreadCodeRuntime } from "./code-runtime-worker.js";
import { DispatchBridge } from "./dispatch-bridge.js";
import { RunCodeTool } from "./run-code-tool.js";

class EchoTool extends StructuredTool {
  name = "echo";
  description = "echo the input";
  schema = z.object({ v: z.unknown() });
  async _call({ v }: { v: unknown }): Promise<string> {
    return JSON.stringify(v);
  }
}

class BoomTool extends StructuredTool {
  name = "boom";
  description = "always fails";
  schema = z.object({});
  async _call(): Promise<string> {
    throw new Error("kaboom");
  }
}

function makeTool(config: { maxWallMs?: number; maxProgramLength?: number } = {}) {
  const runtime = new WorkerThreadCodeRuntime({ maxWallMs: config.maxWallMs ?? 5000 });
  const bridge = new DispatchBridge([new EchoTool(), new BoomTool()]);
  const tool = new RunCodeTool({
    dispatch: bridge,
    runtime,
    maxProgramLength: config.maxProgramLength ?? 10000,
    tracer: new Tracer(),
  });
  return { tool, runtime, bridge };
}

describe("RunCodeTool", () => {
  it("executes a program that calls bindings and returns logs + value", async () => {
    const { tool, runtime } = makeTool();
    const out = await tool._call({
      code: `
        console.log("start");
        const v = await tools["echo"]({ v: 42 });
        console.log("end");
        return v;
      `,
      description: "echo 42",
    });
    // logs: ["start", "end"] + value: JSON.stringify("42") = "\"42\""
    expect(out).toContain("start");
    expect(out).toContain("end");
    expect(out).toContain('"42"');
    await runtime.dispose();
  });

  it("propagates tool failure as a catchable program error", async () => {
    const { tool, runtime } = makeTool();
    const out = await tool._call({
      code: `
        try {
          await tools["boom"]({});
          return "no error";
        } catch (e) {
          return { caught: e.name, toolName: e.toolName };
        }
      `,
      description: "catch boom",
    });
    expect(out).toContain("ToolCallError");
    expect(out).toContain("boom");
    await runtime.dispose();
  });

  it("returns [run_code kind] on runtime failure for model self-correction", async () => {
    const { tool, runtime } = makeTool({ maxWallMs: 100 });
    const out = await tool._call({
      code: `await new Promise((r) => setTimeout(r, 1000)); return "late";`,
      description: "hang",
    });
    expect(out).toMatch(/^\[run_code timeout\]/);
    await runtime.dispose();
  });

  it("reports stats through setStatsReporter", async () => {
    const { tool, runtime } = makeTool();
    const reports: Array<{ kind: string; subCalls: number }> = [];
    tool.setStatsReporter((r) => reports.push(r));
    await tool._call({
      code: `
        await tools["echo"]({ v: 1 });
        await tools["echo"]({ v: 2 });
        return "ok";
      `,
      description: "two calls",
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({ kind: "ok", subCalls: 2 });
    await runtime.dispose();
  });
});
