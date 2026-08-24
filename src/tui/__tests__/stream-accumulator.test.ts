import { describe, it, expect } from "vitest";
import { StreamAccumulator } from "../ptc.js";

describe("StreamAccumulator", () => {
  it("separates interim narration (outputPreview) from final answer (output)", () => {
    const acc = new StreamAccumulator();
    // 模拟 PTC stream 的真实 chunk 顺序：
    // 中间轮次 agent 叙述 → finalize 最终回答
    acc.push({ outputPreview: "我先查看项目结构" });
    acc.push({ outputPreview: "我已定位问题根源，开始重建页面" });
    acc.push({ output: "## 修改内容\n**style.css** 主题色已改为蓝色。\n\n📦 PTC 执行统计" });

    // 最终回答绝不含中间叙述
    expect(acc.output).toBe(
      "## 修改内容\n**style.css** 主题色已改为蓝色。\n\n📦 PTC 执行统计",
    );
    expect(acc.output).not.toContain("我已定位问题根源");
    // 预览包含中间叙述 + 最终回答（流式预览时 agent 说的话）
    expect(acc.previewText).toContain("我先查看项目结构");
    expect(acc.previewText).toContain("我已定位问题根源");
    expect(acc.previewText).toContain("主题色已改为蓝色");
  });

  it("keeps original interleaving order inside preview", () => {
    const acc = new StreamAccumulator();
    acc.push({ outputPreview: "A" });
    acc.push({ output: "B" });
    acc.push({ outputPreview: "C" });
    // 预览按到达顺序拼接
    expect(acc.previewText).toBe("ABC");
    // 最终回答只收 output
    expect(acc.output).toBe("B");
  });

  it("reset clears both buffers", () => {
    const acc = new StreamAccumulator();
    acc.push({ output: "x" });
    acc.reset();
    expect(acc.output).toBe("");
    expect(acc.previewText).toBe("");
  });
});
