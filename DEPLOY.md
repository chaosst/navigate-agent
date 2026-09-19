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

### 1.2 创建 swap（2G 内存机器**必须**做，构建和运行都需要）

**不建会怎样（已实际发生）**：2026-09-10 17:19 内核 `global OOM` 杀掉了 zyplayer-doc 的 java
（`anon-rss 414248kB`），而容器因 `/start.sh` 末尾的 `tail -f /dev/null` 仍保持 `Up` →
表现为 **wiki 502（上游 `Connection refused`）但 `docker ps` 一切正常**（"容器假活"）。
当时 `free -m` 为 `total 1871 / used 1200 / Swap 0`，而本编排要跑 6 个容器
（app / postgres / ollama / zyplayer-mysql / zyplayer-doc / caddy）。

```bash
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab    # ★ 漏了这行，重启后 swap 就没了
free -h        # 确认 Swap 行显示 4G
```

> ⚠️ **2026-09-13 生产实测 `Swap: 0`** —— 说明首次部署时这一步被跳过了。
> swap 不是"可选优化"，是这台机器能跑满 6 容器、并让构建不 OOM 的前提。
> 部署完成后请再核一次 `free -m`。

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
- `TRAFFIC_SELF_IPS`（可选）—— 你自己的公网 IP（精确 IP 或 `1.2.3.0/24` 网段，逗号分隔），用于 `/admin` 访客记录页的「隐藏我自己」；不配则该开关不显示
- `H5_TRUST_PROXY_HOPS`（可选，默认 1）—— **反代跳数**。站点经 Caddy 反代时必须信任 `X-Forwarded-For`，否则 `req.ip` 恒为 Caddy 容器地址：访客记录里所有 IP 都是 172.x（分不出谁来过），登录防爆破还会把全网访客当同一个人。域名前另挂 CDN 时按实际层数加；直连部署设 0。**只填跳数、不要填 `true`**（全信任时客户端可伪造 XFF 冒充任意 IP）
- `TRAFFIC_GEO_ENABLED`（可选，默认开）—— 设 `false` 关闭访客属地外查（IP 仍记录，只是没有属地）
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

**内存看护（2G 机器一号风险，建议每季度过一遍）**

```bash
# ① 谁在吃内存
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}"

# ② swap 还在不在（重启后若不是 4G，说明 fstab 那行丢了 → 回 1.2 节）
free -m

# ③ 有没有被内核 OOM 杀过
dmesg -T | grep -iE 'oom|killed process' | tail -5

# ④ ★「容器假活」判据：状态 Up，但业务进程已死
docker exec zyplayer-doc ps -ef | head
#    只看到 /bin/bash /start.sh(PID 1) 和 tail -f /dev/null(PID 7) → java 已死
docker restart zyplayer-doc        # 安全：不重建容器、不动卷，30s 后确认 8083 起来
```

> 为什么需要 ④：`restart: unless-stopped` **只在容器退出时生效**。zyplayer 镜像的 `/start.sh`
> 末尾用 `tail -f /dev/null` 保活 PID 1，所以 java 被 OOM 杀掉后容器仍是 `Up`，restart 策略
> 永远不会触发 → 502 会一直持续到有人手动重启。

**zyplayer-doc 看门狗（补上上面这个盲区，加到宿主机 crontab）**

compose 已给 zyplayer-doc 配了 `healthcheck`（探 8083，`start_period: 120s`），
但**原生 Docker 不会因 unhealthy 自动重启容器**，需要一条看门狗把状态接上。

```bash
crontab -e        # 以 admin 用户执行即可（admin 已在 docker 组，无需 sudo）
```

编辑器操作（首次会让你选，通常 nano 或 vi）：

| 编辑器 | 插入 | 保存退出 | 放弃退出 |
|---|---|---|---|
| nano | 直接粘贴 | `Ctrl+O` → 回车 | `Ctrl+X` |
| vi / vim | 先按 `i` | `Esc` → `:wq` → 回车 | `Esc` → `:q!` → 回车 |

