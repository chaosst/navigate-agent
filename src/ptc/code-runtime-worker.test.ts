import { describe, it, expect } from "vitest";
import { WorkerThreadCodeRuntime } from "./code-runtime-worker.js";
import type { WorkerCodeRuntimeConfig } from "./code-runtime-worker.js";
import type { CodeJsonValue } from "./types.js";

function makeRuntime(overrides: WorkerCodeRuntimeConfig = {}) {
  return new WorkerThreadCodeRuntime({ maxWallMs: 5000, ...overrides });
}

describe("WorkerThreadCodeRuntime", () => {
  it("runs a program and returns its top-level return value", async () => {
    const r = makeRuntime();
    const result = await r.run({
      program: `return "hello " + (1 + 1);`,
      bindings: [],
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("hello 2");
    await r.dispose();
  });

  it("captures console output in emission order", async () => {
    const r = makeRuntime();
    const result = await r.run({
      program: `console.log("first"); console.warn("second"); return "ok";`,
      bindings: [],
    });
    expect(result.error).toBeUndefined();
    expect(result.logs).toEqual(["first", "[warn] second"]);
    await r.dispose();
  });

  it("exposes bindings as async callables and returns their JSON value", async () => {
    const r = makeRuntime();
    const result = await r.run({
      program: `const v = await tools["echo"]({ x: 1, y: [2, 3] }); return v;`,
      bindings: [
        {
          global: "tools",
          functions: {
            echo: async (args) => ({ echoed: args }) as CodeJsonValue,
          },
        },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ echoed: { x: 1, y: [2, 3] } });
    await r.dispose();
  });

  it("turns a rejected binding call into a program-catchable ToolCallError with toolName", async () => {
    const r = makeRuntime();
    const result = await r.run({
      program: `
        try {
          await tools["boom"]({});
          return "no error";
        } catch (e) {
          return { caught: e.name, toolName: e.toolName, message: e.message };
        }
      `,
      bindings: [
        {
          global: "tools",
          functions: {
            boom: async () => {
              throw new Error("kaboom");
            },
          },
          errorClass: { name: "ToolCallError", memberNameProperty: "toolName" },
        },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      caught: "ToolCallError",
      toolName: "boom",
      message: "kaboom",
    });
    await r.dispose();
  });

  it("rejects unknown binding names instead of executing", async () => {
    const r = makeRuntime();
    const result = await r.run({
      program: `
        try {
          await tools["nope"]({});
          return "no error";
        } catch (e) {
          return { toolName: e.toolName };
        }
      `,
      bindings: [
        {
          global: "tools",
          functions: {
            real: async () => "ok",
          },
        },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ toolName: "nope" });
    await r.dispose();
  });

  it("rejects non-erasable syntax (enum) without creating a worker", async () => {
    const r = makeRuntime();
    const result = await r.run({
      program: `enum Color { Red, Green }\nreturn "never";`,
      bindings: [],
    });
    expect(result.error?.kind).toBe("exception");
    expect(result.value).toBeUndefined();
    expect(result.error?.message).toMatch(/enum/i);
    await r.dispose();
  });

  it("reports syntax errors as exception", async () => {
    const r = makeRuntime();
    const result = await r.run({
      program: `return "unclosed`,
      bindings: [],
    });
    expect(result.error?.kind).toBe("exception");
    await r.dispose();
  });

  it("terminates the worker and reports timeout when exceeding maxWallMs", async () => {
    const r = new WorkerThreadCodeRuntime({ maxWallMs: 100 });
    const result = await r.run({
      program: `await new Promise((res) => setTimeout(res, 2000)); return "late";`,
      bindings: [],
    });
    expect(result.error?.kind).toBe("timeout");
    await r.dispose();
  });

  it("reports abort when the signal fires", async () => {
    const r = makeRuntime();
    const controller = new AbortController();
    const promise = r.run({
      program: `await new Promise((res) => setTimeout(res, 2000)); return "late";`,
      bindings: [],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.error?.kind).toBe("abort");
    await r.dispose();
  });

  it("reports output-limit when logs+value exceed maxOutputBytes", async () => {
    const r = new WorkerThreadCodeRuntime({ maxOutputBytes: 100 });
    const result = await r.run({
      program: `return "x".repeat(1000);`,
      bindings: [],
    });
    expect(result.error?.kind).toBe("output-limit");
    await r.dispose();
  });

  it("reports invalid-output when completion value is not cloneable", async () => {
    const r = makeRuntime();
    const result = await r.run({
      program: `const f = () => 1; return { f };`,
      bindings: [],
    });
    expect(result.error?.kind).toBe("invalid-output");
    await r.dispose();
  });

  it("preserves line numbers of runtime errors in the original source", async () => {
    const r = makeRuntime();
    const result = await r.run({
      program: `const a = 1;\nconst b = 2;\nthrow new Error("boom at line 3");`,
      bindings: [],
    });
    expect(result.error?.kind).toBe("exception");
    expect(result.error?.message).toMatch(/line 3/);
    await r.dispose();
  });
});
