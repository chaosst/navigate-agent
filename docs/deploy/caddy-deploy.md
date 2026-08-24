# Caddy Deploy 步骤

## 个人服务器
- 公网地址： 43.108.102.13
- 配置：
Docker26.1.3
通用型 2 vCPU 2GiB ESSD云盘 40GiB

## 初始化服务器
### 创建 swap（2G 内存机器**必须**做，否则构建会 OOM）

```bash
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h        # 确认 Swap 行显示 4G
```


## 常用命令

- 批量传输文件
```bash
tar czf - \
  src/server/index.ts src/server/login.ts src/server/auth-helpers.ts \
  src/server/public/index.html src/server/public/resume.html src/server/public/resume-chat.html src/server/public/login.html \
  Caddyfile .env.prod.example \
  | ssh root@43.108.102.13 "tar xzf - -C /opt/navigate"
```

- SSH登录
```bash
ssh root@<你的服务器IP>
```

- SSH 隧道访问（没有域名时做本地转发）
```bash
# 转发 3001（navigate 主服务）+ 3003（wiki 代理，需要访问 zyplayer 时加）
ssh -L 3001:127.0.0.1:3001 -L 3003:127.0.0.1:3003 root@43.108.102.13
```



- 查看全局运行状态
```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

- 查看应用运行log
```bash
sudo docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f app
```

- 查看wiki运行log
```bash
sudo docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f zyplayer-doc
```

- navigate项目编译
```bash
sudo docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

- 应用环境变量更新/重启/停止
```bash
# 单独更新环境变量
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --force-recreate app
# 重启不会更新环境变量
docker compose --env-file .env.prod -f docker-compose.prod.yml restart
# 停止后再启动可以更新环境变量
docker compose --env-file .env.prod -f docker-compose.prod.yml down   # 停止（保留数据卷）
```

- 更新代码后再部署

```bash
cd /opt/navigate
# 把新代码同步上来（重传 tar 或 scp 单文件）
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

- 备份

```bash
# 1) 数据库 dump
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  pg_dump -U navigate -d navigate > backup_$(date +%F).sql

# 2) 应用数据卷（navigate.db + rag_uploads/ + skills/）
#    卷名以 docker volume ls 实际为准（通常是 navigate_appdata）
docker run --rm -v navigate_appdata:/data -v $(pwd):/backup alpine \
  tar czf /backup/appdata_$(date +%F).tar.gz -C /data .
```

- 传输文件到服务器
```bash
scp <当前目录文件名> <当前目录文件名> root@你的服务器IP:/root/
```