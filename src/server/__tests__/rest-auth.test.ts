import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequireTokenOrApiKey } from "../rest-auth.js";
import { tokenManager } from "../token.js";
import { ApiKeyStore } from "../key-store.js";

const AUTH = { keyStore: ApiKeyStore.fromEnv("sk-rest:2099-01-01T00:00:00Z", undefined) };

describe("createRequireTokenOrApiKey", () => {
  let server: Server | undefined;
  let base: string;

  async function setup(apiAuth: unknown = AUTH) {
    const app = express();
    app.use(express.json());
    app.post("/q", createRequireTokenOrApiKey(apiAuth as never), (_req, res) => {
      res.json({ ok: true });
    });
    server = app.listen(0);
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(() => {
    server?.close();
  });

  it("accepts a valid dynamic token via query param", async () => {
    await setup();
    const tok = tokenManager.generate();
    const res = await fetch(`${base}/q?token=${tok}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("accepts a valid fixed API key via Bearer", async () => {
    await setup();
    const res = await fetch(`${base}/q`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-rest" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("rejects when no credential is present", async () => {
    await setup();
    const res = await fetch(`${base}/q`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown fixed key", async () => {
    await setup();
    const res = await fetch(`${base}/q`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-wrong" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects an expired fixed key", async () => {
    await setup({ keyStore: ApiKeyStore.fromEnv("sk-old:2000-01-01T00:00:00Z", undefined) });
    const res = await fetch(`${base}/q`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-old" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects an IP outside the whitelist even with a valid key", async () => {
    await setup({ keyStore: AUTH.keyStore, ipWhitelist: ["10.0.0.0/8"] });
    const res = await fetch(`${base}/q`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-rest" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("falls back to the dynamic token even when the Bearer key is invalid", async () => {
    await setup();
    const tok = tokenManager.generate();
    const res = await fetch(`${base}/q?token=${tok}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-wrong" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });
});
