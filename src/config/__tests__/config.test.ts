import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../index.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("loadConfig API key fields", () => {
  it("parses API_KEYS / API_IP_WHITELIST / window / trust proxy / failure limit", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.API_KEYS = "sk-a:2026-12-31T00:00:00Z,sk-b";
    process.env.API_IP_WHITELIST = "10.0.0.0/8,192.168.1.1";
    process.env.API_SIGNATURE_WINDOW_MS = "60000";
    process.env.API_TRUST_PROXY = "true";
    process.env.API_FAILURE_LIMIT = "10";
    process.env.API_FAILURE_WINDOW_MS = "120000";
    const cfg = loadConfig();
    expect(cfg.apiKeys).toBe("sk-a:2026-12-31T00:00:00Z,sk-b");
    expect(cfg.apiIpWhitelist).toBe("10.0.0.0/8,192.168.1.1");
    expect(cfg.apiSignatureWindowMs).toBe(60000);
    expect(cfg.apiTrustProxy).toBe(true);
    expect(cfg.apiFailureLimit).toBe(10);
    expect(cfg.apiFailureWindowMs).toBe(120000);
  });

  it("defaults window to 300000 and trust proxy to false", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    // 显式清空 API_* 变量:dotenv 不会覆盖已存在的环境变量,
    // 避免真实 .env 里的 API_KEYS 泄漏进本测试
    process.env.API_KEYS = "";
    process.env.API_KEY = "";
    process.env.API_IP_WHITELIST = "";
    process.env.API_SIGNATURE_WINDOW_MS = "";
    process.env.API_TRUST_PROXY = "";
    process.env.API_FAILURE_LIMIT = "";
    process.env.API_FAILURE_WINDOW_MS = "";
    const cfg = loadConfig();
    expect(cfg.apiSignatureWindowMs).toBe(300000);
    expect(cfg.apiTrustProxy).toBe(false);
    expect(cfg.apiKeys).toBe("");
    expect(cfg.apiFailureLimit).toBe(5);
    expect(cfg.apiFailureWindowMs).toBe(60000);
  });
});
