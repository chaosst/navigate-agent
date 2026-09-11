#!/bin/sh
# navigate 容器启动脚本
# 应用多处使用相对路径（navigate.db / rag_uploads/ / resume.md|resume.docx / skills），
# 统一把工作目录切到挂载卷 /app/data，确保数据持久化。
set -e

mkdir -p /app/data/rag_uploads
cd /app/data

# 首次启动：把镜像内只读副本同步进数据卷（后续以卷内版本为准，可编辑）
# 简历源可能是 resume.md 或 resume.docx，各自独立判断，缺哪个补哪个
for f in resume.md resume.docx; do
  if [ ! -f "$f" ] && [ -f "/app/$f" ]; then
    cp "/app/$f" "./$f"
  fi
done
if [ ! -d skills ] && [ -d /app/skills ]; then
  cp -r /app/skills ./skills
fi

exec node /app/dist/server-entry.js
