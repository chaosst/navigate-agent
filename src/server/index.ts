import express from "express";
import http from "node:http";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { PgVectorStore } from "../storage/pg-vector-store.js";
import { loadDocument } from "../rag/loader.js";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import type { ResumeStore } from "../resume/store.js";
import type { ResumeData } from "../resume/types.js";
import { tokenManager } from "./token.js";
import { findGuest, updateUserPassword } from "./users.js";
import { ZyplayerDocAdapter } from "../wiki-sync/zyplayer-doc-adapter.js";
import { ContentPoller } from "../wiki-sync/poller.js";
import { mountMcpRoutes } from "./mcp-http.js";
import type { ApiKeyAuthConfig } from "./api-key-auth.js";
import { createRequireTokenOrApiKey } from "./rest-auth.js";
import { getToken, stripTokenQuery } from "./auth-helpers.js";
import { mountLoginRoutes } from "./login.js";
import { startWikiProxy } from "./wiki-proxy.js";
import { ContextManager } from "../memory/context-manager.js";
import { sourcesFromChunk } from "./sse-sources.js";
import { ResumeTooLongError, type JdMatchResult } from "../resume/jd-analyzer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Fix Chinese filename encoding from multer (Latin-1 → UTF-8) */
function fixEncoding(str: string): string {
  try {
    const decoded = Buffer.from(str, "latin1").toString("utf8");
    return decoded !== str ? decoded : str;
  } catch {
    return str;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentExecutor = any;

interface DocMeta {
  filename: string;
  chunks: number;
  indexedAt: Date;
  /** rag_uploads/ 下的文件名（随机 hex），用于 reindex */
  storedFilename?: string;
}

/** API error helper */
function deny(res: express.Response, msg = "Invalid or expired token"): void {
  res.status(401).json({ error: msg });
}

/** Middleware: validates token or returns 401 */
function requireToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = getToken(req);
  if (tokenManager.validate(token)) {
    // Attach validated token for downstream use
    (req as any).validToken = token;
    next();
    return;
  }
  // API calls → JSON; browser page loads → HTML denied page
  deny(res);
}

/** 页面角色：体验账号可访问的页面集合 / 仅管理员的页面集合 */
const ALL_ROLES = ["admin", "guest"] as const;
const ADMIN_ROLES = ["admin"] as const;
type PageRole = "admin" | "guest";

/**
 * 页面门槛 + 角色白名单：
 * - 无有效 token/cookie → 302 到登录页（next 剥离 token，防死循环）
 * - token 有效但角色不在白名单（如体验账号访问 /admin）→ 403 denied.html「无权限」
 */
function requirePage(allowed: readonly PageRole[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const token = getToken(req);
    const identity = tokenManager.identityOf(token);
    if (!identity) {
      res.redirect(`/login?next=${encodeURIComponent(stripTokenQuery(req.originalUrl || "/"))}`);
      return;
    }
    if (!allowed.includes(identity.role)) {
      res.status(403).sendFile(path.join(__dirname, "public", "denied.html"));
      return;
    }
    (req as any).validToken = token;
    (req as any).identity = identity;
    next();
  };
}

/** 写操作 API：仅管理员（动态 token 校验 + role=admin；api-key 客户端不经此中间件） */
function requireAdminApi(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = getToken(req);
  const identity = tokenManager.identityOf(token);
  if (identity && identity.role === "admin") {
    (req as any).validToken = token;
    next();
    return;
  }
  res.status(403).json({ error: "无权限：仅管理员可执行此操作" });
}

export function createRagServer(
  store: PgVectorStore,
  port: number = 3001,
  executor?: AgentExecutor,
  resumeStore?: ResumeStore,
  resumeData?: ResumeData,
  apiAuth?: ApiKeyAuthConfig,
  resumeExecutor?: AgentExecutor,
  jdAnalyzer?: { analyze(jd: string): Promise<JdMatchResult> },
) {
  const app = express();
  const upload = multer({ dest: "rag_uploads/" });
  const docMeta = new Map<string, DocMeta>();
  const metaDir = "rag_data";
  const metaPath = path.join(metaDir, "docmeta.json");

  // Persistence helpers for docMeta
  function saveDocMeta(): void {
    try {
      mkdirSync(metaDir, { recursive: true });
      const data = Array.from(docMeta.entries()).map(([id, meta]) => ({ id, ...meta }));
      writeFileSync(metaPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.warn("[server] Could not persist docMeta:", (err as Error)?.message);
    }
  }
  function loadDocMeta(): void {
    try {
      if (!existsSync(metaPath)) return;
      const raw = readFileSync(metaPath, "utf-8");
      const items = JSON.parse(raw) as { id: string; filename: string; chunks: number; indexedAt: string; storedFilename?: string }[];
      for (const item of items) {
        docMeta.set(item.id, {
          filename: item.filename,
          chunks: item.chunks,
          indexedAt: new Date(item.indexedAt),
          storedFilename: item.storedFilename,
        });
      }
      if (items.length > 0) console.log(`[server] Restored ${items.length} document metadata entries`);
    } catch (err) {
      console.warn("[server] Could not load docMeta:", (err as Error)?.message);
    }
  }
  loadDocMeta();

  app.use(express.json({
    verify: (req: express.Request, _res: express.Response, buf: Buffer) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));

  // === H5 登录 + wiki 鉴权代理配置 ===
  const wikiProxyPort = parseInt(process.env.H5_WIKI_PROXY_PORT || "3003", 10);
  const wikiProxyTarget = process.env.H5_WIKI_TARGET || "http://localhost:8083";
  // 界面定制注入（方案 A）：默认开启，品牌名默认 "Navigate Wiki"，主题色 #519670
  const wikiHtmlInject = (process.env.H5_WIKI_INJECT ?? "true").toLowerCase() !== "false";
  const wikiBrandName = process.env.H5_WIKI_BRAND || "Navigate Wiki";
  const wikiThemeColor = process.env.H5_WIKI_THEME || "#519670";
  // 公网 wiki 地址（wiki 子域名方案，如 https://wiki.example.com）：
  // 用于 H5 页面 Wiki 链接 + 登录 next 白名单；未配置时回退 localhost（本地开发/隧道）
  const wikiPublicUrl = (process.env.H5_WIKI_PUBLIC_URL || `http://localhost:${wikiProxyPort}`).replace(/\/+$/, "");
  // 主站公网地址（如 https://example.com）：wiki 代理未登录时跳转公网登录页
  const publicBaseUrl = (process.env.H5_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const proxyOrigins = [...new Set([wikiPublicUrl, `http://localhost:${wikiProxyPort}`])];
  mountLoginRoutes(app, { proxyOrigins });

  /** 渲染 H5 页面并注入服务端变量（__WIKI_URL__ 等占位符） */
  function sendHtml(res: express.Response, file: string, vars: Record<string, string>): void {
    let html = readFileSync(path.join(__dirname, "public", file), "utf-8");
    for (const [k, v] of Object.entries(vars)) {
      html = html.split(`__${k}__`).join(v);
    }
    res.type("html").send(html);
  }

  // zyplayer-doc 适配器与轮询器（替代旧的 Wiki.js GraphQL 集成）
  let zyplayerAdapter: ZyplayerDocAdapter | undefined;
  const mysqlHost = process.env.ZYPLAYER_MYSQL_HOST;
  if (mysqlHost && process.env.ZYPLAYER_MYSQL_USER && process.env.ZYPLAYER_MYSQL_PASSWORD) {
    zyplayerAdapter = new ZyplayerDocAdapter(
      {
        host: mysqlHost,
        port: parseInt(process.env.ZYPLAYER_MYSQL_PORT || "3307", 10),
        user: process.env.ZYPLAYER_MYSQL_USER,
        password: process.env.ZYPLAYER_MYSQL_PASSWORD,
        database: process.env.ZYPLAYER_MYSQL_DB || "zyplayer_doc",
      },
      store,
    );

    const contentPoller = new ContentPoller(zyplayerAdapter);
    contentPoller.start();
  } else {
    console.log("[zyplayer-sync] Skipped (ZYPLAYER_MYSQL_* not fully configured)");
  }

  // === 固定 API key + MCP 端点(可选,未配置则 /mcp 不启用) ===
  if (apiAuth) {
    mountMcpRoutes(app, store, apiAuth);
  }

  // === Token management ===

  // 注意:初始 token 在 app.listen 成功回调里才生成并打印,
  // 端口绑定失败(EADDRINUSE)时不会打印一个永远无效的 token。

  // Get token info / check validity
  app.get("/api/token", (req, res) => {
    const token = getToken(req);
    if (token && tokenManager.validate(token)) {
      const createdAt = tokenManager.getCreatedAt(token)!;
      const expiresIn = Math.round((createdAt + 30 * 60 * 1000 - Date.now()) / 1000);
      res.json({ valid: true, token, expiresIn, createdAt });
    } else {
      res.json({ valid: false });
    }
  });

  // 当前登录身份（前端据此渲染角色相关按钮/入口：上传区、操作按钮、账号管理入口）
  app.get("/api/me", requireToken, (req, res) => {
    const identity = tokenManager.identityOf((req as any).validToken)!;
    res.json({ username: identity.username ?? null, role: identity.role, isAdmin: identity.role === "admin" });
  });

  // Generate a new token（需已登录）。继承调用者身份——防止体验账号自铸 admin token 绕过权限
  app.post("/api/token/new", requireToken, (req, res) => {
    const identity = tokenManager.identityOf((req as any).validToken)!;
    const newToken = tokenManager.generate({ username: identity.username, role: identity.role });
    res.json({ token: newToken, role: identity.role, expiresIn: 30 * 60 });
  });

  // Renew using existing valid token（同样继承身份）
  app.post("/api/token/renew", requireToken, (req, res) => {
    const identity = tokenManager.identityOf((req as any).validToken)!;
    const newToken = tokenManager.generate({ username: identity.username, role: identity.role });
    res.json({ token: newToken, role: identity.role, expiresIn: 30 * 60 });
  });

  // === Protected routes (require ?token=xxx) ===

  // 页面路由：需要登录（服务端校验 cookie/token，未登录 302 到 /login）
  app.get("/", requirePage(ALL_ROLES), (_req, res) => {
    sendHtml(res, "index.html", { WIKI_URL: wikiPublicUrl });
  });

  app.get("/resume/chat", requirePage(ALL_ROLES), (_req, res) => {
    sendHtml(res, "resume-chat.html", { WIKI_URL: wikiPublicUrl });
  });

  // 写操作（上传/重新索引/删除）仅管理员：体验账号点按钮前端提示，服务端同样 403 兜底
  app.post("/api/upload", requireAdminApi, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const docId = randomUUID();
      const filename = fixEncoding(req.file.originalname);
      const filePath = req.file.path;
      const chunks = await loadDocument(filePath, filename);
      await store.addChunks(chunks, docId);
      docMeta.set(docId, {
        filename,
        chunks: chunks.length,
        indexedAt: new Date(),
        storedFilename: req.file.filename,
      });
      saveDocMeta();

      res.json({ docId, filename, chunks: chunks.length });
    } catch (err) {
      console.error("[upload] Error:", err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/documents", createRequireTokenOrApiKey(apiAuth), async (_req, res) => {
    try {
      // 从 PostgreSQL 读取（同时预热 L1 缓存），返回格式兼容旧版
      const docs = await store.listDocs();
      res.json(docs.map((d) => ({
        id: d.id,
        filename: d.filename,
        chunks: d.chunkCount,
        indexedAt: d.indexedAt,
      })));
    } catch (err) {
      // 降级：回退到 docMeta Map
      const ids = Array.from(docMeta.entries()).map(([id, meta]) => ({
        id,
        filename: meta.filename,
        chunks: meta.chunks,
        indexedAt: meta.indexedAt,
      }));
      res.json(ids);
    }
  });

  app.delete("/api/documents/:id", requireAdminApi, async (req, res) => {
    const id = req.params.id as string;
    try {
      await store.deleteDoc(id) // 1. 删 PostgreSQL（doc_chunks 由 CASCADE 级联删除）
      docMeta.delete(id); // 2. 删旧元数据源
      saveDocMeta();
      res.json({ deleted: id });
    } catch (err) {
      console.error(`[delete] Error deleting "${id}":`, (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * 根据时间戳和文件类型，在 rag_uploads/ 中找到匹配的源文件。
   * 返回 rag_uploads/ 下的文件名；找不到返回 null。
   */
  function findStoredFile(meta: DocMeta): string | null {
    const uploadDir = path.join(process.cwd(), "rag_uploads");
    if (!existsSync(uploadDir)) return null;
    if (meta.storedFilename && existsSync(path.join(uploadDir, meta.storedFilename))) {
      return meta.storedFilename;
    }

    // 时间戳匹配：找 mtime 最接近 indexedAt 且扩展名类型一致的文件
    const ext = path.extname(meta.filename).toLowerCase();
    const indexedAtMs = meta.indexedAt.getTime();
    let best: { name: string; dist: number } | null = null;

    for (const f of readdirSync(uploadDir)) {
      const fullPath = path.join(uploadDir, f);
      if (!existsSync(fullPath) || statSync(fullPath).isDirectory()) continue;
      const fExt = path.extname(f).toLowerCase();
      // 源文件的真实类型一般和 docMeta 的 filename 一致（.pdf/.docx/.md/.txt）
      if (fExt && ext && fExt !== ext) continue;
      const dist = Math.abs(statSync(fullPath).mtimeMs - indexedAtMs);
      if (!best || dist < best.dist) best = { name: f, dist };
    }

    return best && best.dist < 10 * 60 * 1000 ? best.name : null; // 10 分钟窗口
  }

  /**
   * 重新索引：删除旧 chunk → 重新分块 → 重新写入 PostgreSQL。
   * 用于把旧系统（JSON/MemoryVectorStore）的文档迁移到新存储。
   */
  app.post("/api/reindex/:id", requireAdminApi, async (req, res) => {
    const id = req.params.id as string;
    const meta = docMeta.get(id);
    if (!meta) return res.status(404).json({ error: "Document not found" });

    try {
      const storedFile = findStoredFile(meta);
      if (!storedFile) {
        return res.status(404).json({ error: `Could not find source file for "${meta.filename}" in rag_uploads/` });
      }

      const filePath = path.join(process.cwd(), "rag_uploads", storedFile);

      // 1. 删除旧 chunk
      await store.deleteDoc(id);

      // 2. 重新分块
      const chunks = await loadDocument(filePath, meta.filename);

      // 3. 重新写入
      await store.addChunks(chunks, id);

      // 4. 更新元数据
      meta.chunks = chunks.length;
      meta.storedFilename = storedFile;
      docMeta.set(id, meta);
      saveDocMeta();

      console.log(`[reindex] "${meta.filename}": ${meta.chunks} → ${chunks.length} chunks`);
      res.json({ docId: id, filename: meta.filename, chunks: chunks.length });
    } catch (err) {
      console.error(`[reindex] Error reindexing "${meta.filename}":`, (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/stats", createRequireTokenOrApiKey(apiAuth), (_req, res) => {
    const cache = store.getCacheStats();
    res.json({ cacheEntries: cache.total, cacheDetail: cache });
  });

  app.post("/api/query", createRequireTokenOrApiKey(apiAuth), async (req, res) => {
    try {
      const { query, topK, k, threshold } = req.body;
      if (!query) return res.status(400).json({ error: "Missing query" });
      // topK 为前端实际发送的参数;k 兼容旧客户端
      let results = await store.search(query, topK ?? k ?? 5);
      if (typeof threshold === "number" && threshold > 0) {
        results = results.filter((r) => r.score >= threshold);
      }
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 纯关键词子串检索（H5 keyword 标签）
  app.post("/api/query/fts", createRequireTokenOrApiKey(apiAuth), async (req, res) => {
    try {
      const { query, topK } = req.body;
      if (!query) return res.status(400).json({ error: "Missing query" });
      const results = await store.searchKeyword(query, topK ?? 5);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // === Public routes (no token needed) ===

  // Resume display page — 需登录（体验账号与管理员均可；给 HR/面试官演示用）
  app.get("/resume", requirePage(ALL_ROLES), (_req, res) => {
    sendHtml(res, "resume.html", { WIKI_URL: wikiPublicUrl });
  });

  // Resume data API — 与页面同门槛（防绕页面直连 API 取简历数据）
  app.get("/api/resume", requireToken, async (_req, res) => {
    if (!resumeStore) return res.status(404).json({ error: "Resume not available" });
    const data = await resumeStore.getResumeData();
    if (!data) return res.status(404).json({ error: "No resume data found" });
    res.json({ ...data, sections: resumeData?.sections || [] });
  });

  // === SSE Chat (protected — token used as sessionId) ===

  const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
  const SESSION_MAX_COUNT = 100;

  interface SessionData {
    messages: { role: string; content: string }[];
    createdAt: number;
  }

  const sessions = new Map<string, SessionData>();

  function cleanSessions(): void {
    const now = Date.now();
    for (const [sid, data] of sessions) {
      if (now - data.createdAt > SESSION_MAX_AGE_MS) sessions.delete(sid);
    }
    if (sessions.size > SESSION_MAX_COUNT) {
      const sorted = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toRemove = sorted.slice(0, sorted.length - SESSION_MAX_COUNT);
      for (const [sid] of toRemove) sessions.delete(sid);
    }
  }

  app.post("/api/resume/chat", requireToken, async (req, res) => {
    // 简历问答优先使用专用 sub-agent（最小工具集 = search_resume）；
    // 未装配时回退主 executor（旧部署兼容，正常不会发生）
    const chatExecutor = resumeExecutor ?? executor;
    if (!chatExecutor) {
      return res.status(503).json({ error: "Agent executor not available" });
    }

    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Missing question" });

    // Token IS the sessionId — same token = same chat history
    const sid = (req as any).validToken;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (!sessions.has(sid)) {
      cleanSessions();
      sessions.set(sid, { messages: [], createdAt: Date.now() });
    }
    const session = sessions.get(sid)!;
    session.messages.push({ role: "user", content: question });

    let fullAnswer = "";
    // 引用溯源：收集本轮所有 search_resume 调用返回的来源（去重保序）
    const sources: string[] = [];
    try {
      const { HumanMessage, AIMessage } = await import("@langchain/core/messages");
      // 与 TUI 的 prepareTurn 对齐：全量重放前先用 token 预算截断历史，避免无限增长
      const contextMgr = new ContextManager();
      const recent = contextMgr.truncate(
        session.messages as Array<{ role: "user" | "assistant" | "system"; content: string }>,
        question,
      );
      const messages = recent.map((m) =>
        m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)
      );

      const stream = await chatExecutor.stream({ messages });
      for await (const chunk of stream) {
        // 工具调用记录 → 抽引用来源（search_resume 的 observation）
        sources.push(...sourcesFromChunk(chunk));
        if (chunk.output !== undefined && chunk.output !== null) {
          const text = String(chunk.output);
          fullAnswer += text;
          res.write(`event: token\ndata: ${JSON.stringify(text)}\n\n`);
        }
        if (typeof (res as any).flush === "function") (res as any).flush();
      }

      if (session.messages.length > 50) {
        session.messages = session.messages.slice(-50);
      }
      session.messages.push({ role: "assistant", content: fullAnswer });

      // 引用来源在最终答案之后、done 之前发出（前端缓存至本轮结束再渲染）
      if (sources.length > 0) {
        res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);
      }
      res.write(`event: done\ndata: __DONE__\n\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.write(`event: error\ndata: ${JSON.stringify(msg)}\n\n`);
    }
    res.end();
  });

  // Chat history endpoint — load past messages by token
  app.get("/api/chat/history", requireToken, (req, res) => {
    const sid = (req as any).validToken;
    const session = sessions.get(sid);
    if (!session) return res.json({ messages: [] });
    res.json({
      messages: session.messages.filter(m => m.role !== "system"),
      createdAt: session.createdAt,
    });
  });

  // === JD 匹配诊断 ===
  app.get("/resume/jd", requirePage(ALL_ROLES), (_req, res) => {
    sendHtml(res, "resume-jd.html", { WIKI_URL: wikiPublicUrl });
  });

  // === 账号管理（仅管理员；体验账号访问 → 403 denied.html）===
  app.get("/admin", requirePage(ADMIN_ROLES), (_req, res) => {
    sendHtml(res, "admin.html", { WIKI_URL: wikiPublicUrl });
  });

  // 管理员查询体验账号信息（admin.html 首屏展示用户名；未配置 → 404 提示）
  app.get("/api/admin/guest", requireAdminApi, (_req, res) => {
    const guest = findGuest();
    if (!guest) {
      return res.status(404).json({
        error: "未配置体验账号：请在 H5_LOGIN_USERS 中添加 role=guest 的账号，或设置 H5_GUEST_USERNAME/H5_GUEST_PASSWORD",
      });
    }
    res.json({ username: guest.username });
  });

  // 管理员重置体验账号密码（持久化 rag_data/h5-users.json；env 仅在文件缺失时生效）
  app.post("/api/admin/guest-password", requireAdminApi, (req, res) => {
    const { password } = (req.body ?? {}) as { password?: unknown };
    if (typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "新密码至少 6 位" });
    }
    const guest = findGuest();
    if (!guest) {
      return res.status(404).json({
        error: "未配置体验账号：请在 H5_LOGIN_USERS 中添加 role=guest 的账号，或设置 H5_GUEST_USERNAME/H5_GUEST_PASSWORD",
      });
    }
    updateUserPassword(guest.username, password);
    console.log(`[users] 体验账号 "${guest.username}" 密码已由管理员重置`);
    res.json({ ok: true, username: guest.username });
  });

  app.post("/api/resume/jd-match", requireToken, async (req, res) => {
    const { jd } = (req.body ?? {}) as { jd?: unknown };
    if (typeof jd !== "string" || !jd.trim()) {
      return res.status(400).json({ error: "Missing jd" });
    }
    if (jd.length > 4000) {
      return res.status(400).json({ error: "JD too long (>4000 chars)" });
    }
    if (!jdAnalyzer) {
      return res.status(503).json({ error: "Resume JD analyzer not available" });
    }
    try {
      const result = await jdAnalyzer.analyze(jd.trim());
      res.json(result);
    } catch (err) {
      // 简历超诊断预算 → 客户端可读的 400（改简历即可重试），其余失败 → 502
      if (err instanceof ResumeTooLongError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(502).json({ error: (err as Error).message || "JD analysis failed" });
    }
  });

  // 防止经 /index.html 等静态路径绕过登录门槛 → 重定向到带门槛的规范路由
  app.get(["/index.html", "/resume.html", "/resume/chat.html", "/resume/jd.html", "/admin.html"], (req, res) => {
    const map: Record<string, string> = {
      "/index.html": "/", "/resume.html": "/resume",
      "/resume/chat.html": "/resume/chat", "/resume/jd.html": "/resume/jd",
      "/admin.html": "/admin",
    };
    res.redirect(302, map[req.path] || "/");
  });

  // Serve public directory for wiki static assets
  app.use(express.static(path.join(__dirname, "public")));

  // Favicon — silent 204
  app.get("/favicon.ico", (_req, res) => res.status(204).end());

  // Catch‑all
  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  let wikiProxyServer: http.Server | undefined;
  const server = app.listen(port, () => {
    console.log(`RAG server on http://localhost:${port}`);
    console.log(`\n🔑 登录入口: http://localhost:${port}/login （H5 页面均需登录）`);
    try {
      wikiProxyServer = startWikiProxy({
        port: wikiProxyPort,
        target: wikiProxyTarget,
        loginUrl: publicBaseUrl ? `${publicBaseUrl}/login` : `http://localhost:${port}/login`,
        proxyOrigin: wikiPublicUrl,
        wikiUsername: process.env.H5_WIKI_USERNAME,
        wikiPassword: process.env.H5_WIKI_PASSWORD,
        wikiLoginMode: process.env.H5_WIKI_LOGIN_MODE === "rsa" || process.env.H5_WIKI_LOGIN_MODE === "json"
          ? process.env.H5_WIKI_LOGIN_MODE
          : "form",
        wikiLoginPath: process.env.H5_WIKI_LOGIN_PATH,
        wikiLoginCsrf: process.env.H5_WIKI_LOGIN_CSRF !== "false",
        wikiSessionTtlSec: parseInt(process.env.H5_WIKI_SESSION_TTL_SEC || "600", 10),
        htmlInject: { enabled: wikiHtmlInject, brand: wikiBrandName, theme: wikiThemeColor },
      });
    } catch (err) {
      console.error(`❌ Wiki 代理启动失败: ${(err as Error).message}`);
    }
    // 运维后门：仍打印一次性 token（日志只对运维可见）
    const initialToken = tokenManager.generate();
    console.log(`   (运维) Access token: ${initialToken} — 可经 /?token=${initialToken} 直接进入`);
  });

  // 主服务关闭时一并关闭 wiki 代理（测试与优雅停机都需要）
  server.on("close", () => { wikiProxyServer?.close(); });
  // 暴露底层 http server，便于测试读取监听端口/优雅关闭
  (app as unknown as { httpServer: http.Server }).httpServer = server;

  server.on("error", (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      console.error(`\n❌ 端口 ${port} 已被占用,可能已有另一个服务实例在运行。`);
      console.error(`   本次启动未绑定成功,不会打印有效 token。请先结束占用端口的进程再重启:`);
      console.error(`   netstat -ano | findstr :${port}   ← 找到 PID`);
      console.error(`   taskkill //PID <上面的PID> //F\n`);
      process.exit(1);
    }
    throw err;
  });

  return app;
}
