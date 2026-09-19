/**
 * H5 访客登录记录（visit_events）
 *
 * 解决什么问题：游客入口（/api/login/guest）是**所有人共用同一个 guest 账号**，
 * 应用日志里只能看到「guest 来了」，无法分辨个体。本模块把每次登录当成一条原始事件
 * 落库（IP / 属地 / UA / 来源），再把「同一个账号」聚合回「不同的人」。
 *
 * 三条设计纪律：
 *   ① **绝不阻塞登录**：record() 是 fire-and-forget（DB 失败只 warn 一次），
 *      访客记录是观测需求，不能因为数据库抖动让人进不来；
 *   ② **属地异步补写**：属地要调外部接口（数百 ms 且有限额），登录路径只写 IP，
 *      解析成功后按 IP 批量回写历史行 —— 一次解析、永久缓存；
 *   ③ **失败保留原始事实**：解析失败只留空属地，IP 始终在库里，随时可补。
 *
 * 属地接口：ip-api.com（免费版**仅 HTTP**，HTTPS 会回 "SSL unavailable"；返回中文）。
 * 可经 TRAFFIC_GEO_ENDPOINT 换服务商（须同 schema），TRAFFIC_GEO_ENABLED=false 关闭。
 */
import type { Request } from "express";
import type { Pool } from "pg";

export type VisitKind = "guest" | "login";

/** 一次登录事件（写入侧） */
export interface VisitEntry {
  kind: VisitKind;
  ip: string;
  username?: string | null;
  role?: string | null;
  ua?: string | null;
  referer?: string | null;
  /** 链接渠道标识（登录页 ?src=xxx，用于「一人一链接」） */
  src?: string | null;
  /** 登录后落点（next） */
  landing?: string | null;
}

export interface GeoInfo {
  country: string;
  region: string;
  isp: string;
  /** 'ip-api' = 外部接口；'local' = 内网/保留地址 */
  source: string;
}

/** 明细行（读侧，字段名与表一致，便于直接渲染） */
export interface VisitEvent {
  id: number;
  ts: string;
  kind: string;
  username: string | null;
  role: string | null;
  ip: string;
  ipPrefix: string | null;
  region: string | null;
  isp: string | null;
  geoSource: string | null;
  device: string | null;
  isBot: boolean;
  referer: string | null;
  src: string | null;
  landing: string | null;
}

/** 按 IP 聚合后的「一个人」 */
export interface VisitSummary {
  ip: string;
  ipPrefix: string | null;
  region: string;
  isp: string;
  device: string;
  referer: string;
  src: string;
  username: string;
  firstTs: string;
  lastTs: string;
  hits: number;
  isBot: boolean;
  /** 与 TRAFFIC_SELF_IPS 匹配 —— 即「你自己」 */
  self: boolean;
}

export interface VisitStats {
  events: number;
  ips: number;
  /** 近 24 小时的事件数（不用「今日」：容器时区多为 UTC，按日切会与你的本地日期差 8 小时） */
  recent24h: number;
  /** 还没解析出属地的独立 IP 数 */
  pendingGeo: number;
  /** 是否配置了 TRAFFIC_SELF_IPS（决定前端「隐藏我自己」开关是否可用） */
  selfIpsConfigured: boolean;
}

export interface VisitQuery {
  /** 'guest'（默认口径，只看游客）| 'login' | 'all' */
  kind?: VisitKind | "all";
  includeBots?: boolean;
  limit?: number;
}

export interface VisitLog {
  /** 记录一次登录（fire-and-forget，绝不抛错） */
  record(entry: VisitEntry): void;
  /** 等待后台属地队列排空（测试 / 优雅停机用） */
  flush(): Promise<void>;
  listRecent(q?: VisitQuery): Promise<VisitEvent[]>;
  summary(q?: VisitQuery): Promise<VisitSummary[]>;
  stats(q?: VisitQuery): Promise<VisitStats>;
  pendingGeoCount(): Promise<number>;
  /** 等待式补全（限流串行）；返回本轮结果 */
  resolvePending(limit?: number): Promise<{ resolved: number; failed: number }>;
  /** 后台补全（同一时刻只跑一个任务），返回是否真的启动了 */
  backfill(limit?: number): boolean;
}

// ─────────────────────────── 纯函数（可直接单测） ───────────────────────────

