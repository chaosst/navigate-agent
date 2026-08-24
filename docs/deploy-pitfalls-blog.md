# Agent + Wiki + RAG 三件套公网部署实录：Docker 化的 21 个坑，第 8 个直接让我裂开

> 关键词：Agent 部署 · Docker 多阶段构建 · pgvector · zhparser 中文分词 · 数据迁移 · 韩国服务器 · Windows 环境

## 前言

背景交代一下：我手上有个叫 **navigate** 的个人 Agent 项目，技术栈是 **LangChain + LangGraph**，带三块核心能力：

1. **Agent** —— 基于 LLM 的工具调用循环，能操作文件、执行命令、检索知识
2. **Wiki** —— 集成 zyplayer-doc 知识库（Java + MySQL），做文档沉淀
3. **RAG** —— PostgreSQL + pgvector 向量检索，配合 zhparser 中文分词，实现混合检索（向量 + BM25 + 关键词兜底）

本地跑得好好的，今年终于下定决心把它**部署到公网**。买了一台阿里云韩国节点轻量服务器（2核2G，79元/年，免备案——对，免备案真香），然后就是长达两天的"渡劫"之旅。

这篇文章把整个过程中踩过的坑全部复盘一遍，按类别整理成 6 组 21 个坑。**特别是 Windows 本地环境那组（第 8 个坑），我直接被整不会了。**

## 部署架构

先看最终长什么样（这是踩完所有坑之后的目标形态）：

```
公网用户 ──HTTPS──> Caddy 反向代理(:443) ──> navigate-app(:3001, 仅内网)
                                                │
                                                ├──> postgres + pgvector + zhparser(:5432, 仅内网)
                                                └──> zyplayer-doc(:8083, 可选)
```

核心原则：**一切端口收进内网，公网只留 80/443，密钥全部走环境变量注入，数据全部进 Docker volume**。

## 踩坑目录

| 分组 | 坑 | 一句话 |
|---|---|---|
| 镜像与构建 | 1. 项目根本没有应用 Dockerfile | 只有个 pg 的基础镜像 |
| | 2. tsc 不复制静态资源 | 登录页/简历页 404 的元凶 |
| | 3. .dockerignore 误伤 resume.md | `COPY resume.md` 报 not found |
| | 4. zhparser 中文分词装不上 | Debian 没包，只能源码编译 |
| | 5. 服务器 2G 内存构建 OOM | 必须加 swap |
| | 6. 多阶段构建 | 镜像从 1.5G 瘦到 400M |
| 安全 | 7. 数据库密码是公开默认值 | navigate/navigate |
| | 8. Express 默认 0.0.0.0 | 裸奔公网，必须收进内网 |
| | 9. 密钥打进镜像 | env_file 注入才对 |
| Windows | 10. PowerShell 跑 Linux 命令 | head/grep/cd /d 全是坑 |
| | 11. PowerShell 重定向损坏二进制 | pg_dump 导出一坨乱码 |
| | 12. Git Bash 的 MSYS 路径转换 | `/backup` 变成了 `C:/Program Files/Git/backup` |
| 访问 | 13. 没有域名 | SSH 隧道先跑起来 |
| | 14. Caddy 自动 HTTPS | 必须要有域名 + 解析 |
| zyplayer | 15. 登录后跳回登录页 | SPA 的 localStorage 残留 |
| | 16. zyplayer 数据迁移 | MySQL dump + 文件卷 |
| 数据迁移 | 17. RAG 数据在 pg | pg_dump 直接搬，向量不用重算 |
| | 18. SQLite 和上传文件 | navigate.db + rag_uploads 卷迁移 |
| | 19. 迁移顺序 | 先扩展、后数据、再起服务 |
| | 20. 个人镜像拉不到 | liuwenbo/pg_vector_fts 是个雷 |
| | 21. 服务器构建太慢 | 一次 10-20 分钟，靠 layer 缓存续命 |

下面挑重点展开讲。

---

## 第一组：镜像与构建（坑 1-6）

### 坑 2：tsc 不复制静态资源，登录页 404

**现象**：本地 `npm run build` 编译通过，`npm start` 也能跑，但部署到 Docker 里一访问 `/login` 就是 404。

**原因**：项目的前端页面（`login.html`、`resume.html` 等）放在 `src/server/public/`，而 `tsc` 只编译 `.ts` 文件，**根本不会把 `.html` 复制到 `dist/`**。本地开发用 tsx 直接跑源码所以没事，一上生产就原形毕露。

**解决**：Dockerfile 里手动补一步：

```dockerfile
# tsc 不复制静态资源，必须手动补上，否则登录页/简历页 404
COPY --from=builder /app/src/server/public dist/server/public/
```

