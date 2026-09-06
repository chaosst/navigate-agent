import express from "express";
import { randomBytes, randomInt } from "node:crypto";
import { getCookie, serializeCookie } from "./auth-helpers.js";

/**
 * 条件式登录校验码（防暴力破解 / 撞库，非图形验证码依赖的第三方实现）。
 *
 * 设计要点：
 * - 只有同一 IP 或账号累计失败 ≥2 次后，登录才要求额外校验码 —— 正常用户无感
 *   （escalation 策略），可疑流量被拖慢。
 * - 答案只存服务端内存（challengeId → answer），4 位码以手写 5x7 点阵 + 24bit BMP
 *   渲染成图片下发，响应/HTML 中无明文 —— 脚本无法正则/JSON 解析绕过，必须图像识别。
 * - 挑战一次性：答错/用毕立即销毁；TTL 5 分钟；每 IP 未消费挑战 ≤5 防刷内存。
 * - 会话绑定：创建挑战时种 httpOnly sid cookie，取图/校验需携带同一 sid。
 */

/** 匿名会话 cookie（仅用于把挑战状态绑定到浏览器会话，非登录态） */
export const SID_COOKIE = "navigate_sid";

/** 校验码字符集：去 0/O/1/I/L/S/B 等易混字符 */
export const CODE_CHARSET = "23456789ACDEF";
export const CODE_LEN = 4;
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** 每 IP 允许的未消费挑战上限（防刷内存） */
const MAX_ACTIVE_PER_IP = 5;

// ── 5x7 点阵字模（LSB=左列，bit4..0 对应列 0..4）─────────────────────────────
const FONT_5X7: Record<string, number[]> = {
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
};

type Challenge = { answer: string; sid: string; ip: string; createdAt: number };
type ConsumeVerdict = "ok" | "missing" | "expired" | "wrong";

export const challengeStore = {
  /** 生成并登记一个挑战，返回 { challengeId, answer }（answer 仅供测试直查，不下发前端） */
  create(sid: string, ip: string): { challengeId: string; answer: string } {
    sweep();
    // 每 IP 活跃挑战上限：删除该 IP 最老的，防单 IP 刷爆内存
    const mine = [...challenges.entries()].filter(([, c]) => c.ip === ip).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (mine.length >= MAX_ACTIVE_PER_IP) {
      const [oldestId] = mine.shift()!;
      challenges.delete(oldestId);
    }
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) code += CODE_CHARSET[randomInt(CODE_CHARSET.length)];
    const challengeId = randomBytes(8).toString("hex");
    challenges.set(challengeId, { answer: code, sid, ip, createdAt: Date.now() });
    return { challengeId, answer: code };
  },

  get(id: string): Challenge | undefined {
    sweep();
    return challenges.get(id);
  },

  /** 一次性消费：正确 → ok（销毁）；错误 → wrong（销毁）；过期/缺失/sid 不符 → 其余（不销毁可重试/不可见） */
  consume(sid: string | undefined, challengeId: unknown, code: unknown): ConsumeVerdict {
    sweep();
    if (typeof challengeId !== "string" || typeof code !== "string") return "missing";
    const c = challenges.get(challengeId);
    if (!c) return "missing";
    if (c.sid !== sid) return "missing"; // 会话不匹配视为不可见，避免泄露挑战是否存在
    if (Date.now() - c.createdAt > CHALLENGE_TTL_MS) {
      challenges.delete(challengeId);
      return "expired";
    }
    challenges.delete(challengeId); // 一次性：无论对错都销毁
    const guess = code.trim().toUpperCase();
    return guess === c.answer ? "ok" : "wrong";
  },

  clear(): void { challenges.clear(); },
};

const challenges = new Map<string, Challenge>();

function sweep(): void {
  const cutoff = Date.now() - CHALLENGE_TTL_MS;
  for (const [id, c] of challenges) if (c.createdAt < cutoff) challenges.delete(id);
}

// ── 24bit BMP 渲染（点阵放大 + 噪点 + 干扰线，无第三方依赖）──────────────────
function renderCodeBmp(code: string): Buffer {
  const scale = 8;      // 每字模像素放大倍数
  const gapX = 20;      // 字符间距
  const padX = 16;
  const padTop = 14;
  const cellW = 5 * scale;
  const cellH = 7 * scale;
  const width = padX * 2 + code.length * cellW + (code.length - 1) * gapX;
  const height = padTop + cellH + 14;
  const rowSize = Math.ceil((width * 3) / 4) * 4;

  const buf = Buffer.alloc(54 + rowSize * height);
  // BMP 文件头 + DIB 头（24bit，无压缩）
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(54 + rowSize * height, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * height, 34);
  buf.writeInt32LE(2835, 38); // 72dpi
  buf.writeInt32LE(2835, 42);

  // 白底
  for (let i = 54; i < buf.length; i++) buf[i] = 255;

  const px = (x: number, y: number, r: number, g: number, b: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const off = 54 + (height - 1 - y) * rowSize + x * 3;
    buf[off] = b; buf[off + 1] = g; buf[off + 2] = r;
  };

  // 每个字符：随机纵向偏移 + 逐行逐列填充放大的点
  code.split("").forEach((ch, idx) => {
    const glyph = FONT_5X7[ch];
    if (!glyph) return;
    const x0 = padX + idx * (cellW + gapX);
    const y0 = padTop + randomInt(7); // 纵向抖动，破坏对齐特征
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (!(bits & (16 >> col))) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            px(x0 + col * scale + dx, y0 + row * scale + dy, 20, 20, 20);
          }
        }
      }
    }
  });

  // 噪点（~0.4%）：黑色杂点，干扰像素级识别（密度过高会影响真人阅读）
  for (let i = 0; i < width * height * 0.004; i++) {
    px(randomInt(width), randomInt(height), 40, 40, 40);
  }
  // 干扰线（浅灰细线，干扰线条提取）
  for (let n = 0; n < 2; n++) {
    const x1 = randomInt(width), x2 = x1 + randomInt(30) + 20;
    const y1 = randomInt(height), y2 = y1 + randomInt(20) - 10;
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let t = 0; t <= steps; t++) {
      px(Math.round(x1 + ((x2 - x1) * t) / steps), Math.round(y1 + ((y2 - y1) * t) / steps), 190, 190, 190);
    }
  }
  return buf;
}

// ── 路由 ────────────────────────────────────────────────────────────────────
function getSid(req: express.Request): string | undefined {
  return getCookie(req.headers, SID_COOKIE);
}

function ensureSid(req: express.Request, res: express.Response): string {
  const existing = getSid(req);
  if (existing) return existing;
  const sid = randomBytes(16).toString("hex");
  res.setHeader("Set-Cookie", serializeCookie(SID_COOKIE, sid, {
    httpOnly: true, sameSite: "Lax", secure: process.env.H5_COOKIE_SECURE === "true",
  }));
  return sid;
}

export function mountChallengeRoutes(app: express.Express): void {
  // 领取新挑战（需要浏览器会话：无 sid 则种一个 httpOnly cookie）
  app.get("/api/login/challenge", (req, res) => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const sid = ensureSid(req, res);
    const { challengeId } = challengeStore.create(sid, ip);
    res.setHeader("Cache-Control", "no-store");
    res.json({ challengeId });
  });

  // 校验码图片（答案只在服务端，图片无明文）
  app.get("/api/login/challenge/:id/image", (req, res) => {
    const c = challengeStore.get(req.params.id);
    if (!c || c.sid !== getSid(req)) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Type", "image/bmp");
    res.setHeader("Cache-Control", "no-store, private");
    res.send(renderCodeBmp(c.answer));
  });
}
