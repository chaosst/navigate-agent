import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import {
  envSeedUsers,
  listUsers,
  authenticate,
  findGuest,
  updateUserPassword,
  h5UsersFilePath,
} from "./users.js";

let tmpDir: string;
let usersFile: string;

function resetEnv(): void {
  delete process.env.H5_LOGIN_USERS;
  delete process.env.H5_LOGIN_USERNAME;
  delete process.env.H5_LOGIN_PASSWORD;
  delete process.env.H5_GUEST_USERNAME;
  delete process.env.H5_GUEST_PASSWORD;
  process.env.H5_USERS_FILE = usersFile;
}

describe("envSeedUsers (env only, no file)", () => {
  beforeEach(() => { resetEnv(); });

  it("parses H5_LOGIN_USERS with role, defaulting to admin", () => {
    process.env.H5_LOGIN_USERS = JSON.stringify([
      { username: "alice", password: "pw1" },
      { username: "guest", password: "pw2", role: "guest" },
    ]);
    expect(envSeedUsers()).toEqual([
      { username: "alice", password: "pw1", role: "admin" },
      { username: "guest", password: "pw2", role: "guest" },
    ]);
  });

  it("falls back to single admin pair when H5_LOGIN_USERS is malformed", () => {
    process.env.H5_LOGIN_USERS = "not-json";
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    expect(envSeedUsers()).toEqual([{ username: "admin", password: "secret", role: "admin" }]);
  });

  it("builds admin + guest from H5_LOGIN_USERNAME/PASSWORD and H5_GUEST_* (backward compatible)", () => {
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_GUEST_USERNAME = "hr";
    process.env.H5_GUEST_PASSWORD = "guestpass";
    expect(envSeedUsers()).toEqual([
      { username: "admin", password: "secret", role: "admin" },
      { username: "hr", password: "guestpass", role: "guest" },
    ]);
  });

  it("defaults guest username to 'guest'", () => {
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_GUEST_PASSWORD = "gp";
    const guest = envSeedUsers().find((u) => u.role === "guest");
    expect(guest?.username).toBe("guest");
  });

  it("returns empty list when nothing is configured", () => {
    expect(envSeedUsers()).toEqual([]);
  });
});

describe("file precedence + password reset", () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "h5-users-test-"));
    usersFile = path.join(tmpDir, "h5-users.json");
  });
  afterAll(() => {
    resetEnv();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // 每个用例从「无文件」状态开始：文件仅由 updateUserPassword 惰性创建
  beforeEach(() => {
    resetEnv();
    process.env.H5_LOGIN_USERNAME = "admin";
    process.env.H5_LOGIN_PASSWORD = "secret";
    process.env.H5_GUEST_PASSWORD = "guest123";
    if (existsSync(usersFile)) rmSync(usersFile, { force: true });
  });

  it("authenticates against env seed when file is absent", () => {
    expect(h5UsersFilePath()).toBe(usersFile);
    expect(existsSync(usersFile)).toBe(false);
    expect(authenticate("admin", "secret")).toMatchObject({ role: "admin" });
    expect(authenticate("guest", "guest123")).toMatchObject({ role: "guest" });
    expect(authenticate("guest", "wrong")).toBeUndefined();
    expect(findGuest()?.username).toBe("guest");
  });

  it("updateUserPassword creates the file and takes effect immediately", () => {
    expect(updateUserPassword("guest", "newpass1")).toBe(true);
    expect(existsSync(usersFile)).toBe(true);

    const saved = JSON.parse(readFileSync(usersFile, "utf-8")) as { username: string; password: string; role: string }[];
    expect(saved).toContainEqual({ username: "admin", password: "secret", role: "admin" });
    expect(saved).toContainEqual({ username: "guest", password: "newpass1", role: "guest" });

    // 文件存在后以文件为准：旧 env 密码失效、新密码生效
    expect(authenticate("guest", "guest123")).toBeUndefined();
    expect(authenticate("guest", "newpass1")).toMatchObject({ role: "guest" });
    expect(authenticate("admin", "secret")).toMatchObject({ role: "admin" }); // admin 不受影响
  });

  it("file wins over env once written (changing env does not leak in)", () => {
    updateUserPassword("guest", "newpass1");
    process.env.H5_GUEST_PASSWORD = "env-tries-to-override";
    expect(listUsers().find((u) => u.username === "guest")?.password).toBe("newpass1");
    expect(authenticate("guest", "env-tries-to-override")).toBeUndefined();
  });

  it("updateUserPassword on unknown user returns false and writes nothing", () => {
    expect(updateUserPassword("nobody", "whatever1")).toBe(false);
    expect(existsSync(usersFile)).toBe(false);
  });

  it("findGuest is undefined when no guest configured", () => {
    delete process.env.H5_GUEST_PASSWORD;
    expect(findGuest()).toBeUndefined();
  });
});