**教训**：本地能跑 ≠ 生产能跑。开发用的是 tsx（源码直跑），生产是编译产物，两类环境差异要提前盘清楚。

### 坑 3：`.dockerignore` 的 `*.md` 误伤 `resume.md`

**现象**：构建跑到 `COPY resume.md ./` 报错：`failed to compute cache key: "/resume.md": not found`。

**原因**：为了精简构建上下文，我在 `.dockerignore` 里写了 `*.md` 排除所有文档。结果 `resume.md`（简历数据，应用运行时要读）也被排除了。**文件在磁盘上明明存在，但被排除在构建上下文之外，COPY 自然找不到。**

**解决**：dockerignore 和 gitignore 一样，后面的规则覆盖前面的，用 `!` 重新包含：

```dockerignore
*.md
!resume.md
!skills/*.md
```

**教训**：`.dockerignore` 排除规则要"先粗后细"，排除所有之后记得用 `!` 把运行期必需的文件捞回来。这是最容易阴沟翻船的一步。

### 坑 4：zhparser 中文分词装不上，数据库起不来

**现象**：postgres 容器构建失败，apt 报 `E: Unable to locate package libscws-dev`。

**原因**：这个项目的数据库迁移脚本硬依赖 **zhparser**（中文全文检索分词插件，创建 `chinese_zh` 文本搜索配置）。但：

- 本地 compose 用的 `liuwenbo/pg_vector_fts:pg17` 是**个人镜像**，服务器上大概率拉不到（坑 20）
- 官方 `pgvector/pgvector:pg17` 镜像**没有 zhparser**
- Debian bookworm 仓库里**没有 `libscws-dev` 包**（SCWS 是 zhparser 的底层分词库）

三层叠加，直接把数据库堵死。

**解决**：写一个 fallback 构建脚本，源码编译 SCWS → 再编译 zhparser：

```dockerfile
FROM pgvector/pgvector:pg17

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential postgresql-server-dev-17 git ca-certificates wget \
        autoconf automake libtool pkg-config \
    && rm -rf /var/lib/apt/lists/*

# SCWS 源码编译（GitHub 源码包不含 configure，用自带 acprep 生成）
RUN wget -q https://github.com/hightman/scws/archive/refs/tags/1.2.3.tar.gz -O /tmp/scws.tar.gz \
    && mkdir -p /tmp/scws \
    && tar xzf /tmp/scws.tar.gz -C /tmp/scws --strip-components=1 \
    && cd /tmp/scws \
    && ./acprep \
    && ./configure --prefix=/usr/local \
    && make -j"$(nproc)" && make install && ldconfig \
    && rm -rf /tmp/scws /tmp/scws.tar.gz

# zhparser 编译（指定 PG17 的 pg_config 和 SCWS 路径）
RUN git clone --depth 1 https://github.com/amutu/zhparser.git /tmp/zhparser \
    && cd /tmp/zhparser \
    && make PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config SCWS_HOME=/usr/local \
    && make install PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config SCWS_HOME=/usr/local \
    && rm -rf /tmp/zhparser
```

**教训**：`CREATE EXTENSION` 这类硬依赖，部署前就要在目标环境验证好。个人镜像、第三方扩展、官方镜像缺组件，三座大山提前搬。

### 坑 5：服务器 2G 内存构建 OOM

**现象**：`npm ci` + `tsc` 编译过程中内存被打爆，构建直接失败或卡死。

**解决**：服务器上先建 4G swap：

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**教训**：买服务器别只看价格，**内存决定你能不能构建**。2G 内存跑 Node 编译必须配 swap，这是部署 Agent/RAG 这类依赖重的项目的第一课。

---

## 第二组：安全（坑 7-9）

### 坑 7：数据库密码是公开默认值

**现象**：本地 `docker-compose.yml` 里 `POSTGRES_PASSWORD: navigate`——这密码等于没有。

**解决**：生产编排文件里密码走环境变量，部署时用 `docker compose --env-file .env.prod` 注入：

```yaml
environment:
  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}   # 从 .env.prod 读，不写死在文件里
```

**注意**：compose 的 `${}` 变量替换读的是 **`--env-file` 指定的文件**，不是 `env_file:`（那是注入容器的），这俩别搞混。

### 坑 8：Express 默认监听 0.0.0.0

**现象**：`app.listen(port)` 没指定 host，默认绑定所有网卡——公网裸奔。

**解决**：端口只绑本机，公网流量全部走 Caddy：

```yaml
ports:
  - "127.0.0.1:3001:3001"   # 只绑本机，运维 SSH 内调试用
```

postgres 干脆不映射端口，只在 compose 内网可达。

### 坑 9：密钥千万别打进镜像

`.env.prod` 里有 `OPENAI_API_KEY`、数据库密码、登录密码。做法是：

