import { PERMISSION_LABEL, PermissionWrapper } from "./permission.js";

/**
 * ToolStatsRegistry — 中央工具调用统计
 *
 * 收集所有 PermissionWrapper 的统计数据，提供全局查询。
 *
 * 使用方式：
 *   1. 创建全局实例: const registry = new ToolStatsRegistry()
 *   2. 注册每个 Wrapper: registry.register(wrapper)
 *   3. 获取报告: registry.getReport()
 *
 * TODO: 由你实现 reset() 重置计数
 */
export class ToolStatsRegistry {
  private wrappers: PermissionWrapper[] = [];

  /** 注册一个 PermissionWrapper 到统计中 */
  register(wrapper: PermissionWrapper): void {
    this.wrappers.push(wrapper);
  }

  /** 获取全局调用总数 */
  getTotalCalls(): number {
    // 遍历 this.wrappers，累加每个 wrapper.stats.callCount
    return this.wrappers.reduce((sum, item)=>{
      return sum + item.stats.callCount
    }, 0)
  }

  /** 获取格式化报告（Markdown，适合追加到 Agent 回复末尾） */
  getReport(): string {
    if (this.wrappers.length === 0) return "";

    const lines: string[] = [];
    let totalCalls = 0;
    let totalErrors = 0;
    let totalDuration = 0;

    for (const w of this.wrappers) {
      const s = w.stats;
      // 只报告被调用过的工具 (s.callCount > 0)
      // 计算平均耗时
      // 记录总次数/总错误/总耗时
      if (s.callCount > 0){
        totalCalls += s.callCount
        totalDuration += s.totalDurationMs
        const avg = s.totalDurationMs / s.callCount
        totalErrors += s.errors
        lines.push(`| ${w.name} | ${s.callCount} | ${avg}ms | ${s.errors} | ${PERMISSION_LABEL[w.permission]} |`)
      }
    }

    if (totalCalls === 0) return "";

    // 返回类似以下格式的文本:
    //
    // ---
    // 📊 工具调用统计
    // | 工具 | 调用 | 平均耗时 | 错误 | 权限 |
    // |---|---|---|---|---|
    // | read_file | 3 | 12ms | 0 | 🔍 只读 |
    // | execute_command | 1 | 850ms | 0 | ⚠️ 高危 |
    //
    // 总计: 4 次调用, 总耗时 886ms

    return  [
      "📊 工具调用统计",
      "| 工具 | 调用 | 平均耗时 | 错误 | 权限 |",
      "|---|---|---|---|---|",
      ...lines,
      `总计: ${this.getTotalCalls()} 次调用, 总耗时 ${totalDuration}ms`,
    ].join("\n");
  }

  /**
   * 收集 sinceMs（performance.now() 单调钟）之后发生的所有工具调用窗口。
   * perf 用：任务开始前记下 taskStartWall，结束后据此取本任务内各工具的调用窗口，
   * 再在聚合层做「区间并集」求真实工具墙钟——解决并行 tool_call 各自累加导致的重复计耗时。
   * （--concurrency 模式多任务共享 registry 时会串进并发任务；聚合层另有钳制兜底，见 run.ts）
   */
  collectCallsSince(sinceMs: number): Map<string, { start: number; dur: number }[]> {
    const m = new Map<string, { start: number; dur: number }[]>();
    for (const w of this.wrappers) {
      const calls = w.stats.calls.filter((c) => c.start >= sinceMs);
      if (calls.length > 0) m.set(w.name, calls);
    }
    return m;
  }

  /** 重置所有工具的统计和熔断状态 */
  reset(): void {
    for (const w of this.wrappers) {
      w.reset();
    }
  }
}
