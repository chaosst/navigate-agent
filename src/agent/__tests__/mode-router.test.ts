import { describe, expect, it } from "vitest";
import { applyModeRules } from "../mode-router.js";

describe("mode-router 规则层", () => {
  it("硬 plan：多目标/多步中文信号", () => {
    const samples = [
      "把 src 下所有模块重构一遍，并按模块补单元测试",
      "帮我迁移 docs 到新目录并逐个更新引用",
      "整理 docs 目录并生成一份索引",
      "对整个项目做一次梳理，给出模块化建议",
    ];
    for (const s of samples) {
      const d = applyModeRules(s);
      expect(d?.mode, s).toBe("plan");
      expect(d?.source).toBe("rule");
    }
  });

  it("过短/寒暄 → normal（rule，不升档）", () => {
    for (const s of ["你好", "谢谢", "hi", "嗯", ""]) {
      const d = applyModeRules(s);
      expect(d?.mode, s).toBe("normal");
      expect(d?.source).toBe("rule");
    }
  });

  it("普通长指令 → 不确定（返回 null，交 LLM）", () => {
    const s = "今天天气怎么样？顺便帮我看看最近有哪些新的开源大模型发布";
    expect(applyModeRules(s)).toBeNull();
  });
});