- Dockerfile **不 COPY 任何 `.env*`**
- 运行配置用 compose 的 `env_file: .env.prod` 注入
- `.env.prod` 加进 `.gitignore`（原 gitignore 居然没忽略它，差点提交上去）

---

## 第三组：Windows 本地环境的噩梦（坑 10-12）——最折磨人的一组

这组坑全是因为**本地是 Windows，服务器是 Linux**，两个环境的 shell 行为差异导致的。每个都让我在凌晨对着报错发呆。

### 坑 10：PowerShell 跑 Linux 风格命令

**现象**：

```
head : 无法将"head"项识别为 cmdlet、函数、脚本文件或可运行程序的名称
```

`tar.exe: Must specify one of -c, -r, -t, -u, -x`

**原因**：我把 Linux 命令（`cd /d`、`head`、`grep`、反斜杠续行）直接粘到 PowerShell 里跑。PowerShell 里没有 `head`/`grep`，`cd /d` 是错误语法，`\` 也不是续行符。

**解决**：分清环境——
- PowerShell：`head` → `Select-Object -First`，`grep` → `Select-String`，路径 `D:\xx`
- Git Bash：原汁原味 Linux 命令，路径 `/d/xx`

**最佳实践**：VS Code 终端右上角下拉切到 **Git Bash**，之后本地全部用 bash，和服务器一致，少一半问题。

### 坑 11：PowerShell 重定向损坏二进制

**现象**：`pg_dump -Fc > navigate.dump` 导出的文件，在服务器上 `pg_restore` 报格式错误；`mysqldump > x.sql` 导入后中文全乱。

**原因**：PowerShell 的 `>` 重定向默认按 **UTF-16 文本** 处理，二进制流（`-Fc` 自定义格式 dump）直接被写坏；UTF-8 文本也会被转码。

**解决**：**在容器内重定向，再用 `docker cp` 把文件拷出来**：

```bash
docker exec zyplayer-mysql sh -c 'mysqldump -uroot -p... --databases zyplayer_doc > /tmp/zyplayer_doc.sql'
docker cp zyplayer-mysql:/tmp/zyplayer_doc.sql ./
```

或者用 Git Bash（字节流，无此问题）。

**教训**：Windows 上任何"输出重定向到文件"的操作，涉及二进制或编码时都要警惕。容器内重定向 + docker cp 是最稳的。

### 坑 12：Git Bash 的 MSYS 路径自动转换

**现象**：

```
tar: can't open 'C:/Program Files/Git/backup/zyplayer-files.tar.gz': No such file or directory
```

**原因**：Git Bash（MSYS）调用原生 Windows 程序时，会自动把命令里**以 `/` 开头的参数**（容器内路径 `/backup`、`/backup/xxx.tar.gz`）转换成 Windows 路径。于是容器内路径变成了 `C:/Program Files/Git/backup`，容器里当然找不到。

**解决**：命令前加 `MSYS_NO_PATHCONV=1` 禁用转换：

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v navigate_zyplayer-files:/data -v "$(pwd)":/backup alpine tar czf /backup/x.tar.gz -C /data .
```

或者干脆切到 PowerShell 执行 docker 命令（PowerShell 没有 MSYS 转换）。

**教训**：**在 Windows 上，任何带容器内路径的 docker 命令都是高危操作**。要么统一 PowerShell，要么统一 Git Bash + `MSYS_NO_PATHCONV=1`，别混着来。

---

## 第四组：无域名的访问方案（坑 13-14）

### 坑 13：没有域名怎么办——SSH 隧道

服务器没绑域名（备案也不用备，韩国节点），公网暂时只给自用。最优雅的方案是 SSH 隧道，把服务器端口映射到本地：

```bash
# 本地执行，转发 app(3001) + wiki 代理(3003)
ssh -L 3001:127.0.0.1:3001 -L 3003:127.0.0.1:3003 root@服务器IP
```

然后浏览器访问 `http://localhost:3001/login`。隧道想常驻就加 `-N -f`，关闭用 `ssh -O exit`。

### 坑 14：Caddy 自动 HTTPS 必须有域名

Caddy 是最省心的反代——两行配置，自动申请/续期 Let's Encrypt 证书。但前提是**有域名且 A 记录解析到服务器**：

```caddyfile
{$DOMAIN:localhost} {
    reverse_proxy app:3001
}
```

没域名时 Caddy 只能内部跑，先用 SSH 隧道顶着，域名下来再切 HTTPS。

---

## 第五组：zyplayer 的坑（坑 15-16）

### 坑 15：改了密码，登录后马上跳回登录页

**现象**：给 zyplayer-doc 重新设了密码，重登后立刻被踢回登录页，无限循环。

