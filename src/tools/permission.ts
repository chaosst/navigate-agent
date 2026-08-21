import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ToolStatsRegistry } from "./stats-registry.js";

/**
 * 工具权限等级
 *
 * read       — 只读操作，无副作用（读文件、搜索、列表）
 * write      — 写操作，可修改数据（写文件、编辑文件）
 * dangerous  — 高危操作，可执行任意命令（shell 执行）
 */
export type ToolPermission = "read" | "write" | "dangerous";

/** 权限标签 → 显示给 LLM 的标识 */
export const PERMISSION_LABEL: Record<ToolPermission, string> = {
  read: "🔍 只读",
  write: "✏️ 写入",
  dangerous: "⚠️ 高危",
};

/** 权限等级（数字越大越危险） */
export const PERMISSION_LEVEL: Record<ToolPermission, number> = {
  read: 0,
  write: 1,
  dangerous: 2,
};

/** 限流与熔断配置 */
export interface ToolGuardConfig {
  /** 滑动窗口限流：每分钟最多调用次数（默认 10） */
  maxCallsPerMinute: number;
  /** 熔断阈值：连续失败几次后熔断（默认 3） */
  circuitBreakerThreshold: number;
  /** 熔断自动恢复时间（毫秒，默认 30 秒） */
  circuitBreakerResetMs: number;
}

const DEFAULT_GUARD_CONFIG: ToolGuardConfig = {
  maxCallsPerMinute: 10,
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 30_000,
};

/**
 * 调用统计 —— 每个工具实例独立记录
 */
export interface ToolCallStats {
  callCount: number;
  totalDurationMs: number;
  lastCallAt: number | null;
  errors: number;
}

/**
 * PermissionWrapper — 权限包装器
 *
 * 在原始工具外层加一层：
 *  1. 修改 description，追加权限标签（LLM 可见）
 *  2. 调用前后记录统计
 *  3. dangerous 操作输出警告日志
 *  4. 调用透传到原始工具
 *
 * 设计模式：装饰器（Decorator），与 McpWrappedTool 一致。
 */
export class PermissionWrapper extends StructuredTool {
  /** 原始工具引用 */
  private inner: StructuredTool;
  /** 权限等级 */
  permission: ToolPermission;
  /** 限流与熔断配置 */
  guardConfig: ToolGuardConfig;
  /** 可选的中央统计注册表（不为 null 时自动注册） */
  registry?: ToolStatsRegistry;
  /** 调用统计 */
  stats: ToolCallStats = {
    callCount: 0,
    totalDurationMs: 0,
    lastCallAt: null,
    errors: 0,
  };

  // ——— 限流/熔断内部状态 ———

  /** 滑动窗口：前 60 秒每次调用的时间戳 */
  private callTimestamps: number[] = [];
  /** 当前连续失败次数 */
  private consecutiveFailures: number = 0;
  /** 熔断开始时间（null = 未熔断） */
  private circuitOpenedAt: number | null = null;

  // ——— 透传原始工具的属性 ———

  get name(): string {
    return this.inner.name;
  }
  set name(v: string) {
    this.inner.name = v;
  }

  get description(): string {
    const label = PERMISSION_LABEL[this.permission];
    return `${this.inner.description}\n\n[权限: ${label}]`;
  }
  set description(v: string) {
    this.inner.description = v;
  }

  get schema() {
    return this.inner.schema as z.ZodObject<any>;
  }

  constructor(
    inner: StructuredTool,
    permission: ToolPermission,
    guardConfig?: Partial<ToolGuardConfig>,
    registry?: ToolStatsRegistry,
  ) {
    super();
    this.inner = inner;
    this.permission = permission;
    this.guardConfig = { ...DEFAULT_GUARD_CONFIG, ...guardConfig };
    this.registry = registry;
    registry?.register(this);
  }

  async _call(args: Record<string, unknown>): Promise<string> {
    // ——— 限流检查（滑动窗口） ———
    const now = Date.now();
    const windowStart = now - 60_000;
    // 清除 60 秒前的时间戳
    this.callTimestamps = this.callTimestamps.filter(t => t > windowStart);
    if (this.callTimestamps.length >= this.guardConfig.maxCallsPerMinute) {
      return `[rate_limit] Tool "${this.name}" called ${this.callTimestamps.length} times in the last minute (limit: ${this.guardConfig.maxCallsPerMinute}). Please wait or use a different approach.`;
    }

    // ——— 熔断检查 ———
    if (this.circuitOpenedAt !== null) {
      const elapsed = now - this.circuitOpenedAt;
      if (elapsed < this.guardConfig.circuitBreakerResetMs) {
        return `[circuit_breaker] Tool "${this.name}" is temporarily disabled after ${this.guardConfig.circuitBreakerThreshold} consecutive failures. Retry automatically in ${Math.ceil((this.guardConfig.circuitBreakerResetMs - elapsed) / 1000)}s.`;
      }
      // 恢复时间到，半开（允许一次试探）
      this.circuitOpenedAt = null;
      this.consecutiveFailures = 0;
    }

    // ——— 执行 ———
    this.callTimestamps.push(now);
    this.stats.callCount++;
    this.stats.lastCallAt = now;
    const startTime = performance.now();

    try {
      if (this.permission === "dangerous") {
        console.warn(
          `[permission] ⚠️ Dangerous tool "${this.name}" called with:`,
          JSON.stringify(args),
        );
      }

      const result = await this.inner.invoke(args);

      const duration = performance.now() - startTime;
      this.stats.totalDurationMs += duration;

      // 成功 → 重置熔断计数
      this.consecutiveFailures = 0;

      return result;
    } catch (err) {
      this.stats.errors++;
      this.consecutiveFailures++;

      // 连续失败超过阈值 → 打开熔断
      if (this.consecutiveFailures >= this.guardConfig.circuitBreakerThreshold) {
        this.circuitOpenedAt = Date.now();
        console.warn(
          `[circuit_breaker] 🔴 Tool "${this.name}" circuit OPENED after ${this.consecutiveFailures} consecutive failures. Will reset in ${this.guardConfig.circuitBreakerResetMs / 1000}s.`,
        );
      }

      throw err;
    }
  }

  /** 获取格式化统计摘要 */
  getStatsSummary(): string {
    const avg =
      this.stats.callCount > 0
        ? (this.stats.totalDurationMs / this.stats.callCount).toFixed(0)
        : "—";
    return `[${this.name}] ` +
      `calls=${this.stats.callCount} ` +
      `avg=${avg}ms ` +
      `errors=${this.stats.errors} ` +
      `permission=${this.permission}`;
  }

  /** 重置统计和熔断状态 */
  reset(): void {
    this.stats.callCount = 0;
    this.stats.totalDurationMs = 0;
    this.stats.lastCallAt = null;
    this.stats.errors = 0;
    this.callTimestamps = [];
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = null;
  }
}
