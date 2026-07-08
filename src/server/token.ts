import { randomUUID } from "node:crypto";

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface TokenEntry {
  token: string;
  createdAt: number;
}

class TokenManager {
  private tokens = new Map<string, TokenEntry>();

  /** Generate a new access token */
  generate(): string {
    this.cleanExpired();
    const token = randomUUID().replace(/-/g, "").slice(0, 12);
    this.tokens.set(token, { token, createdAt: Date.now() });
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