**原因**：**zyplayer-doc 是前端 SPA，登录态存在浏览器 localStorage**（不是 cookie）。改密码后：
1. 浏览器里残留旧的登录态 token → 打开页面带着旧 token 请求 → 401 → 跳登录
2. 重新登录写入新 token，但残留数据没清干净，循环往复

另外如果走 navigate 的 wiki 反向代理访问，代理内部还有**会话缓存（默认 TTL 600 秒）**，改完密码必须重启 navigate 或等缓存过期。

**解决**：F12 → Application → Local Storage / Cookies → 找到 zyplayer 域 → Clear。或者直接无痕窗口测试，能登录就是残留问题。

### 坑 16：zyplayer 数据迁移 = MySQL dump + 文件卷

zyplayer-doc 的数据分两块：**MySQL 库**（`zyplayer_doc`，文档/目录/权限）+ **文件卷**（`zyplayer-files`，上传的附件）。迁移时两个都要搬：

```bash
# 导出（容器内重定向防编码坑）
docker exec zyplayer-mysql sh -c 'mysqldump -uroot -p... --databases zyplayer_doc > /tmp/z.sql'
docker cp zyplayer-mysql:/tmp/z.sql ./
# 文件卷打包
docker run --rm -v navigate_zyplayer-files:/data -v "$(pwd)":/backup alpine tar czf /backup/files.tar.gz -C /data .
```

服务器恢复时**顺序很重要**：先只起 MySQL → 导入数据 → 恢复文件卷 → 再起 zyplayer-doc（避免它抢先初始化建表冲突）。

---

## 第六组：数据迁移（坑 17-21）

### 坑 17：RAG 数据在 pg 里，pg_dump 直接搬

RAG 的文档、分块、**向量**全在 PostgreSQL。关键结论：**向量不用重算**。只要两边 embedding 模型一致（都是 `text-embedding-3-small`）、pg 版本一致（都是 17）、扩展一致，`pg_dump` 导出导入就是完整的：

```bash
# 本地（Git Bash）
docker compose exec -T postgres pg_dump -U navigate -d navigate -Fc > navigate.dump
# 服务器
cat navigate.dump | docker compose ... exec -T postgres pg_restore -U navigate -d navigate --clean --if-exists
```

### 坑 18-19：SQLite、上传文件、迁移顺序

除了 pg，还有三个尾巴：
- `navigate.db`（SQLite，简历向量索引）
- `rag_uploads/`（上传的源文档，**不迁移的话"删除/重建文档"功能会找不到源文件**）
- 会话数据（也在 pg 里，随 dump 一起走了）

迁移顺序铁律：**先让服务器把扩展建好（init-pg.sql）→ 导入数据 → 替换 SQLite/文件卷（先停 app）→ 再起服务 → 验证 count 一致**。

### 坑 20：个人镜像拉不到

`liuwenbo/pg_vector_fts:pg17` 这种个人镜像，本地能用（可能很久以前 pull 过），服务器上 `docker pull` 直接失败。**生产环境所有镜像必须来自官方仓库或自己能构建**，这是我这次最深的体会之一。

### 坑 21：服务器构建慢

一次完整构建 = postgres 编译 zhparser（5-15 分钟）+ app 的 npm ci + tsc（3-8 分钟）。缓解手段：
- **Docker layer 缓存**：先 `build postgres` 成功后再 build app，互不影响
- 多阶段构建让 runner 层尽量小
- `.dockerignore` 把 `node_modules`/`wiki-js`（4.7 万个文件！）排除，build context 从几百 MB 压到几 MB

---

## 总结：给后来者的建议

1. **Windows 用户先统一终端环境**：Git Bash 一把梭，记住 `MSYS_NO_PATHCONV=1`，二进制导出用"容器内重定向 + docker cp"
2. **Dockerfile 从"本地能跑"推演"生产怎么跑"**：静态资源、相对路径、只读文件、数据卷，逐项盘
3. **第三方扩展和镜像提前在目标环境验证**：zhparser 这类硬依赖，别等到部署才炸
4. **安全三件套**：弱密码必改、端口收内网、密钥不进镜像
5. **数据迁移先列清单**：pg 库 / SQLite / 文件卷 / 源文档，缺一个功能就残一个
6. **内存不够就 swap**，2G 机器构建 Node 项目必须做
7. **没有域名就用 SSH 隧道**，别为 HTTPS 硬着头皮等备案

部署不是把代码跑起来，而是把**代码 + 数据 + 依赖 + 安全**一起搬过去。希望这篇踩坑实录能帮你少走一半弯路。

---

*如果这篇文章对你有帮助，欢迎点赞收藏。有任何部署问题欢迎评论区交流，我会第一时间回复。*
