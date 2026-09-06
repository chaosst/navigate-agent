# navigate 公网部署手册（韩国节点 · 容器型轻量 2核2G）

> 目标：把 navigate（Express :3001 + PostgreSQL pgvector/zhparser）通过 Docker 部署到公网，  
> Caddy 自动 HTTPS。韩国节点免备案，`liuwenbo/pg_vector_fts:pg17` 若拉取失败会自动走本地编译 fallback。

## 0. 部署文件清单（本次已生成）

| 文件                           | 作用                                      |
| ---------------------------- | --------------------------------------- |
| `Dockerfile`                 | 应用多阶段镜像（含静态资源修复）                        |
| `docker-entrypoint.sh`       | 启动脚本：可变数据导向挂载卷 `/app/data`              |
| `docker-compose.prod.yml`    | app + postgres + caddy 三服务编排（密码脱敏、内网端口） |
| `Caddyfile`                  | HTTPS 反代配置（域名由环境变量注入）                   |
| `.env.prod.example`          | 生产环境变量模板                                |
| `.dockerignore`              | 精简构建上下文（排除 node_modules/wiki-js 等）      |
| `docker/postgres/Dockerfile` | pgvector + zhparser fallback 镜像         |

---

## 第一步：服务器初始化（一次性）

### 1.1 SSH 登录

阿里云轻量控制台拿到公网 IP 和 root 密码（或密钥），然后：

```bash
ssh root@<你的服务器IP>
```

> Windows 自带 OpenSSH 可直接用；也可用终端软件（Termius / FinalShell）。

### 1.2 创建 swap（2G 内存机器**必须**做，否则构建会 OOM）

```bash
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h        # 确认 Swap 行显示 4G
```

### 1.3 检查 Docker 环境

容器型轻量一般预装 Docker。确认：

```bash
docker --version
docker compose version
```

如果 `docker` 或 `docker compose` 报命令不存在，安装：

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

### 1.4 防火墙放行端口

阿里云控制台 → 轻量应用服务器 → 防火墙：放行 **22 / 80 / 443**。  
（3001/3003/5432 一律不放行，由 Docker 内部网络隔离。）

---

## 第二步：上传项目代码

> 本地是 Windows。用 Git Bash（或 WSL）在项目目录执行打包 + 上传。  
> 打包时排除 node_modules / wiki-js 等大目录，减小传输体积。

### 2.1 本地打包

```bash
cd /d/develop/navigate
tar --exclude=node_modules --exclude=dist --exclude=wiki-js --exclude=rag-mcp \
    --exclude=navigate.db --exclude=.git --exclude='*.db' \
    -czf navigate-deploy.tar.gz .
```

### 2.2 上传并解压

```bash
scp navigate-deploy.tar.gz root@<你的服务器IP>:/root/
```

服务器上：

```bash
mkdir -p /opt/navigate
tar -xzf /root/navigate-deploy.tar.gz -C /opt/navigate
cd /opt/navigate
ls          # 应能看到 Dockerfile、src、package.json、docker-compose.prod.yml 等
```

> 小技巧：如果以后代码改动小，也可以只 `scp` 单个改动文件上去，不必整包重传。

---

## 第三步：配置环境变量

```bash
cd /opt/navigate
cp .env.prod.example .env.prod
vi .env.prod        # 或 nano .env.prod
```

**必须改的项**：

- `OPENAI_API_KEY` —— 你的真实 key
- `POSTGRES_PASSWORD` —— 强密码（≥16 位混合字符）
- `H5_LOGIN_PASSWORD` —— 登录页密码（不要用默认值）
- `H5_GUEST_PASSWORD`（可选）—— 体验账号密码（给 HR/面试官演示用；不配则不启用体验登录）。体验账号仅可访问 简历 / 简历问答 / JD匹配 / 文档管理（只读），上传/重新索引/删除与 `/admin` 账号管理页均无权限；管理员登录后在 `/admin` 页可随时重置该密码（持久化 `rag_data/h5-users.json`，此后 env 修改需删该文件重启才生效）
- `API_KEYS`（强烈建议）—— 如 `sk-xxx:2026-12-31T00:00:00Z`，给 API 加固定 key
- `DOMAIN` —— **先留空**，没域名时跳过 Caddy（见第五步）

> `.env.prod` 含密钥，**永远不要提交进 git、不要打进镜像**（本部署方案已通过 env_file 注入，镜像内无密钥）。

---

## 第四步：构建 + 启动

```bash
cd /opt/navigate

# 首次构建较久（postgres 编译 zhparser 5-15 分钟 + app 编译 3-8 分钟）
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

**首次构建会做什么**：

1. `postgres`：基于 `pgvector/pgvector:pg17` 编译安装 zhparser 中文分词 → 打 tag `navigate/pg-vector-fts:17`（只编一次，之后复用镜像）
2. `app`：多阶段构建（builder 装全量依赖编译 TS → runner 只留生产依赖 + dist + public 静态资源）
3. 三个容器依次拉起，postgres 健康后才启动 app

查看状态：

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f app
```

看到日志输出：

```
Web server running on http://localhost:3001
(运维) Access token: xxxx
```

即启动成功（这个 token 可经 `/?token=xxxx` 直接进入）。

---

## 第五步：访问方式（二选一）

### 方案 A：没有域名 —— SSH 隧道访问（当前推荐）

