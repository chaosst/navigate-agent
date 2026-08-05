import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { AUTH_COOKIE, getCookie, serializeCookie, getToken } from "./auth-helpers.js";

describe("getCookie", () => {
  it("reads a named cookie value (URL-decoded) from the header", () => {
    expect(getCookie({ cookie: "a=1; navigate_token=abc%20def; b=2" }, AUTH_COOKIE)).toBe("abc def");
  });
  it("returns undefined when header missing or name absent", () => {
    expect(getCookie({}, AUTH_COOKIE)).toBeUndefined();
    expect(getCookie({ cookie: "a=1" }, AUTH_COOKIE)).toBeUndefined();
  });
});

describe("serializeCookie", () => {
  it("serializes with Path=/, HttpOnly, Max-Age and SameSite=Lax", () => {
    const s = serializeCookie(AUTH_COOKIE, "tok", { httpOnly: true, maxAgeSec: 1800, sameSite: "Lax" });
    expect(s).toContain("navigate_token=tok");
    expect(s).toContain("HttpOnly");
    expect(s).toContain("Max-Age=1800");
    expect(s).toContain("SameSite=Lax");
    expect(s).toContain("Path=/");
  });
});

describe("getToken", () => {
  it("prefers query token, then body token, then cookie", () => {
    expect(getToken({ query: { token: "q" } } as unknown as Request)).toBe("q");
    expect(getToken({ body: { token: "b" } } as unknown as Request)).toBe("b");
    expect(getToken({ headers: { cookie: "navigate_token=c" } } as unknown as Request)).toBe("c");
  });
});
