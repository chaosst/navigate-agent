/**
 * 访客记录（visit_events）单测
 *
 * 这一层是纯逻辑 + 注入依赖，不需要 PG/网络：
 *   · 纯函数（IP 归一化 / 内网判定 / 网段 / UA 解析 / 属地拼接 / 自己识别）；
 *   · createVisitLog 的写入与解析行为 —— 用假 Pool 捕获 SQL、用注入的 fetchGeo 控制成功/失败。
 *
 * 重点覆盖几条容易写错的边界：
 *   ① `::ffff:1.2.3.4`（Express 双栈监听下的常见形态）必须归一化，否则会被当成 IPv6 内网段而跳过解析；
 *   ② 内网 / unknown 地址**不能**送外部接口（既无意义又白烧配额）；
 *   ③ 同一个 IP 只解析一次（进程内缓存），失败要进冷却期但**不能丢记录**；
 *   ④ DB 写失败只告警一次且绝不影响调用方 —— record() 是在登录成功路径上被调用的。
 */
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createVisitLog,
  describeUa,
  formatRegion,
  ipPrefix,
  isBotUa,
  isPrivateIp,
  isSelfIp,
  normalizeIp,
  selfIpsFromEnv,
  type GeoInfo,
} from "../visit-log.js";

const UA_CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const UA_EDGE_WIN = `${UA_CHROME_WIN} Edg/128.0.0.0`;
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const UA_WECHAT =
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.40.2420";

describe("normalizeIp", () => {
  it("IPv4-mapped IPv6 / zone id / 空白都归一化", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("  1.2.3.4 ")).toBe("1.2.3.4");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });
  it("空值返回空串（由调用方兜底成 unknown）", () => {
    expect(normalizeIp("")).toBe("");
    expect(normalizeIp(undefined)).toBe("");
    expect(normalizeIp(null)).toBe("");
  });
});

describe("isPrivateIp", () => {
  it("内网 / 保留段判为 true", () => {
    for (const ip of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "unknown", "", "999.1.1.1"]) {
      expect(isPrivateIp(ip), `${ip} 应判为不可外查`).toBe(true);
    }
  });
  it("公网地址判为 false", () => {
    for (const ip of ["8.8.8.8", "220.181.38.148", "172.32.0.1", "2001:db8::1"]) {
      expect(isPrivateIp(ip), `${ip} 应判为可外查`).toBe(false);
    }
  });
  it("mapped 形态的公网地址必须先归一化再判定（否则会被误当 IPv6 内网段）", () => {
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
  });
});