/**
 * 归一化 IP：去掉 IPv4-mapped IPv6 前缀（`::ffff:1.2.3.4`）、zone id（`fe80::1%eth0`）与空白。
 * Express 在双栈监听下常给出 mapped 形式，不归一化会让同一个 IP 出现两种写法、
 * 也会让 isPrivateIp 把公网地址误判成 IPv6 内网段。
 */
export function normalizeIp(raw: string | null | undefined): string {
  let ip = (raw ?? "").trim();
  if (!ip) return "";
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) ip = mapped[1];
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  return ip;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 内网 / 保留 / 非法 / 未知地址：不该、也不必送外部接口解析 */
export function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (!ip || ip === "unknown") return true;
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::" || low === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return true; // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(low)) return true; // fe80::/10 链路本地
    return false;
  }
  const m = ip.match(IPV4_RE);
  if (!m) return true; // 非法格式：不查
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** 网段标识：IPv4 → `a.b.c.0/24`；IPv6 → 压缩形式前 4 组 + `::/64` */
export function ipPrefix(raw: string): string {
  const ip = normalizeIp(raw);
  if (!ip) return "";
  if (ip.includes(":")) {
    const head = ip.split("::")[0];
    const groups = head.split(":").filter(Boolean).slice(0, 4);
    return `${groups.join(":")}::/64`;
  }
  const p = ip.split(".");
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : ip;
}

function firstMatch(s: string, table: Array<[RegExp, string]>): string | null {
  for (const [re, label] of table) {
    const m = s.match(re);
    if (m) return m[1] ? `${label} ${m[1]}` : label;
  }
  return null;
}

// 顺序即优先级：微信/Edge 的 UA 里也含 Chrome 字样，必须先匹配更具体的
const BROWSERS: Array<[RegExp, string]> = [
  [/MicroMessenger\/(\d+)/i, "微信"],
  [/Edg\/(\d+)/, "Edge"],
  [/OPR\/(\d+)/, "Opera"],
  [/Chrome\/(\d+)/, "Chrome"],
  [/Firefox\/(\d+)/, "Firefox"],
  [/Version\/(\d+)[\d.]*\s.*Safari/, "Safari"],
  [/curl\/([\d.]+)/i, "curl"],
  [/Wget\/([\d.]+)/i, "wget"],
];

