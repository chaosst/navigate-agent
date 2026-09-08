import { describe, expect, it } from "vitest";
import { parseAgentMode } from "../index.js";

describe("AGENT_MODE 解析（parseAgentMode）", () => {
  it("缺省/undefined/空串与非法值回退 normal", () => {
    [undefined, "", "foo", "Normal", "PLAN"].forEach((v) => {
      expect(parseAgentMode(v)).toBe("normal");
    });
  });

  it("识别 auto/plan/ptc", () => {
    expect(parseAgentMode("auto")).toBe("auto");
    expect(parseAgentMode("plan")).toBe("plan");
    expect(parseAgentMode("ptc")).toBe("ptc");
  });
});
