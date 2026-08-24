#!/bin/sh
# navigate 容器启动脚本
# 应用多处使用相对路径（navigate.db / rag_uploads/ / resume.md / skills），
# 统一把工作目录切到挂载卷 /app/data，确保数据持久化。
set -e

mkdir -p /app/data/rag_uploads
cd /app/data

# 首次启动：把镜像内只读副本同步进数据卷（后续以卷内版本为准，可编辑）
if [ ! -f resume.md ] && [ -f /app/resume.md ]; then
  cp /app/resume.md ./resume.md
fi
if [ ! -d skills ] && [ -d /app/skills ]; then
  cp -r /app/skills ./skills
fi

exec node /app/dist/server-entry.js
