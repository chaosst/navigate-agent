-- Docker entrypoint 初始化脚本
-- 仅创建 extension，表结构通过迁移脚本在应用启动时创建
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS zhparser;

-- 中文全文搜索配置
CREATE TEXT SEARCH CONFIGURATION chinese_zh (PARSER = zhparser);
ALTER TEXT SEARCH CONFIGURATION chinese_zh
  ADD MAPPING FOR n, v, a, i, e, l WITH simple;