import { describe, it, expect } from "vitest";
import { formatConsoleArgs, installConsoleGuard } from "../console-guard.js";

describe("formatConsoleArgs", () => {
  it("字符串原样拼接，对象走紧凑 JSON", () => {
    expect(formatConsoleArgs(["hello", { a: 1 }])).toBe('hello {"a":1}');
  });
  it("Error 取 stack（没有 stack 时取 message）", () => {
    expect(formatConsoleArgs([new Error("boom")])).toContain("boom");
  });
  it("循环引用不抛，兜底成 String()", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => formatConsoleArgs([cyc])).not.toThrow();
  });
  it("空参数 → 空串", () => {
    expect(formatConsoleArgs([])).toBe("");
  });
});

describe("installConsoleGuard", () => {
  it("把 console.* 改道到 sink（stdout 不再被写），并按级别映射", () => {
    const seen: Array<[string, string]> = [];
    const restore = installConsoleGuard({ sink: (level, msg) => seen.push([level, msg]) });
    try {
      console.log("hello", { a: 1 });
      console.warn("warn", 42);
      console.error(new Error("boom"));
    } finally {
      restore();
    }
    expect(seen[0]).toEqual(["info", 'hello {"a":1}']);
    expect(seen[1]).toEqual(["warning", "warn 42"]);
    expect(seen[2][0]).toBe("error");
    expect(seen[2][1]).toContain("boom");
  });

  it("restore() 归还原始 console 方法", () => {
    const before = console.log;
    const restore = installConsoleGuard({ sink: () => {} });
    expect(console.log).not.toBe(before);
    restore();
    expect(console.log).toBe(before);
  });

  it("重复 install 后 restore，仍能归还到最初的实现（幂等）", () => {
    const original = console.info;
    const r1 = installConsoleGuard({ sink: () => {} });
    const r2 = installConsoleGuard({ sink: () => {} });
    r2();
    r1();
    expect(console.info).toBe(original);
  });
});
