import { describe, it, expect } from "vitest";
import { TOKEN_TTL_MS, tokenManager } from "./token.js";

describe("TokenManager", () => {
  it("exports TTL = 30 minutes", () => {
    expect(TOKEN_TTL_MS).toBe(30 * 60 * 1000);
  });
  it("revoke invalidates an active token", () => {
    const t = tokenManager.generate();
    expect(tokenManager.validate(t)).toBe(true);
    tokenManager.revoke(t);
    expect(tokenManager.validate(t)).toBe(false);
  });
});
