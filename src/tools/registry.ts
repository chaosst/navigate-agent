import { StructuredTool } from "@langchain/core/tools";
import { ShellTool } from "./shell.js";
import { ReadFileTool, WriteFileTool, EditFileTool } from "./filesystem.js";
import { ListFilesTool, SearchFilesTool } from "./search.js";
import { PermissionWrapper, type ToolPermission } from "./permission.js";
import type { ToolStatsRegistry } from "./stats-registry.js";
import { WebSearchTool } from "./websearch.js";

/**
 * 创建核心工具集。
 *
 * @param registry 传入共享 ToolStatsRegistry 时，每个工具被 PermissionWrapper
 *                 包装并注册——调用统计（次数/耗时/错误）会汇入 registry，
 *                 ToolFilter 也能按权限等级过滤。不传则返回裸工具（兼容
 *                 test.ts 等无统计诉求的调用方）。
 */
export function createTools(registry?: ToolStatsRegistry): StructuredTool[] {
  // 每个工具按权限等级包装；无 registry 时保持裸工具
  const wrap = (
    tool: StructuredTool,
    permission: ToolPermission,
  ): StructuredTool =>
    registry ? new PermissionWrapper(tool, permission, undefined, registry) : tool;

  return [
    wrap(new ShellTool(), "dangerous"),
    wrap(new ReadFileTool(), "read"),
    wrap(new WriteFileTool(), "write"),
    wrap(new EditFileTool(), "write"),
    wrap(new ListFilesTool(), "read"),
    wrap(new SearchFilesTool(), "read"),
    wrap(new WebSearchTool(), "read")
  ];
}
