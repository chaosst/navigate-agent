import { randomUUID } from "node:crypto";
import type { H5Role } from "./users.js";

export const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** token 携带的登录身份；运维后门 token 无 username（role 缺省 admin） */
export interface TokenIdentity {
  username?: string;
  role: H5Role;
}

interface TokenEntry {
  token: string;
  createdAt: number;
  identity: TokenIdentity;
}

class TokenManager {
  private tokens = new Map<string, TokenEntry>();

  /**
   * Generate a new access token.
   * 登录后携带 {username, role}；无参调用（运维后门/旧客户端）→ role=admin，可全权。
   */
  generate(identity?: Partial<TokenIdentity>): string {
    this.cleanExpired();
    const token = randomUUID().replace(/-/g, "").slice(0, 12);
    this.tokens.set(token, {
      token,
      createdAt: Date.now(),
      identity: { role: identity?.role ?? "admin", username: identity?.username },
    });
    return token;
  }

  /** Validate a token: exists and not expired */
  validate(token: string | undefined | null): boolean {
    if (!token) return false;
    const entry = this.tokens.get(token);
    if (!entry) return false;
    if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  /** 取 token 绑定的身份：token 有效返回 identity，无效/过期返回 null（内部隐含 validate） */
  identityOf(token: string | undefined | null): TokenIdentity | null {
    if (!token) return null;
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
      this.tokens.delete(token);
      return null;
    }
    return entry.identity;
  }

  /** 主动吊销一个 token（退出登录用） */
  revoke(token: string | undefined | null): void {
    if (!token) return;
    this.tokens.delete(token);
  }

  /** Get token creation time (for display / refresh hint) */
  getCreatedAt(token: string): number | null {
    const entry = this.tokens.get(token);
    return entry ? entry.createdAt : null;
  }

  /** Remove expired tokens */
  cleanExpired(): void {
    const now = Date.now();
    for (const [t, entry] of this.tokens) {
      if (now - entry.createdAt > TOKEN_TTL_MS) this.tokens.delete(t);
    }
  }

  /** Number of active tokens */
  get size(): number {
    this.cleanExpired();
    return this.tokens.size;
  }
}

export const tokenManager = new TokenManager();
