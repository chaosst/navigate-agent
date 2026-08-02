# 固定 API key + MCP 服务设计

日期:2026-08-02
状态:已确认(待实现)

## 背景与目标

当前 `npm run server` 启动后,RAG 接口(`/api/query`、`/api/query/fts` 等)依赖内存中的**动态 token**(30 分钟 TTL,需反复刷新)。这不适合作为 MCP 接口被 Claude Desktop / Cursor 等客户端稳定接入。

目标:在 navigate 自托管一个 **MCP 服务(Streamable HTTP 传输)**,把知识库查询注册成标准 MCP 工具;鉴权层使用**固定 API key**(`sk-<secret>` 格式,即 HMAC 密钥),并支持:

- 多把 key,每把独立过期时间
- 请求签名(HMAC)防重放
- 可选 IP 白名单(默认不启用)

现有 `/api/*` 动态 token 体系**保持不变**,向后兼容。

## 已确认的决策

| 决策点 | 结论 |
|--------|------|
| 暴露形式 | navigate 自托管 MCP 服务,挂载到现有 Express 的 `/mcp`(方案 A) |
| 工具范围 | `search_documents`、`search_keyword`、`list_documents`、`get_stats`(搜索 + 只读辅助) |
| API key 格式 | 单段 `sk-<secret>`,整串即 HMAC 密钥 |
| 多 key | 支持注册表,每把 key 独立过期(兼容 `API_KEY` 单 key 别名) |
| 鉴权模式 | 双模式:Bearer(标准 MCP 客户端)+ HMAC 签名(程序化调用,防重放) |
| 过期 | 绝对时间戳,逐 key 独立 |
| 签名密钥承载 | key 不上网,客户端仅用其计算签名,服务器逐把验证 HMAC |
| IP 白名单 | IP + CIDR,默认放行 |

## 配置

新增环境变量(写入 `.env.example` 与 `AppConfig`):

| 变量 | 含义 | 默认 |
|------|------|------|
| `API_KEYS` | 逗号分隔 `key[:expiresAt]`,如 `sk-aaa:2026-12-31T00:00:00Z,sk-bbb`;不带时间的 = 永不过期 | 空 → MCP 端点不启用 |
| `API_KEY` | 兼容别名:单把 key,无过期(若设置则并入注册表) | 空 |
| `API_IP_WHITELIST` | `1.2.3.4,10.0.0.0/8` 逗号分隔,支持 IP + CIDR | 空 → 全部放行 |
| `API_SIGNATURE_WINDOW_MS` | HMAC 时间戳容差窗(ms),同时决定 nonce 缓存保留时长 | `300000`(5 分钟) |
| `API_TRUST_PROXY` | 部署在反代后时读取 `X-Forwarded-For` | `false` |

## 鉴权中间件 `requireApiKey`(`src/server/api-key-auth.ts`)

按顺序校验,任一失败即 401(响应带具体 `reason` + `WWW-Authenticate: Bearer`):

1. **IP 白名单**(可选):解析 `req.ip`(受 `API_TRUST_PROXY` 控制),CIDR 匹配;IPv4-mapped-IPv6(`::ffff:1.2.3.4`)归一化。
2. **模式识别**:
   - 带 `X-Signature` → **HMAC 模式**
   - `Authorization: Bearer sk-xxx` → **Bearer 模式**
   - 都没有 → 401 `missing credentials`
3. **key 有效性**:查注册表;该 key 未过期(过期 → 401 `key expired`,逐 key 独立)。
4. **HMAC 模式追加**:
   - `X-Timestamp`(epoch ms)距当前 > `API_SIGNATURE_WINDOW_MS` → 401 `timestamp expired`
   - `X-Nonce` 在该 key 的窗口期缓存中已见 → 401 `replay detected`
   - 重算 `HMAC-SHA256(key, METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256_HEX(rawBody))`,与 `X-Signature` 常量时间比较 → 不匹配 401 `signature mismatch`
   - 逐把尝试活动 key 验证 HMAC,验中定位到具体 key(注册表通常 1~10 把,微秒级代价)。

### 签名细节

