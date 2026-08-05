import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ipMatchesWhitelist, type ApiKeyAuthConfig } from "./api-key-auth.js";
import { tokenManager } from "./token.js";
import { getToken } from "./auth-helpers.js";

function deny401(res: Response): void {
  res.status(401).json({ error: "Invalid or expired token" });
}

/**
 * 动态 token(query 参数或 body)或固定 API key(Authorization: Bearer sk-xxx)
 * 任一有效即放行。用于需要兼容旧动态 token 客户端的 REST 查询接口
 * (/api/query、/api/query/fts),便于本地桥等以固定 key 调用。
 */
export function createRequireTokenOrApiKey(apiAuth?: ApiKeyAuthConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1) 旧方式:动态 token
    const token = getToken(req);
    if (token && tokenManager.validate(token)) {
      (req as { validToken?: string }).validToken = token;
      return next();
    }

    // 2) 固定 API key:Bearer
    if (apiAuth) {
      const ip = req.ip ?? req.socket?.remoteAddress ?? "";
      if (apiAuth.ipWhitelist && apiAuth.ipWhitelist.length > 0 && !ipMatchesWhitelist(ip, apiAuth.ipWhitelist)) {
        return deny401(res);
      }
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        const key = authHeader.slice("Bearer ".length).trim();
        const entry = apiAuth.keyStore.lookup(key);
        if (entry && !apiAuth.keyStore.isExpired(entry)) {
          (req as { validToken?: string }).validToken = key;
          return next();
        }
      }
    }

    return deny401(res);
  };
}
