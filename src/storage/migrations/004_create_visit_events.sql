-- 004: H5 访客登录记录（「除了我还有谁看过这个站点」）
--
-- 背景：游客入口（/api/login/guest）是**所有人共用同一个 guest 账号**，应用日志里
-- 只能看到「guest 来了」——无法分辨个体。本表按**每次登录事件**落一行原始记录，
-- 用 IP / 属地 / UA 把「同一个账号」还原成「不同的人」。
--
-- 设计取舍：
--   · 只追加、不改写：保留原始事实，聚合（按 IP 分组）交给查询侧，避免写入路径上的读改写竞态；
--   · IP 存明文（需求就是「看是谁」），不做 hash —— 同时存 ip_prefix 便于按网段快速识别自己；
--   · 属地解析结果回写本表（geo_*），即「一次解析、永久缓存」：ip-api 免费额度按请求数计，
--     换机器/重启都不用重新查。

CREATE TABLE IF NOT EXISTS visit_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 'guest' = 游客体验入口；'login' = 账号密码登录（便于把「自己」从访客里摘出来）
  kind        TEXT NOT NULL,
  username    TEXT,
  role        TEXT,
  ip          TEXT NOT NULL,
  -- 「1.2.3.0/24」形式：一眼看出多个 IP 是否同一网段（同一家公司/同一出口）
  ip_prefix   TEXT,
  geo_country TEXT,
  geo_region  TEXT,                       -- 展示用：「中国·北京市」
  geo_isp     TEXT,
  -- 'ip-api' = 外部接口解析；'local' = 内网/保留地址（不查外网）；NULL = 尚未解析或解析失败
  geo_source  TEXT,
  ua          TEXT,
  device      TEXT,                       -- 人类可读：「Chrome 128 · Windows」
  is_bot      BOOLEAN NOT NULL DEFAULT FALSE,
  referer     TEXT,
  src         TEXT,                       -- 链接渠道标识（登录页 ?src=xxx，用于一人一链接）
  landing     TEXT                        -- 登录后落点（next）
);

CREATE INDEX IF NOT EXISTS idx_visit_events_ts ON visit_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_visit_events_ip ON visit_events (ip);
CREATE INDEX IF NOT EXISTS idx_visit_events_kind_ts ON visit_events (kind, ts DESC);
-- 部分索引：只为「待补属地」的行建，resolvePending 扫的是这一小撮
CREATE INDEX IF NOT EXISTS idx_visit_events_pending_geo ON visit_events (ip) WHERE geo_region IS NULL;