> **前提**：服务器上只起了 app + postgres（没起 caddy）：
>
> ```bash
> cd /opt/navigate
> docker compose --env-file .env.prod -f docker-compose.prod.yml up -d app postgres
> docker compose --env-file .env.prod -f docker-compose.prod.yml ps   # 两个都应为 Up / healthy
> ```

**在本地**（不是服务器上）开一条 SSH 隧道，把服务器端口映射到本地：

```bash
# 转发 3001（navigate 主服务）+ 3003（wiki 代理，需要访问 zyplayer 时加）
ssh -L 3001:127.0.0.1:3001 -L 3003:127.0.0.1:3003 root@<你的服务器IP>
```

保持这个窗口开着（不要关闭），然后本地浏览器访问：

- 主站：`http://localhost:3001/login`
- Wiki（zyplayer）：`http://localhost:3003`（首次在 wiki 里手动登录一次）

**本地端口被占用时**（比如本地开发也在跑 3001），换本地端口：

```bash
ssh -L 4001:127.0.0.1:3001 root@<你的服务器IP>
# 然后访问 http://localhost:4001/login
```

**隧道后台常驻**（关掉终端也不断）：

```bash
ssh -N -f -L 3001:127.0.0.1:3001 root@<你的服务器IP>
# 关闭隧道：
ssh -O exit root@<你的服务器IP>
```

**连不上？按顺序排查**：

1. 阿里云控制台防火墙放行了 **22** 端口（SSH）
2. 服务器上服务真的起来了：`docker compose --env-file .env.prod -f docker-compose.prod.yml ps`
3. 先测普通 SSH：`ssh root@<你的服务器IP>` 能登进去，隧道才能通
4. Windows 下 PowerShell 或 Git Bash 的 `ssh` 都能用，命令不要加 `sudo`

### 方案 B：有域名 —— Caddy 自动 HTTPS（推荐）

1. 在域名服务商（阿里云万网/Cloudflare 等）加一条 **A 记录**：`navigate` → 服务器 IP
2. 服务器上修改 `.env.prod`：
   ```bash
   vi .env.prod
   # DOMAIN=navigate.example.com   ← 改成你的真实域名
   ```
3. 重启全部服务（把 caddy 也拉起来）：
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
   ```
4. 等 1-2 分钟，Caddy 自动申请 Let's Encrypt 证书，然后访问：

   **<https://navigate.example.com/login>**

> Caddy 失败排查：`docker compose ... logs caddy`，常见是域名没解析到位（用 `dig navigate.example.com` 确认指向本机 IP）。

---

## 第六步：验证 + 使用

- [ ] `https://<域名>/login` 能打开登录页（H5 登录）
- [x] 用 `H5_LOGIN_USERNAME/PASSWORD` 登录成功
- [ ] 上传一份文档 → RAG 索引成功（`POST /api/upload` 或页面上传）
- [ ] 在聊天页提问，确认能检索到文档内容
- [ ] 检查 postgres 中 `chunks` 表有数据：`docker compose ... exec postgres psql -U navigate -d navigate -c "select count(*) from chunks;"`

---

## 运维速查

**看日志**

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f app
docker compose --env-file .env.prod -f docker-compose.prod.yml logs postgres
```

**重启/停止**

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml restart
docker compose --env-file .env.prod -f docker-compose.prod.yml down   # 停止（保留数据卷）
```

**更新代码后再部署**

```bash
cd /opt/navigate
# 把新代码同步上来（重传 tar 或 scp 单文件）
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

**备份**

```bash
# 1) 数据库 dump
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  pg_dump -U navigate -d navigate > backup_$(date +%F).sql

# 2) 应用数据卷（navigate.db + rag_uploads/ + skills/）
#    卷名以 docker volume ls 实际为准（通常是 navigate_appdata）
docker run --rm -v navigate_appdata:/data -v $(pwd):/backup alpine \
  tar czf /backup/appdata_$(date +%F).tar.gz -C /data .
```

建议 crontab 每周自动 dump。

---

## 常见问题

| 现象                  | 处理                                                                                      |                             |                 |
| ------------------- | --------------------------------------------------------------------------------------- | --------------------------- | --------------- |
| 构建时 `npm` 报错 / 内存不足 | 确认已建 4G swap（1.2 节）；可临时调低 `DATABASE_POOL_MAX`                                           |                             |                 |
| postgres 起不来        | `logs postgres`：若 zhparser 编译失败，改回 `image: liuwenbo/pg_vector_fts:pg17`（compose 中注释已说明） |                             |                 |
| app 健康检查失败          | `logs app`：多半是 `DATABASE_URL` 拼错（密码与 POSTGRES_PASSWORD 不一致）或 OpenAI key 无效              |                             |                 |
| 80/443 被占用          | 可能装了宝塔等面板，\`ss -tlnp                                                                    | grep -E ':(80               | 443)'\` 找占用进程停掉 |
| 访问很慢                | 韩国节点到电信晚高峰一般；可换香港/东京节点或加 CDN                                                            |                             |                 |
| 忘记运维 token          | \`docker compose ... logs app                                                           | grep 'Access token'\` 看启动日志 |                 |

---

## 当前安全状态自查

- [ ] `.env.prod` 权限：`chmod 600 .env.prod`
- [ ] 数据库密码不是默认值
- [ ] `H5_LOGIN_PASSWORD` 已改
- [ ] API 已配 `API_KEYS`（或至少 IP 白名单）
- [ ] 防火墙只开了 22/80/443
- [ ] 镜像里没有密钥（`docker history navigate-app:latest` 抽查）
