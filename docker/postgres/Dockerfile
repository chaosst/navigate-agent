# PostgreSQL 17 + pgvector + zhparser(中文分词)
# 用途：liuwenbo/pg_vector_fts:pg17 个人镜像在服务器拉取失败时的 fallback。
# 基于官方 pgvector 镜像编译安装 SCWS + zhparser（Debian bookworm + pgdg 17）。
#
# 注意：Debian bookworm 仓库没有 libscws-dev 包，SCWS 必须源码编译。
#
# 构建：
#   docker compose --env-file .env.prod -f docker-compose.prod.yml build postgres
FROM pgvector/pgvector:pg17

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        postgresql-server-dev-17 \
        git \
        ca-certificates \
        wget \
        autoconf \
        automake \
        libtool \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

# 1) 编译安装 SCWS（中文分词库，zhparser 的底层依赖）
#    GitHub 源码包不含 configure，用源码自带的 acprep 脚本生成
RUN wget -q https://github.com/hightman/scws/archive/refs/tags/1.2.3.tar.gz -O /tmp/scws.tar.gz \
    && mkdir -p /tmp/scws \
    && tar xzf /tmp/scws.tar.gz -C /tmp/scws --strip-components=1 \
    && cd /tmp/scws \
    && ./acprep \
    && ./configure --prefix=/usr/local \
    && make -j"$(nproc)" \
    && make install \
    && ldconfig \
    && cd / \
    && rm -rf /tmp/scws /tmp/scws.tar.gz

# 2) 编译安装 zhparser（适配 PG17）
RUN git clone --depth 1 https://github.com/amutu/zhparser.git /tmp/zhparser \
    && cd /tmp/zhparser \
    && make PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config SCWS_HOME=/usr/local \
    && make install PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config SCWS_HOME=/usr/local \
    && rm -rf /tmp/zhparser