describe("ipPrefix", () => {
  it("IPv4 取 /24", () => {
    expect(ipPrefix("1.2.3.4")).toBe("1.2.3.0/24");
  });
  it("IPv6 取压缩形式前 4 组", () => {
    expect(ipPrefix("2001:db8::1")).toBe("2001:db8::/64");
    expect(ipPrefix("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:0db8:85a3:0000::/64");
  });
  it("空值返回空串", () => {
    expect(ipPrefix("")).toBe("");
  });
});

describe("describeUa", () => {
  it("按「浏览器 · 系统」输出", () => {
    expect(describeUa(UA_CHROME_WIN)).toBe("Chrome 128 · Windows 10/11");
    expect(describeUa(UA_IPHONE)).toBe("Safari 17 · iOS");
  });
  it("顺序敏感：Edge / 微信的 UA 里也含 Chrome 字样，必须识别成具体那个", () => {
    expect(describeUa(UA_EDGE_WIN)).toBe("Edge 128 · Windows 10/11");
    expect(describeUa(UA_WECHAT)).toBe("微信 8 · Android");
  });
  it("空 UA 给可读兜底", () => {
    expect(describeUa("")).toBe("未知客户端");
    expect(describeUa(undefined)).toBe("未知客户端");
  });
});

describe("isBotUa", () => {
  it("真实浏览器不算脚本", () => {
    expect(isBotUa(UA_CHROME_WIN)).toBe(false);
    expect(isBotUa(UA_IPHONE)).toBe(false);
  });
  it("爬虫 / 命令行工具 / 空 UA 都算", () => {
    expect(isBotUa("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBotUa("curl/8.4.0")).toBe(true);
    expect(isBotUa("")).toBe(true);
  });
});

describe("formatRegion", () => {
  it("国省市拼接，相邻字段互相包含时去重", () => {
    expect(formatRegion({ country: "中国", regionName: "北京市", city: "北京" })).toBe("中国·北京市");
    expect(formatRegion({ country: "韩国", regionName: "京畿道", city: "Gunpo" })).toBe("韩国·京畿道·Gunpo");
  });
  it("字段缺失时只拼有的", () => {
    expect(formatRegion({ country: "中国" })).toBe("中国");
    expect(formatRegion({})).toBe("");
  });
});

describe("isSelfIp / selfIpsFromEnv", () => {
  it("支持精确 IP 与 /24 网段两种写法", () => {
    expect(isSelfIp("203.0.113.5", ["203.0.113.5"])).toBe(true);
    expect(isSelfIp("203.0.113.6", ["203.0.113.5"])).toBe(false);
    expect(isSelfIp("203.0.113.9", ["203.0.113.0/24"])).toBe(true);
    expect(isSelfIp("203.0.114.9", ["203.0.113.0/24"])).toBe(false);
    expect(isSelfIp("203.0.113.5", [])).toBe(false);
  });
  it("env 解析：逗号分隔、去空白、丢空项", () => {
    expect(selfIpsFromEnv(" 1.2.3.4 , ,5.6.7.0/24 ")).toEqual(["1.2.3.4", "5.6.7.0/24"]);
    expect(selfIpsFromEnv("")).toEqual([]);
    expect(selfIpsFromEnv(undefined)).toEqual([]);
  });
});

// ─────────────────────────────── 存储层 ───────────────────────────────

interface Call { sql: string; params?: unknown[] }

/** 假 Pool：捕获 SQL，并按语句类型返回可控结果 */
function fakePool(opts: { pending?: string[]; stats?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/INSERT INTO visit_events/.test(sql)) return { rows: [] };
      if (/UPDATE visit_events/.test(sql)) return { rows: [] };
      if (/SELECT DISTINCT ip FROM visit_events/.test(sql)) {
        return { rows: (opts.pending ?? []).map((ip) => ({ ip })) };
      }
      if (/AS events/.test(sql)) return { rows: [opts.stats ?? {}] };
      if (/cnt FROM visit_events/.test(sql)) return { rows: [{ cnt: 0 }] };
      if (/GROUP BY ip/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  } as unknown as Pool;
  return {
    pool,
    calls,
    inserts: () => calls.filter((c) => /INSERT INTO visit_events/.test(c.sql)),
    updates: () => calls.filter((c) => /UPDATE visit_events/.test(c.sql)),
  };
}

const silent = (): void => {};
const geoBeijing: GeoInfo = { country: "中国", region: "中国·北京市", isp: "联通", source: "ip-api" };

describe("createVisitLog.record", () => {
  it("公网 IP：先落行（属地留空）→ 解析成功后按 IP 回写", async () => {
    const { pool, inserts, updates } = fakePool();
    const fetchGeo = vi.fn(async () => geoBeijing);
    const log = createVisitLog(pool, { fetchGeo, geoIntervalMs: 0, warn: silent });

    log.record({
      kind: "guest", ip: "220.181.38.148", ua: UA_CHROME_WIN,
      referer: "https://www.zhipin.com/", src: "boss", landing: "/resume",
    });
    await log.flush();

    expect(inserts()).toHaveLength(1);
    const p = inserts()[0].params!;
    expect(p[0]).toBe("guest");
    expect(p[3]).toBe("220.181.38.148");
    expect(p[4]).toBe("220.181.38.0/24");
    expect(p[6]).toBeNull(); // geo_region 先空着，等异步回写
    expect(p[10]).toBe("Chrome 128 · Windows 10/11");
    expect(p[11]).toBe(false); // is_bot
    expect(p[12]).toBe("https://www.zhipin.com/");
    expect(p[13]).toBe("boss");
    expect(p[14]).toBe("/resume");

    expect(updates()).toHaveLength(1);
    expect(updates()[0].params).toEqual(["中国", "中国·北京市", "联通", "ip-api", "220.181.38.148"]);
    expect(String(updates()[0].sql)).toContain("geo_region IS NULL"); // 不覆盖已解析的值
  });

  it("内网 IP：直接写「内网 / 本地」，绝不调外部接口", async () => {
    const { pool, inserts } = fakePool();
    const fetchGeo = vi.fn(async () => geoBeijing);
    const log = createVisitLog(pool, { fetchGeo, geoIntervalMs: 0, warn: silent });

    log.record({ kind: "guest", ip: "192.168.1.5", ua: UA_CHROME_WIN });
    await log.flush();

    expect(fetchGeo).not.toHaveBeenCalled();
    const p = inserts()[0].params!;
    expect(p[6]).toBe("内网 / 本地");
    expect(p[8]).toBe("local");
  });

  it("空 / unknown IP：记录仍在，属地留空且不外查", async () => {
    const { pool, inserts } = fakePool();
    const fetchGeo = vi.fn(async () => geoBeijing);
    const log = createVisitLog(pool, { fetchGeo, geoIntervalMs: 0, warn: silent });

    log.record({ kind: "login", ip: "", ua: "" });
    await log.flush();

    expect(fetchGeo).not.toHaveBeenCalled();
    const p = inserts()[0].params!;
    expect(p[3]).toBe("unknown");
    expect(p[6]).toBeNull();
    expect(p[11]).toBe(true); // 空 UA → 标记为脚本
  });

  it("同一个 IP 只解析一次；后续记录直接带上缓存到的属地", async () => {
    const { pool, inserts, updates } = fakePool();
    const fetchGeo = vi.fn(async () => geoBeijing);
    const log = createVisitLog(pool, { fetchGeo, geoIntervalMs: 0, warn: silent });

    log.record({ kind: "guest", ip: "8.8.8.8", ua: UA_CHROME_WIN });
    await log.flush();
    log.record({ kind: "guest", ip: "8.8.8.8", ua: UA_CHROME_WIN });
    await log.flush();

    expect(fetchGeo).toHaveBeenCalledTimes(1);
    expect(updates()).toHaveLength(1);
    expect(inserts()[1].params![6]).toBe("中国·北京市");
  });

  it("解析失败：不写属地、记录照落，冷却期内不重复打接口", async () => {
    const { pool, inserts, updates } = fakePool();
    const fetchGeo = vi.fn(async () => null);
    const log = createVisitLog(pool, { fetchGeo, geoIntervalMs: 0, warn: silent });

    log.record({ kind: "guest", ip: "1.2.3.4", ua: UA_CHROME_WIN });
    await log.flush();
    log.record({ kind: "guest", ip: "1.2.3.4", ua: UA_CHROME_WIN });
    await log.flush();

    expect(fetchGeo).toHaveBeenCalledTimes(1);
    expect(updates()).toHaveLength(0);
    expect(inserts()).toHaveLength(2);
    expect(inserts()[1].params![6]).toBeNull();
  });

  it("geoEnabled=false：完全不外查（离线 / 内网部署）", async () => {
    const { pool } = fakePool();
    const fetchGeo = vi.fn(async () => geoBeijing);
    const log = createVisitLog(pool, { fetchGeo, geoEnabled: false, geoIntervalMs: 0, warn: silent });

    log.record({ kind: "guest", ip: "8.8.8.8", ua: UA_CHROME_WIN });
    await log.flush();
    expect(fetchGeo).not.toHaveBeenCalled();
  });

  it("DB 写入失败：不抛错（调用点在登录成功路径上），且只告警一次", async () => {
    const warns: string[] = [];
    const pool = {
      query: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
    } as unknown as Pool;
    const log = createVisitLog(pool, { geoEnabled: false, warn: (m) => warns.push(m) });

    expect(() => {
      log.record({ kind: "guest", ip: "8.8.8.8", ua: UA_CHROME_WIN });
      log.record({ kind: "guest", ip: "8.8.8.8", ua: UA_CHROME_WIN });
    }).not.toThrow();
    await log.flush();
    await Promise.resolve();
    expect(warns).toHaveLength(1);
  });
});

describe("createVisitLog.resolvePending / backfill", () => {
  it("串行补全待解析 IP，成功写回、失败计入 failed", async () => {
    const { pool, updates } = fakePool({ pending: ["1.1.1.1", "2.2.2.2"] });
    const fetchGeo = vi.fn(async (ip: string) =>
      ip === "1.1.1.1" ? { country: "中国", region: "中国·上海市", isp: "", source: "ip-api" } : null,
    );
    const log = createVisitLog(pool, { fetchGeo, geoIntervalMs: 0, warn: silent });

    const r = await log.resolvePending(10);
    expect(r).toEqual({ resolved: 1, failed: 1 });
    expect(fetchGeo).toHaveBeenCalledTimes(2);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].params![4]).toBe("1.1.1.1");
  });

  it("backfill 同一时刻只跑一个任务（HTTP 请求不必等它）", async () => {
    const { pool } = fakePool({ pending: ["1.1.1.1"] });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const fetchGeo = vi.fn(async () => {
      await gate;
      return null;
    });
    const log = createVisitLog(pool, { fetchGeo, geoIntervalMs: 0, warn: silent });

    expect(log.backfill(5)).toBe(true);
    expect(log.backfill(5)).toBe(false); // 已有任务在跑
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchGeo).toHaveBeenCalledTimes(1);
    expect(log.backfill(5)).toBe(true); // 上一轮结束后可再次启动
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("createVisitLog 读侧映射", () => {
  it("summary 按 IP 聚合，命中 TRAFFIC_SELF_IPS 的标 self，字符串数值转 number", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            ip: "203.0.113.9", ip_prefix: "203.0.113.0/24", region: "中国·北京市", isp: "联通",
            device: "Chrome 128 · Windows 10/11", referer: "", src: "boss", username: "guest",
            first_ts: new Date("2026-09-19T01:00:00Z"), last_ts: new Date("2026-09-19T02:00:00Z"),
            hits: "3", is_bot: false,
          },
        ],
      }),
    } as unknown as Pool;
    const log = createVisitLog(pool, { geoEnabled: false, selfIps: ["203.0.113.0/24"], warn: silent });

    const rows = await log.summary({ kind: "guest", includeBots: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].self).toBe(true);
    expect(rows[0].hits).toBe(3);
    expect(rows[0].firstTs).toBe("2026-09-19T01:00:00.000Z");
    expect(rows[0].region).toBe("中国·北京市");
  });

  it("stats 字符串数值同样转 number，并带上有没有配自己的 IP", async () => {
    const { pool } = fakePool({ stats: { events: "12", ips: "5", recent24h: "2", pending_geo: "1" } });
    const log = createVisitLog(pool, { geoEnabled: false, selfIps: ["1.2.3.4"], warn: silent });

    const s = await log.stats({ kind: "guest" });
    expect(s).toEqual({ events: 12, ips: 5, recent24h: 2, pendingGeo: 1, selfIpsConfigured: true });
  });

  it("kind=all 时不加 kind 过滤（传 null 给 SQL）", async () => {
    const { pool, calls } = fakePool();
    const log = createVisitLog(pool, { geoEnabled: false, selfIps: [], warn: silent });

    await log.summary({ kind: "all" });
    const summaryCall = calls.find((c) => /GROUP BY ip/.test(c.sql))!;
    expect(summaryCall.params![0]).toBeNull();
    expect(summaryCall.params![1]).toBe(false); // 默认排除脚本
  });
});
