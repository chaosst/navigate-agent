#!/bin/bash
# ============================================================
# navigate 自动部署脚本 —— 由 Gitee WebHook 触发
# 逻辑：同步代码（硬对齐远端）→ 重建并重启容器 → 输出状态
# 关联：/etc/systemd/system/webhook.service（以 admin 运行）
# ============================================================
set -euo pipefail

# 非交互环境下自动接受新主机指纹（首次 git 操作时避免卡在 yes/no）
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"

cd /opt/navigate

echo "==> git sync ($(date '+%F %T'))"
git fetch origin
# 服务器是纯"跟随"角色（本地从不产生提交）：
# 历史分叉或本地有残留改动时，直接硬对齐远端，避免 --ff-only 拒绝同步
git reset --hard origin/main

echo "==> rebuild & restart containers"
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build

echo "==> container status"
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
