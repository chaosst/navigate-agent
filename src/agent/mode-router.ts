/**
 * mode-router.ts — auto 编排档的路由决策。
 *
 * 决策流水线（全部 fail-open 向 normal，宁可不升档不乱升档）：
 *   applyModeRules 硬规则 →（未命中且过长）LLM 兜底分类 → 失败回退 normal。
 * 见 docs/superpowers/specs/2026-09-08-auto-mode-escalation-design.md §2。
 */
import type { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

/** auto 档可路由到的实际档位（MVP：ptc 不进自动路由） */
export type RoutableMode = "normal" | "plan";
/** 决策来源 */
export type RouteSource = "rule" | "llm" | "fallback";

export interface RouteDecision {
  mode: RoutableMode;
  reason: string;
  source: RouteSource;
}

export interface RouteContext {
  /** 上一轮自动路由生效档（会话内跨轮），供接续语决策 */
  lastMode?: RoutableMode;
}

/** 低于该长度的输入视为寒暄/单步，直接 normal 且不调 LLM */
export const SHORT_INPUT_NORMAL = 12;
/** 低于该长度且命中接续词 + 上轮 plan → 保持 plan（避免 plan 引擎每轮重规划 churn） */
export const CONTINUE_INPUT_NORMAL = 8;

/** 多目标/多步 → plan 的信号词表（第一版，可迭代增补） */
export interface PlanRule {
  patterns: RegExp[];
  /** 命中该规则所需的最小输入长度（字符）；默认 0 */
  minLength?: number;
  reason: string;
}

export const PLAN_RULES: PlanRule[] = [
  {
    patterns: [
      /重构|迁移|整合|规划|分步|计划|部署|梳理|归档|模块化|批量|逐个|分别对|对每|所有文件|整个项目/,
      /跨\s*(目录|文件|模块|项目)/,
    ],
    reason: "多目标/多步意图，宜先规划",
  },
  {
    patterns: [
      /先\s*.{0,20}\s*再\s*.{0,20}\s*(然后|最后)/,
      /整理\s*.{0,30}\s*(并|并且|然后|同时)/,
      /(遍历|处理|检查)\s*.{0,20}\s*(每个|所有|全部)/,
    ],
    reason: "含先后顺序/组合动作，需分步执行",
  },
  {
    // 长指令 + 执行动作词 → 大概率多步
    minLength: 60,
    patterns: [
      /(读取|下载|抓取|爬取|生成|编写|创建|修改|比较|统计|汇总|整理|分析).*/,
    ],
    reason: "长指令含执行动作，可能需先规划",
  },
];

/**
 * 硬规则快判。返回非空 = 已决策（source: "rule"）；返回 null = 需 LLM 兜底。
 */
export function applyModeRules(input: string): RouteDecision | null {
  const text = input.trim();
  if (!text) return { mode: "normal", reason: "空输入", source: "rule" };

  for (const rule of PLAN_RULES) {
    if (text.length < (rule.minLength ?? 0)) continue;
    if (rule.patterns.some((p) => p.test(text))) {
      return { mode: "plan", reason: rule.reason, source: "rule" };
    }
  }

  if (text.length < SHORT_INPUT_NORMAL) {
    return { mode: "normal", reason: "输入过短，按普通问答处理", source: "rule" };
  }

  return null; // 规则未命中且不短 → 交给 LLM 兜底分类
}