粘贴成两行（`#` 开头是注释，可留可删）：

```
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# 每 2 分钟：状态为 unhealthy 才重启（starting 阶段不误触发，故冷启动安全）
*/2 * * * * test "$(docker inspect -f '{{.State.Health.Status}}' zyplayer-doc 2>/dev/null)" = unhealthy && docker restart zyplayer-doc >> "$HOME/zyplayer-watchdog.log" 2>&1
```

> - **文件最后必须留一个空行（换行符）**，否则 cron 会静默忽略最后一行 —— 最常见的坑。
> - 第一行 `PATH=` 不能省：cron 的默认 PATH 极简，可能找不到 `docker`。
> - **日志不要写 `/var/log/`**：admin 无写权限 → 任务会静默失败（连报错都看不到）。用 `$HOME`
>   （cron 会按 `/etc/passwd` 设置它，admin 即 `/home/admin`）。想彻底消除疑义可直接写绝对路径
>   `/home/admin/zyplayer-watchdog.log`。
> - 保存即生效（无需 reload）。
> - **校验三步（缺一不可）**：
>   ① `crontab -l` 回显内容；② `systemctl is-active crond`（Ubuntu 上服务名是 `cron`）应为 `active`；
>   ③ **证明它真的在跑** —— 看 cron 自己的执行日志：
>   `sudo tail -30 /var/log/cron | grep zyplayer`（或 `sudo journalctl -u crond --since "10 min ago"`）。
> - ⚠️ **`~/zyplayer-watchdog.log` 不存在 = 一件好事**：日志只在"触发过重启"时才写入，
>   文件没生成说明从来没不健康。**因此不能拿它判断任务有没有在跑** —— 那要看 ③。
>   想守着等它出现请用 `tail -F`（**大写**：`-F` 在文件不存在时会等待；`-f` 会立刻报
>   `No such file or directory` 然后退出，极易被误读成故障）。
> - 只想要一次性验证：`crontab -r` 删掉整个用户 crontab（谨慎，会连别的任务一起删）。
>
> ⚠️ **时序前提（部署新 compose 之前别用上面这条）**：它依赖 zyplayer-doc 已有 `healthcheck`。
> 旧容器没有 healthcheck → `{{.State.Health.Status}}` 返回**空字符串** → `test "" = unhealthy`
> 恒假 → **看门狗永远不触发**（而且不报错，最难发现）。**新 compose 部署前请先用下面这条**：
>
> ```
> */2 * * * * docker exec zyplayer-doc bash -c 'exec 3<>/dev/tcp/127.0.0.1/8083' >/dev/null 2>&1 || docker restart zyplayer-doc >> "$HOME/zyplayer-watchdog.log" 2>&1
> ```
>
> 它直接探 8083，不依赖 healthcheck，**现在就能用**；代价是冷启动 30s 内会抖动触发一次重启
> （无害，只是白重启一次）。部署完新 compose 后再换回上一条（更稳：`start_period` 内状态是
> `starting`，不会误触发）。

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
| wiki 502 / upstream unavailable | 上游 java 多半已被内核 OOM 杀掉（`dmesg` 求证）→ 按「运维速查 · 内存看护」④ 处置：`docker restart zyplayer-doc` + 补 swap |                             |                 |
| 忘记运维 token          | \`docker compose ... logs app                                                           | grep 'Access token'\` 看启动日志 |                 |

---

## 当前安全状态自查

- [ ] `.env.prod` 权限：`chmod 600 .env.prod`
- [ ] 数据库密码不是默认值
- [ ] `H5_LOGIN_PASSWORD` 已改
- [ ] API 已配 `API_KEYS`（或至少 IP 白名单）
- [ ] 防火墙只开了 22/80/443
- [ ] 镜像里没有密钥（`docker history navigate-app:latest` 抽查）
