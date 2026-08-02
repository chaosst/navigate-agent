import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../index.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("loadConfig API key fields", () => {
  it("parses API_KEYS / API_IP_WHITELIST / window / trust proxy", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.API_KEYS = "sk-a:2026-12-31T00:00:00Z,sk-b";
    process.env.API_IP_WHITELIST = "10.0.0.0/8,192.168.1.1";
    process.env.API_SIGNATURE_WINDOW_MS = "60000";
    process.env.API_TRUST_PROXY = "true";
    const cfg = loadConfig();
    expect(cfg.apiKeys).toBe("sk-a:2026-12-31T00:00:00Z,sk-b");
    expect(cfg.apiIpWhitelist).toBe("10.0.0.0/8,192.168.1.1");
    expect(cfg.apiSignatureWindowMs).toBe(60000);
    expect(cfg.apiTrustProxy).toBe(true);
  });

  it("defaults window to 300000 and trust proxy to false", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    const cfg = loadConfig();
    expect(cfg.apiSignatureWindowMs).toBe(300000);
    expect(cfg.apiTrustProxy).toBe(false);
    expect(cfg.apiKeys).toBe("");
  });
});