const OSES: Array<[RegExp, string]> = [
  [/Windows NT 10\.0/, "Windows 10/11"],
  [/Windows NT 6\.1/, "Windows 7"],
  [/Windows/, "Windows"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

/** UA → 人类可读的「Chrome 128 · Windows 10/11」 */
export function describeUa(ua?: string | null): string {
  const s = (ua ?? "").trim();
  if (!s) return "未知客户端";
  const browser = firstMatch(s, BROWSERS) ?? "其他客户端";
  const os = firstMatch(s, OSES);
  return os ? `${browser} · ${os}` : browser;
}

const BOT_RE =
  /bot\b|crawler|spider|slurp|headlesschrome|python-requests|python-urllib|aiohttp|axios|node-fetch|go-http-client|okhttp|scrapy|phantomjs|libwww|java\/|curl\/|wget\//i;

/** 是否明显是脚本 / 爬虫（无 UA 也算：真实浏览器一定会带 UA） */
export function isBotUa(ua?: string | null): boolean {
  const s = (ua ?? "").trim();
  if (!s) return true;
  return BOT_RE.test(s);
}

/** ip-api 的 country/regionName/city → 「中国·北京市」；相邻字段互相包含时只留长的那个 */
export function formatRegion(g: { country?: string | null; regionName?: string | null; city?: string | null }): string {
  const parts: string[] = [];
  for (const raw of [g.country, g.regionName, g.city]) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    if (parts.some((p) => p.includes(v) || v.includes(p))) continue;
    parts.push(v);
  }
  return parts.join("·");
}

/** TRAFFIC_SELF_IPS：「自己的 IP」列表，精确 IP 或 `a.b.c.0/24` 形式（与 ipPrefix 同口径） */
export function selfIpsFromEnv(env: string | undefined = process.env.TRAFFIC_SELF_IPS): string[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isSelfIp(raw: string, selfIps: readonly string[]): boolean {
  if (selfIps.length === 0) return false;
  const ip = normalizeIp(raw);
  if (!ip) return false;
  const prefix = ipPrefix(ip);
  return selfIps.some((entry) => (entry.includes("/") ? entry === prefix : entry === ip));
}

/** 从 Express 请求提取客户端 IP（依赖 app.set('trust proxy') —— 见 index.ts 的说明） */
export function clientIpOf(req: Request): string {
  return normalizeIp(req.ip ?? req.socket?.remoteAddress ?? "") || "unknown";
}

// ─────────────────────────────── 存储 + 解析 ───────────────────────────────

export interface VisitLogOptions {
  /** 覆写属地查询（测试注入 / 换服务商） */
  fetchGeo?: (ip: string) => Promise<GeoInfo | null>;
  /** 关闭外网属地查询（默认开启；TRAFFIC_GEO_ENABLED=false 亦可） */
  geoEnabled?: boolean;
  /** 相邻两次属地查询的最小间隔（默认 1200ms：守住 ip-api 免费版 45 次/分钟） */
  geoIntervalMs?: number;
  /** 单次属地查询超时（默认 3000ms） */
  geoTimeoutMs?: number;
  selfIps?: readonly string[];
  /** 日志出口（测试可静音） */
  warn?: (msg: string, err?: unknown) => void;
}

/** 免费版 ip-api 只支持 HTTP（HTTPS 回 "SSL unavailable"） */
const DEFAULT_GEO_ENDPOINT = "http://ip-api.com/json";
const GEO_FIELDS = "status,message,country,regionName,city,isp,query";
/** 解析失败的冷却时间：失败不写库，但要避免每次登录都重打接口 */
const GEO_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
/** 内存缓存上限（限的是「进程内已解析的 IP」，超出按插入顺序淘汰最老的） */
const GEO_CACHE_MAX = 1000;

const INSERT_SQL = `
  INSERT INTO visit_events
    (kind, username, role, ip, ip_prefix, geo_country, geo_region, geo_isp, geo_source,
     ua, device, is_bot, referer, src, landing)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;

const UPDATE_GEO_SQL = `
  UPDATE visit_events
     SET geo_country = $1, geo_region = $2, geo_isp = $3, geo_source = $4
   WHERE ip = $5 AND geo_region IS NULL`;

const SELECT_PENDING_SQL = `
  SELECT DISTINCT ip FROM visit_events
   WHERE geo_region IS NULL AND ip <> 'unknown'
   ORDER BY ip
   LIMIT $1`;

const COUNT_PENDING_SQL = `
  SELECT count(DISTINCT ip)::int AS cnt FROM visit_events
   WHERE geo_region IS NULL AND ip <> 'unknown'`;

const SELECT_RECENT_SQL = `
  SELECT id, ts, kind, username, role, ip, ip_prefix, geo_region, geo_isp, geo_source,
         device, is_bot, referer, src, landing
    FROM visit_events
   WHERE ($1::text IS NULL OR kind = $1)
     AND ($2::boolean OR is_bot = FALSE)
   ORDER BY ts DESC
   LIMIT $3`;

const SELECT_SUMMARY_SQL = `
  SELECT ip,
         max(ip_prefix)               AS ip_prefix,
         COALESCE(max(geo_region),'') AS region,
         COALESCE(max(geo_isp),'')    AS isp,
         COALESCE(max(device),'')     AS device,
         COALESCE(max(referer),'')    AS referer,
         COALESCE(max(src),'')        AS src,
         COALESCE(max(username),'')   AS username,
         min(ts)                      AS first_ts,
         max(ts)                      AS last_ts,
         count(*)::int                AS hits,
         bool_or(is_bot)              AS is_bot
    FROM visit_events
   WHERE ($1::text IS NULL OR kind = $1)
     AND ($2::boolean OR is_bot = FALSE)
   GROUP BY ip
   ORDER BY max(ts) DESC
   LIMIT $3`;

const SELECT_STATS_SQL = `
  SELECT count(*)::int AS events,
         count(DISTINCT ip)::int AS ips,
         count(*) FILTER (WHERE ts > now() - interval '24 hours')::int AS recent24h,
         count(DISTINCT ip) FILTER (WHERE geo_region IS NULL AND ip <> 'unknown')::int AS pending_geo
    FROM visit_events
   WHERE ($1::text IS NULL OR kind = $1)
     AND ($2::boolean OR is_bot = FALSE)`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));

async function fetchGeoFromApi(ip: string, endpoint: string, timeoutMs: number): Promise<GeoInfo | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = `${endpoint}/${encodeURIComponent(ip)}?lang=zh-CN&fields=${GEO_FIELDS}`;
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string; country?: string; regionName?: string; city?: string; isp?: string;
    };
    // status=fail：reserved range / 额度用尽 / 非法地址 —— 都按「未解析」处理
    if (data.status !== "success") return null;
    return {
      country: data.country ?? "",
      region: formatRegion(data),
      isp: data.isp ?? "",
      source: "ip-api",
    };
  } catch {
    return null; // 超时 / DNS / 出网被拦：保留原始 IP，稍后由 backfill 补
  } finally {
    clearTimeout(timer);
  }
}

export function createVisitLog(pool: Pool, opts: VisitLogOptions = {}): VisitLog {
  const warn = opts.warn ?? ((msg: string, err?: unknown) => console.warn(msg, err ?? ""));
  const geoIntervalMs = opts.geoIntervalMs ?? 1200;
  const geoEnabled =
    opts.geoEnabled ?? (process.env.TRAFFIC_GEO_ENABLED ?? "true").toLowerCase() !== "false";
  const endpoint = (process.env.TRAFFIC_GEO_ENDPOINT ?? DEFAULT_GEO_ENDPOINT).replace(/\/+$/, "");
  const selfIps = opts.selfIps ?? selfIpsFromEnv();
  const fetchGeo =
    opts.fetchGeo ?? ((ip: string) => fetchGeoFromApi(ip, endpoint, opts.geoTimeoutMs ?? 3000));

  const geoCache = new Map<string, GeoInfo>();
  const geoFailedAt = new Map<string, number>();
  const inflight = new Set<string>();
  /** 串行队列：所有属地查询排队执行，天然满足「最小间隔」的限流要求 */
  let chain: Promise<void> = Promise.resolve();
  let lastGeoAt = 0;
  let dbWarned = false;
  let backfillRunning = false;

  function noteDbError(err: unknown): void {
    if (dbWarned) return; // DB 挂了时不要每次登录都刷屏
    dbWarned = true;
    warn("[visit-log] 写入访客记录失败（登录不受影响，仅丢失这条记录）:", err);
  }

  function cacheGeo(ip: string, info: GeoInfo): void {
    if (geoCache.size >= GEO_CACHE_MAX) {
      const oldest = geoCache.keys().next().value;
      if (oldest !== undefined) geoCache.delete(oldest);
    }
    geoCache.set(ip, info);
  }

  /** 内网 / 保留地址的属地：直接给定值，不查外网 */
  function localGeo(ip: string): GeoInfo | null {
    if (!ip || ip === "unknown") return null;
    if (isPrivateIp(ip)) return { country: "", region: "内网 / 本地", isp: "", source: "local" };
    return null;
  }

  /** 只有「像样的公网地址」才值得送外部接口（unknown / 内网 / 非法一律跳过，白烧配额） */
  function shouldLookup(ip: string): boolean {
    return !!ip && ip !== "unknown" && !isPrivateIp(ip);
  }

  function geoFailedRecently(ip: string): boolean {
    const at = geoFailedAt.get(ip);
    return at !== undefined && Date.now() - at < GEO_FAIL_COOLDOWN_MS;
  }

  function scheduleGeo(ip: string): void {
    if (inflight.has(ip)) return;
    inflight.add(ip);
    chain = chain
      .then(async () => {
        const wait = lastGeoAt + geoIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastGeoAt = Date.now();
        const info = await fetchGeo(ip);
        inflight.delete(ip);
        if (!info) {
          geoFailedAt.set(ip, Date.now());
          return;
        }
        cacheGeo(ip, info);
        geoFailedAt.delete(ip);
        await pool
          .query(UPDATE_GEO_SQL, [info.country, info.region, info.isp, info.source, ip])
          .catch(noteDbError);
      })
      .catch((err) => {
        inflight.delete(ip);
        noteDbError(err);
      });
  }

  const kindParam = (q: VisitQuery): string | null => (!q.kind || q.kind === "all" ? null : q.kind);

  function record(entry: VisitEntry): void {
    try {
      const ip = normalizeIp(entry.ip) || "unknown";
      const local = localGeo(ip);
      const cached = geoCache.get(ip) ?? null;
      const geo = cached ?? local;
      if (local && !cached) cacheGeo(ip, local);

      void pool
        .query(INSERT_SQL, [
          entry.kind,
          entry.username ?? null,
          entry.role ?? null,
          ip,
          ipPrefix(ip) || null,
          geo?.country ?? null,
          geo?.region ?? null,
          geo?.isp ?? null,
          geo?.source ?? null,
          (entry.ua ?? "").slice(0, 500) || null,
          describeUa(entry.ua),
          isBotUa(entry.ua),
          (entry.referer ?? "").slice(0, 500) || null,
          (entry.src ?? "").slice(0, 200) || null,
          (entry.landing ?? "").slice(0, 300) || null,
        ])
        .catch(noteDbError);

      if (geoEnabled && shouldLookup(ip) && !cached && !geoFailedRecently(ip)) scheduleGeo(ip);
    } catch (err) {
      noteDbError(err); // 观测代码绝不能把登录带崩
    }
  }

  async function flush(): Promise<void> {
    await chain.catch(() => {});
  }

  async function listRecent(q: VisitQuery = {}): Promise<VisitEvent[]> {
    const { rows } = await pool.query(SELECT_RECENT_SQL, [
      kindParam(q),
      q.includeBots === true,
      q.limit ?? 100,
    ]);
    return rows.map((r) => ({
      id: Number(r.id),
      ts: toIso(r.ts),
      kind: String(r.kind ?? ""),
      username: r.username ?? null,
      role: r.role ?? null,
      ip: String(r.ip ?? ""),
      ipPrefix: r.ip_prefix ?? null,
      region: r.geo_region ?? null,
      isp: r.geo_isp ?? null,
      geoSource: r.geo_source ?? null,
      device: r.device ?? null,
      isBot: r.is_bot === true,
      referer: r.referer ?? null,
      src: r.src ?? null,
      landing: r.landing ?? null,
    }));
  }

  async function summary(q: VisitQuery = {}): Promise<VisitSummary[]> {
    const { rows } = await pool.query(SELECT_SUMMARY_SQL, [
      kindParam(q),
      q.includeBots === true,
      q.limit ?? 200,
    ]);
    return rows.map((r) => ({
      ip: String(r.ip ?? ""),
      ipPrefix: r.ip_prefix ?? null,
      region: String(r.region ?? ""),
      isp: String(r.isp ?? ""),
      device: String(r.device ?? ""),
      referer: String(r.referer ?? ""),
      src: String(r.src ?? ""),
      username: String(r.username ?? ""),
      firstTs: toIso(r.first_ts),
      lastTs: toIso(r.last_ts),
      hits: Number(r.hits ?? 0),
      isBot: r.is_bot === true,
      self: isSelfIp(String(r.ip ?? ""), selfIps),
    }));
  }

  async function stats(q: VisitQuery = {}): Promise<VisitStats> {
    const { rows } = await pool.query(SELECT_STATS_SQL, [kindParam(q), q.includeBots === true]);
    const r = rows[0] ?? {};
    return {
      events: Number(r.events ?? 0),
      ips: Number(r.ips ?? 0),
      recent24h: Number(r.recent24h ?? 0),
      pendingGeo: Number(r.pending_geo ?? 0),
      selfIpsConfigured: selfIps.length > 0,
    };
  }

  async function pendingGeoCount(): Promise<number> {
    const { rows } = await pool.query(COUNT_PENDING_SQL);
    return Number(rows[0]?.cnt ?? 0);
  }

  /** 等待式补全：串行 + 间隔，避免触发服务商限流；返回本轮成功/失败数 */
  async function resolvePending(limit = 20): Promise<{ resolved: number; failed: number }> {
    const { rows } = await pool.query(SELECT_PENDING_SQL, [limit]);
    let resolved = 0;
    let failed = 0;
    for (const row of rows) {
      const ip = normalizeIp(String(row.ip ?? ""));
      if (!shouldLookup(ip)) continue;
      const info = await fetchGeo(ip);
      if (!info) {
        geoFailedAt.set(ip, Date.now());
        failed += 1;
      } else {
        cacheGeo(ip, info);
        geoFailedAt.delete(ip);
        await pool
          .query(UPDATE_GEO_SQL, [info.country, info.region, info.isp, info.source, ip])
          .catch(noteDbError);
        resolved += 1;
      }
      if (geoIntervalMs > 0) await sleep(geoIntervalMs);
    }
    return { resolved, failed };
  }

  /** 后台补全：HTTP 请求不必等它（20 个 IP × 1.2s 间隔 > 20s，同步等会让人以为页面卡死） */
  function backfill(limit = 20): boolean {
    if (backfillRunning) return false;
    backfillRunning = true;
    void resolvePending(limit)
      .catch((err) => warn("[visit-log] 补全属地失败:", err))
      .finally(() => {
        backfillRunning = false;
      });
    return true;
  }

  return { record, flush, listRecent, summary, stats, pendingGeoCount, resolvePending, backfill };
}
