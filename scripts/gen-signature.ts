#!/usr/bin/env node
import { createHmac, createHash } from "node:crypto";

/**
 * 为一次请求生成 HMAC 签名头,便于 curl 手动验证。
 * 用法:
 *   tsx scripts/gen-signature.ts --key sk-xxx --method POST --path /mcp \
 *     --body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
 * 输出 X-Timestamp / X-Nonce / X-Signature 三行,直接拼到 curl 请求头。
 */
const args = process.argv.slice(2);
function get(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const key = get("key");
if (!key) {
  console.error("Missing --key");
  process.exit(1);
}
const method = get("method") ?? "POST";
const path = get("path") ?? "/mcp";
const body = get("body") ?? "";
const bodyHash = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
const timestamp = String(Date.now());
const nonce = `n-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const canonical = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
const signature = createHmac("sha256", key).update(canonical).digest("hex");

console.log(`X-Timestamp: ${timestamp}`);
console.log(`X-Nonce: ${nonce}`);
console.log(`X-Signature: ${signature}`);
