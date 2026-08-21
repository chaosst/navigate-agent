import { PermissionWrapper, ToolPermission, PERMISSION_LEVEL } from "./permission.js";

/**
 * ToolFilter — 动态工具过滤器
 *
 * 根据用户输入和对话上下文，决定哪些工具对 LLM 可见。
 * 目标：
 *   - 减少 LLM 决策空间 → 更准、更快
 *   - 降低 token 消耗
 *   - 按需暴露高危工具
 *
 * 使用方式：
 *   const filtered = filter.filter(allTools, userInput)
 *   llm.bindTools(filtered)
 */
export class ToolFilter {
  /**
   * 关键词 → 工具权限门槛
   * 输入命中关键词时，最低暴露该权限等级的工具。
   * 不命中时，只暴露 "read" 级工具。
   */
  private keywordMap: Array<{
    patterns: RegExp[];
    minPermission: ToolPermission;
  }> = [
    // shell/命令类 → 暴露 dangerous 级
    {
      patterns: [
        /shell/i, /command/i, /execute/i, /run\b/i, /terminal/i,
        /cmd/i, /bash/i, /powershell/i, /npm\b/i, /npx\b/i,
        /git\b/i, /docker/i, /ssh\b/i, /ping\b/i, /curl\b/i,
        /编译/i, /运行/i, /执行/i, /命令/i,
      ],
      minPermission: "dangerous",
    },
    // 写入/编辑类 → 暴露 write 级
    {
      patterns: [
        /write/i, /edit/i, /save/i, /create/i, /delete/i, /remove/i,
        /rename/i, /move/i, /copy/i, /modify/i, /update/i, /patch/i,
        /写入/i, /编辑/i, /保存/i, /创建/i, /删除/i, /修改/i,
        /新增/i, /添加/i,
      ],
      minPermission: "write",
    },
  ];

  /**
   * 过滤工具列表
   * @param tools  所有可用工具
   * @param input  当前用户输入
   * @returns      对 LLM 可见的工具子集
   */
  filter(
    tools: PermissionWrapper[],
    input: string,
  ): PermissionWrapper[] {
    // 计算所需的最低权限等级
    let requiredLevel = PERMISSION_LEVEL["read"]; // 默认只读

    for (const entry of this.keywordMap) {
      if (entry.patterns.some((p) => p.test(input))) {
        const level = PERMISSION_LEVEL[entry.minPermission];
        if (level > requiredLevel) {
          requiredLevel = level;
        }
      }
    }

    // 按权限等级过滤
    return tools.filter((t) => PERMISSION_LEVEL[t.permission] <= requiredLevel);
  }

  /**
   * 注册自定义关键词规则（供扩展用）
   */
  addRule(patterns: RegExp[], minPermission: ToolPermission): void {
    this.keywordMap.push({ patterns, minPermission });
  }
}
