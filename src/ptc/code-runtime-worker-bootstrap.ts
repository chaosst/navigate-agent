/**
 * Worker 侧执行器（每次 run() 启动一个全新 Worker 加载本文件）。
 *
 * 安全假设：运行模型代码，对端（主线程）视为敌对方 ——
 * - tools 全局为空原型 Proxy：__proto__/constructor/toString 都是普通自有属性，无原型碰撞；
 * - 端口协议只认 { type: "reply", id }：未知 id、结算后消息一律忽略；
 * - 仅使用可擦除 TypeScript（enum/namespace 等由主线程剥离阶段拒绝）。
 *
 * 对应设计文档 §5.5。
 */
import { parentPort, workerData } from "node:worker_threads";

type ReplyMessage =
  | { type: "reply"; id: number; ok: true; value?: unknown }
  | { type: "reply"; id: number; ok: false; message?: string };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  name: string;
}

const program: string = workerData.program as string;

let nextId = 1;
const pending = new Map<number, PendingCall>();

/** 程序可见的带类型拒绝错误（成员属性 toolName 由真实构造器注入） */
class ToolCallError extends Error {
  toolName: string;

  constructor(toolName: string, message: string) {
    super(message);
    this.name = "ToolCallError";
    this.toolName = toolName;
  }
}

// console shim：捕获程序输出，按序随 done/error 一并回传（channel 元数据不是接缝的一部分）
const logs: string[] = [];
const consoleShim: Record<string, (...args: unknown[]) => void> = {
  log: (...args) => logs.push(args.map(String).join(" ")),
  info: (...args) => logs.push(args.map(String).join(" ")),
  warn: (...args) => logs.push("[warn] " + args.map(String).join(" ")),
  error: (...args) => logs.push("[error] " + args.map(String).join(" ")),
};

type BindingFn = (args: unknown) => Promise<unknown>;

/**
 * tools 全局对象：空原型 Proxy。程序访问任意属性（tools["x"]）都会拿到一个
 * 绑定函数（工具名在闭包中捕获），调用经 postMessage 转发到主线程分发桥执行。
 */
const tools: Record<string, BindingFn> = new Proxy(
  Object.create(null) as Record<string, BindingFn>,
  {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      const cached = target[prop];
      if (cached) return cached;
      const name = prop;
      const fn: BindingFn = (args: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject, name });
          parentPort?.postMessage({ type: "call", id, global: "tools", name, args });
        });
      target[name] = fn;
      return fn;
    },
  },
);

parentPort?.on("message", (msg: ReplyMessage) => {
  if (!msg || msg.type !== "reply") return; // 未知消息：忽略（对端敌对假设）
  const p = pending.get(msg.id);
  if (!p) return; // 未知/重复/结算后 id：忽略
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.value);
  else p.reject(new ToolCallError(p.name, msg.message ?? "Unknown error"));
});

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as unknown as new (
  ...params: string[]
) => (...args: unknown[]) => Promise<unknown>;

async function main(): Promise<void> {
  try {
    // 程序体是 async 函数体；tools/ToolCallError/console 作为参数注入
    const fn = new AsyncFunctionCtor("tools", "ToolCallError", "console", program);
    const value = await fn(tools, ToolCallError, consoleShim);
    try {
      parentPort?.postMessage({ type: "done", value, logs });
    } catch (cloneErr) {
      // 完成值不可结构化克隆（非无损 JSON）→ invalid-output
      const message = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
      parentPort?.postMessage({ type: "error", kind: "invalid-output", message, logs });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ type: "error", message, logs });
  }
}

void main();
