#!/bin/bash
# ============================================================
# navigate 自动部署脚本 —— 由 Gitee WebHook 触发
# 逻辑：拉取最新代码 → 重建并重启容器 → 输出状态
# 关联：/etc/webhook/hooks.json（trigger id: deploy）
# ============================================================
set -euo pipefail

# 非交互环境下自动接受新主机指纹（首次 git pull 时避免卡在 yes/no）
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"

cd /opt/navigate

echo "==> git pull ($(date '+%F %T'))"
git pull --ff-only origin main

echo "==> rebuild & restart containers"
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build

echo "==> container status"
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
