/**
 * H5 登录账号模型（admin / 体验账号 guest）。
 *
 * 简单方式的取舍：
 * - 账号默认来自 env（H5_LOGIN_USERS 多账号 JSON，或 H5_LOGIN_USERNAME/PASSWORD +
 *   H5_GUEST_USERNAME/H5_GUEST_PASSWORD 单账号对），role 用于页面/API 鉴权。
 * - 管理员在 /admin 页改密后，全量用户表落盘到 rag_data/h5-users.json
 *   （该目录已 gitignore，容器内落在 appdata:/app/data 卷，重启不丢）。
 * - 文件存在则以文件为准（此后改 .env 密码不再生效，需改文件或删文件重启）；
 *   文件不存在时 env 始终生效——只要没在页面上改过密，运维改 .env 无需额外步骤。
 * - 密码沿用明文（与现状 env 同级，面试演示够用；如需 hash 后续可换）。
 */
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type H5Role = "admin" | "guest";

export interface H5User {
  username: string;
  password: string;
  role: H5Role;
}

/** 每次调用解析路径，便于测试用 H5_USERS_FILE 注入隔离文件 */
export function h5UsersFilePath(): string {
  const override = process.env.H5_USERS_FILE?.trim();
  return override || path.join(process.cwd(), "rag_data", "h5-users.json");
}

/** 未知/非法 role 一律收敛为 admin（兼容旧配置：只写 username/password 的账号都是管理员） */
function parseRole(role: unknown): H5Role {
  return role === "guest" ? "guest" : "admin";
}

interface EnvUserSpec {
  username?: unknown;
  password?: unknown;
  role?: unknown;
}

/**
 * env 种子用户（不读文件）。
 * 1) H5_LOGIN_USERS=[{"username":"alice","password":"pw1","role":"admin"}...]
 *    多账号 JSON；role 可选，缺省 admin。格式非法时回退下面的单账号对。
 * 2) H5_LOGIN_USERNAME + H5_LOGIN_PASSWORD        → admin（现状兼容）
 *    H5_GUEST_USERNAME(默认 guest) + H5_GUEST_PASSWORD → guest（可选，不配则无体验账号）
 */
export function envSeedUsers(): H5User[] {
  const raw = process.env.H5_LOGIN_USERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as EnvUserSpec[];
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((c) => c && typeof c.username === "string" && typeof c.password === "string")
      ) {
        return parsed.map((c) => ({
          username: c.username as string,
          password: c.password as string,
          role: parseRole(c.role),
        }));
      }
    } catch {
      /* 格式错误则忽略，回退单账号对 */
    }
  }
  const list: H5User[] = [];
  const u = process.env.H5_LOGIN_USERNAME;
  const p = process.env.H5_LOGIN_PASSWORD;
  if (u && p) list.push({ username: u, password: p, role: "admin" });
  const guestName = (process.env.H5_GUEST_USERNAME || "guest").trim() || "guest";
  const guestPass = process.env.H5_GUEST_PASSWORD;
  if (guestPass) list.push({ username: guestName, password: guestPass, role: "guest" });
  return list;
}

function readFileUsers(): H5User[] | null {
  const file = h5UsersFilePath();
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as H5User[];
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((u) => u && typeof u.username === "string" && typeof u.password === "string")
      .map((u) => ({ username: u.username, password: u.password, role: parseRole(u.role) }));
  } catch {
    return null; // 损坏文件按缺失处理，回退 env；下次改密会整体覆盖
  }
}

/** 当前用户表：文件存在以文件为准，否则 env 种子 */
export function listUsers(): H5User[] {
  return readFileUsers() ?? envSeedUsers();
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function authenticate(username: unknown, password: unknown): H5User | undefined {
  if (typeof username !== "string" || typeof password !== "string") return undefined;
  return listUsers().find((u) => safeEqual(u.username, username) && safeEqual(u.password, password));
}

/** 体验账号（role=guest 的第一个）；未配置返回 undefined */
export function findGuest(): H5User | undefined {
  return listUsers().find((u) => u.role === "guest");
}

/**
 * 改密并持久化。基于当前用户表全量落盘：
 * - 文件不存在 → 首次写入内容 = env 种子 + 新密码（此后 env 修改不再生效，见文件头注释）
 * - 返回是否找到并更新目标用户
 */
export function updateUserPassword(username: string, newPassword: string): boolean {
  const users = listUsers();
  const target = users.find((u) => u.username === username);
  if (!target) return false;
  target.password = newPassword;
  const file = h5UsersFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(users, null, 2), "utf-8");
  return true;
}