- **签名输入串**:`METHOD\nPATH\nTIMESTAMP_MS\nNONCE\nSHA256_HEX(rawBody)`,HMAC-SHA256 用该 key 作密钥,hex 输出。其中 `PATH` 为**不含 query string 的请求路径**(如 `/mcp`)。
- **HMAC 失败归因**:逐把 key 均未验中时,统一返回 `signature mismatch`,**不泄露** key 是否存在(与 `invalid key` 区分仅在 Bearer 模式)。
- **rawBody**:在 `express.json()` 之前注册轻量中间件,仅当请求带 `X-Signature` 时才缓冲原始字节;普通请求零开销。JSON 解析照常。
- **nonce 缓存**(`src/server/nonce-store.ts`):按 key 隔离,窗口期去重,到点清理,容量上限封顶。

## MCP 服务集成

### 新文件 `src/server/mcp.ts`

用 `McpServer`(`@modelcontextprotocol/sdk/server/mcp.js`)注册 4 个工具,处理函数直接调 `store` 方法:

| MCP 工具 | 参数(Zod) | 调用 | 返回 |
|----------|-----------|------|------|
| `search_documents` | `query`(必填)、`topK`(默认5)、`threshold`(可选) | `store.search(query, topK)` + threshold 过滤 | `RagResult[]` |
| `search_keyword` | `query`(必填)、`topK`(默认5) | `store.searchKeyword(query, topK)` | `RagResult[]` |
| `list_documents` | 无 | `store.listDocs()` | `RagDocument[]` |
| `get_stats` | 无 | `store.getCacheStats()` | 缓存统计 |

- 工具返回 `{ content: JSON.stringify(results), isError: false }`;出错返回 readable 错误。
- 调用日志:`[mcp] search_documents key=sk-aaa query=... took=12ms`。

### Express 挂载(`src/server/index.ts`)

```
app.use('/mcp', requireApiKey, mcpTransportHandler)
```

- `StreamableHTTPServerTransport`(SDK 官方 Express 模式):POST = JSON-RPC,GET = SSE 流,DELETE = 结束会话。按 `Mcp-Session-Id` 维护 session→transport 映射,无会话头则无状态处理。
- **鉴权先于传输**:失败返回 401,客户端收到明确鉴权错误。
- 现有 `/api/*` 不动。

### 依赖

`@modelcontextprotocol/sdk` 已存在(^1.29.0),无需新增。

## 错误处理

| 场景 | 响应 |
|------|------|
| 无凭证 | `401 {error:"missing credentials"}` |
| key 不存在(Bearer 模式查表) | `401 {error:"invalid key"}` |
| key 过期 | `401 {error:"key expired", key:"sk-aaa"}` |
| 时间戳超窗 | `401 {error:"timestamp expired"}` |
| nonce 重放 | `401 {error:"replay detected"}` |
| 签名不匹配 | `401 {error:"signature mismatch"}` |
| IP 不在白名单 | `401 {error:"ip not allowed"}` |
| 工具执行出错 | JSON-RPC 错误结果(HTTP 200) |

统一带 `WWW-Authenticate: Bearer`。绝不泄露 HMAC 密钥或签名细节。

## 日志

- `[mcp-auth] 401 reason=key expired key=sk-aaa ip=127.0.0.1`
- `[mcp-auth] ok key=sk-bbb mode=bearer ip=127.0.0.1` / `mode=hmac`(不打 query 内容)
- `[mcp] search_documents key=sk-aaa took=12ms`
- key 过期时 `[mcp-auth] WARNING: key sk-aaa expired at ...`

全部走现有 `console` + `agent.log` 体系。

## 验证

1. **签名单元测试**:正确签名通过;篡改 body / 过期时间戳 / 重放 nonce / 错 key → 各 401。
2. **IP 白名单单测**:精确 IP、CIDR、IPv4-mapped-IPv6、未配置放行。
3. **集成测试**:起服后 `scripts/gen-signature.ts` 生成签名请求打到 `/mcp` 成功;Bearer 模式 curl 成功;坏 key / 过期 key / 重放 → 401。
4. **真实 MCP 客户端连通**:SDK Client 连 `/mcp`,逐个调 4 工具断言结果字段。

## 交付文件

- 新:`src/server/api-key-auth.ts`、`src/server/key-store.ts`、`src/server/nonce-store.ts`、`src/server/mcp.ts`、`scripts/gen-signature.ts`
- 改:`src/config/index.ts`、`src/server/index.ts`、`.env.example`
- 测试:`src/server/__tests__/api-key-auth.test.ts`、`src/server/__tests__/mcp.integration.test.ts`
