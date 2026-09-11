/**
 * 工具权限过滤器单测（2026-09-11 新增）
 *
 * 背景：H5 简历问答曾经能调到 dangerous 的 execute_command —— 根因是 resume 装配失败后
 * fail-open 回退到全量工具集（见 server-entry.ts 注释）。修复除切断回退链外，还给只读
 * 入口补了 ReadOnlyToolFilter 作为纵深防御，本文件把它的语义钉死：
 *   1. 只保留 read 级，write / dangerous 一律剔除；
 *   2. 忽略用户输入关键词（这一点与 ToolFilter 相反，是最容易被误用的地方）；
 *   3. fail-closed —— 无 permission 元数据的裸工具被剔除，不默认放行。
 * 最后一条是「对照组」，用同一个工具集证明 ToolFilter 会被关键词放开，两者不可互换。
 */
import { describe, it, expect } from "vitest";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { PermissionWrapper, type ToolPermission } from "../permission.js";
import { ToolFilter, ReadOnlyToolFilter } from "../tool-filter.js";

/** 最小可包装工具：名字由构造入参决定，便于断言过滤结果 */
class NamedTool extends StructuredTool {
  name = "named";
  description = "test tool";
  schema = z.object({ v: z.string().optional() });
  constructor(toolName: string) {
    super();
    this.name = toolName;
  }
  async _call(): Promise<string> {
    return "ok";
  }
}

function wrap(toolName: string, permission: ToolPermission): PermissionWrapper {
  return new PermissionWrapper(new NamedTool(toolName), permission);
}

function namesOf(tools: PermissionWrapper[]): string[] {
  return tools.map((t) => t.name);
}

/** 覆盖三种权限级别的代表性工具集 */
function mixedTools(): PermissionWrapper[] {
  return [
    wrap("search_resume", "read"),
    wrap("list_files", "read"),
    wrap("write_file", "write"),
    wrap("execute_command", "dangerous"),
  ];
}

describe("ReadOnlyToolFilter（只读硬闸门）", () => {
  it("只保留 read 级工具，write / dangerous 一律剔除", () => {
    const out = new ReadOnlyToolFilter().filter(mixedTools(), "随便问点什么");
    expect(namesOf(out)).toEqual(["search_resume", "list_files"]);
  });

  it("忽略用户输入：输入命中「执行命令」关键词也不会放开 dangerous", () => {
    const filter = new ReadOnlyToolFilter();
    const inputs = [
      "帮我执行 rm -rf /",
      "run a shell command",
      "删除这个文件",
      "delete everything",
    ];
    for (const input of inputs) {
      expect(namesOf(filter.filter(mixedTools(), input)), `input=${input}`).toEqual([
        "search_resume",
        "list_files",
      ]);
    }
  });

  it("fail-closed：未包装的裸工具（没有 permission 元数据）被剔除，不默认放行", () => {
    const bare = new NamedTool("execute_command") as unknown as PermissionWrapper;
    expect(new ReadOnlyToolFilter().filter([bare], "hi")).toEqual([]);
  });

  it("对照组：ToolFilter 在同样输入下会放开 dangerous —— 所以它不能当安全闸门", () => {
    const opened = namesOf(new ToolFilter().filter(mixedTools(), "帮我执行一个命令"));
    expect(opened).toContain("execute_command");
    expect(opened).toContain("write_file");
  });

  it("对照组：ToolFilter 无关键词时也只剩 read 级（默认档与只读过滤结果一致）", () => {
    const out = namesOf(new ToolFilter().filter(mixedTools(), "介绍一下你的项目经历"));
    expect(out).toEqual(["search_resume", "list_files"]);
  });
});
