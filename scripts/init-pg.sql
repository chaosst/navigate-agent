-- Docker entrypoint 初始化脚本
-- 仅创建 extension，表结构通过迁移脚本在应用启动时创建
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS zhparser;
