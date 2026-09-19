# ── 构建阶段：全量依赖 + 编译 ──
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── 运行阶段：仅生产依赖，镜像最小化 ──
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# curl 用于容器 healthcheck
RUN apk add --no-cache curl

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 编译产物
COPY --from=builder /app/dist dist/
# ★ tsc 不复制静态资源，必须手动补上，否则登录页/简历页 404
COPY --from=builder /app/src/server/public dist/server/public/
# ★ tsc 也不复制 .sql —— 少了这行 migrate() 会走「No migrations directory found, skipping」，
# 生产环境永远不会建表（scripts/init-pg.sql 只装 extension，注释里写明表结构由迁移脚本创建）。
# 全部迁移都写成幂等（IF NOT EXISTS / DO 块守卫），对已有库重跑是空转，故可安全启用。
COPY --from=builder /app/src/storage/migrations dist/storage/migrations/
# 运行期要读的只读文件
COPY skills/ skills/
# resume.* —— 简历源允许 md（手工维护）或 docx（loader 自动转 markdown），
# 两者至少存在其一；写死 resume.md 会让「只用 docx」的构建直接失败。
COPY resume.* ./

# 启动脚本：把可变数据导向挂载卷 /app/data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data/rag_uploads \
    && chown -R node:node /app/data

USER node
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
