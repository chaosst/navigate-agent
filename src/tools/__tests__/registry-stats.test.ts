import { describe, it, expect } from "vitest";
import { createTools } from "../registry.js";
import { ToolStatsRegistry } from "../stats-registry.js";
import { PermissionWrapper } from "../permission.js";
import { ToolFilter } from "../tool-filter.js";

describe("createTools with registry", () => {
  it("wraps tools as PermissionWrapper and registers them", () => {
    const registry = new ToolStatsRegistry();
    const tools = createTools(registry);

    // 6 个核心工具全部包装为 PermissionWrapper
    for (const t of tools) {
      expect(t).toBeInstanceOf(PermissionWrapper);
    }
    expect(tools.map((t) => t.name)).toEqual([
      "execute_command",
      "read_file",
      "write_file",
      "edit_file",
      "list_files",
      "search_files",
    ]);
  });

  it("reports stats after a tool is invoked", async () => {
    const registry = new ToolStatsRegistry();
    const tools = createTools(registry);

    // 找一个只读工具调用（read_file 不依赖真实文件也可走 schema 校验前）——直接用 list_files 报错也计入统计
    const list = tools.find((t) => t.name === "list_files") as PermissionWrapper;
    await list.invoke({ path: "/nonexistent-dir-for-stats-test" }).catch(() => {});

    const report = registry.getReport();
    expect(report).toContain("📊 工具调用统计");
    expect(report).toContain("list_files");
    expect(report).toContain("1"); // 至少一次调用
  });

  it("without registry returns bare tools (backward compatible)", () => {
    const tools = createTools();
    for (const t of tools) {
      expect(t).not.toBeInstanceOf(PermissionWrapper);
    }
  });

  it("ToolFilter works on wrapped tools (permission levels present)", () => {
    const registry = new ToolStatsRegistry();
    const tools = createTools(registry) as PermissionWrapper[];
    const filter = new ToolFilter();

    // 只读请求 → 只暴露 read 级
    const readOnly = filter.filter(tools, "帮我看看这个文件的内容");
    expect(readOnly.every((t) => t.permission === "read")).toBe(true);
    expect(readOnly.map((t) => t.name)).toEqual(["read_file", "list_files", "search_files"]);

    // 写请求 → read + write
    const write = filter.filter(tools, "帮我创建一份文档");
    expect(write.map((t) => t.name).sort()).toEqual(
      ["read_file", "list_files", "search_files", "write_file", "edit_file"].sort(),
    );

    // 命令请求 → 全量
    const dangerous = filter.filter(tools, "运行 npm install 并编译");
    expect(dangerous.length).toBe(6);
  });
});
