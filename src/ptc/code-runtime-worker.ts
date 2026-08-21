/**
 * WorkerThreadCodeRuntime —— PTC 沙箱运行时的 worker_threads 后端。
 *
 * 对应设计文档 §5.5。关键决策：
 * - 每次 run() 启动一个**全新** Worker（空 env、resourceLimits），无池化、无跨运行状态；
 * - 类型剥离在主线程预检：仅剥离模式拒绝不可擦除语法（enum/namespace 等），
 *   语法级失败**从不生成 worker**；错误行号与模型源码一致（Node 原生 stripTypeScriptTypes）；
 * - 绑定调用走端口协议（假设对端敌对）：worker "call" → 宿主执行 → "reply"；
 * - 失败六类正交：exception / timeout / abort / worker-exit / invalid-output / output-limit。
 */
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { existsSync } from "node:fs";
import type { CodeRuntime } from "./code-runtime.js";
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunRequest,
  CodeRunResult,
} from "./types.js";

/** WorkerThreadCodeRuntime 预算配置（均有默认值） */
export interface WorkerCodeRuntimeConfig {
  /** 单次 run 的墙钟上限（ms），默认 60_000 */
  maxWallMs?: number;
  /** 外层 logs+完成值序列化字节上限，默认 64KB（中间绑定值不计） */
  maxOutputBytes?: number;
  /** worker 老生代堆上限（MB），默认 128 */
  maxOldGenerationSizeMb?: number;
  /** worker 新生代堆上限（MB），默认 32 */
  maxYoungGenerationSizeMb?: number;
}

/** worker → host 消息（call 为程序内绑定调用；done/error 为结算） */
type WorkerToHost =
  | { type: "call"; id: number; global: string; name: string; args: unknown }
  | { type: "done"; value?: unknown; logs: string[] }
  | { type: "error"; kind?: "exception" | "invalid-output"; message: string; logs: string[] };

/** host → worker 消息（绑定调用回复） */
type HostToWorker =
  | { type: "reply"; id: number; ok: true; value: unknown }
  | { type: "reply"; id: number; ok: false; message: string };

type StripResult = { ok: true; code: string } | { ok: false; error: string };

type Stripper = (code: string, options?: { mode?: "strip" }) => string;

export class WorkerThreadCodeRuntime implements CodeRuntime {
  readonly language = "typescript" as const;
  readonly isolation = "worker-thread" as const;

  private readonly config: Required<WorkerCodeRuntimeConfig>;
  private readonly activeWorkers = new Set<Worker>();
  private stripperPromise: Promise<void> | null = null;
  private stripper: Stripper | undefined;

  constructor(config: WorkerCodeRuntimeConfig = {}) {
    this.config = {
      maxWallMs: config.maxWallMs ?? 60_000,
      maxOutputBytes: config.maxOutputBytes ?? 64 * 1024,
      maxOldGenerationSizeMb: config.maxOldGenerationSizeMb ?? 128,
      maxYoungGenerationSizeMb: config.maxYoungGenerationSizeMb ?? 32,
    };
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    // 1. 类型剥离预检：失败直接返回，不创建 worker
    await this.ensureStripper();
    const stripped = this.stripTypes(request.program);
    if (!stripped.ok) {
      return { logs: [], error: { kind: "exception", message: stripped.error } };
    }

    const { maxWallMs, maxOutputBytes } = this.config;

    return new Promise<CodeRunResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const worker = this.spawnWorker(stripped.code);

      const finish = (result: CodeRunResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        worker.removeAllListeners();
        this.activeWorkers.delete(worker);
        void worker.terminate().catch(() => undefined);
        resolve(result);
      };

      const onAbort = (): void => {
        finish({ logs: [], error: { kind: "abort", message: "Program aborted by caller" } });
      };

      const onMessage = (raw: unknown): void => {
        if (settled) return;
        const msg = raw as WorkerToHost;
        if (msg?.type === "call") {
          void this.handleCall(worker, request.bindings, msg);
          return;
        }
        if (msg?.type === "done") {
          const limit = this.checkOutputLimit(msg.logs, msg.value, maxOutputBytes);
          if (limit) {
            finish({ logs: msg.logs, error: { kind: "output-limit", message: limit } });
          } else {
            const result: CodeRunResult = { logs: msg.logs };
            if (msg.value !== undefined) result.value = msg.value as CodeJsonValue;
            finish(result);
          }
          return;
        }
        if (msg?.type === "error") {
          const limit = this.checkOutputLimit(msg.logs, undefined, maxOutputBytes);
          if (limit) {
            finish({ logs: msg.logs, error: { kind: "output-limit", message: limit } });
          } else {
            finish({
              logs: msg.logs,
              error: { kind: msg.kind ?? "exception", message: msg.message },
            });
          }
        }
      };

      const onWorkerError = (err: Error): void => {
        if (!settled) {
          finish({ logs: [], error: { kind: "worker-exit", message: `Worker error: ${err.message}` } });
        }
      };

      const onExit = (code: number): void => {
        if (!settled) {
          finish({
            logs: [],
            error: { kind: "worker-exit", message: `Execution substrate exited unexpectedly (code ${code})` },
          });
        }
      };

      worker.on("message", onMessage);
      worker.on("error", onWorkerError);
      worker.on("exit", onExit);

      // 2. 预算：墙钟硬上限，到期强制 terminate
      timer = setTimeout(() => {
        finish({ logs: [], error: { kind: "timeout", message: `Program exceeded maxWallMs (${maxWallMs}ms)` } });
      }, maxWallMs);

      // 3. 中止：signal 已中止则立即结算，否则监听
      if (request.signal?.aborted) {
        onAbort();
      } else {
        request.signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async dispose(): Promise<void> {
    const workers = [...this.activeWorkers];
    this.activeWorkers.clear();
    await Promise.all(workers.map((w) => w.terminate()));
  }

  // ---- 内部实现 ----

  private spawnWorker(program: string): Worker {
    const worker = new Worker(this.bootstrapUrl(), {
      workerData: { program },
      env: {}, // 真空环境：程序看不到宿主环境变量
      resourceLimits: {
        maxOldGenerationSizeMb: this.config.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: this.config.maxYoungGenerationSizeMb,
      },
    });
    this.activeWorkers.add(worker);
    return worker;
  }

  private bootstrapUrl(): URL {
    // 开发（tsx）：同目录存在 .ts 源码；构建（tsc → dist）：只有编译后的 .js
    const tsUrl = new URL("./code-runtime-worker-bootstrap.ts", import.meta.url);
    if (existsSync(tsUrl)) return tsUrl;
    return new URL("./code-runtime-worker-bootstrap.js", import.meta.url);
  }

  /** 桥接一次程序内绑定调用：校验名称 → 执行宿主函数 → 回复 */
  private async handleCall(
    worker: Worker,
    bindings: CodeBindingNamespace[],
    msg: Extract<WorkerToHost, { type: "call" }>,
  ): Promise<void> {
    const reply = (payload: HostToWorker): void => {
      try {
        worker.postMessage(payload);
      } catch {
        // worker 已终止（超时/中止竞态）：丢弃回复
      }
    };

    try {
      // 主机校验：global 与 name 必须在请求的绑定内
      const ns = bindings.find((b) => b.global === msg.global);
      if (!ns) {
        reply({ type: "reply", id: msg.id, ok: false, message: `Unknown binding global: ${msg.global}` });
        return;
      }
      const fn = ns.functions[msg.name];
      if (typeof fn !== "function") {
        reply({ type: "reply", id: msg.id, ok: false, message: `Unknown function: ${msg.name}` });
        return;
      }
      const value = await fn(msg.args);
      reply({ type: "reply", id: msg.id, ok: true, value });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply({ type: "reply", id: msg.id, ok: false, message });
    }
  }

  /** 外层输出账本校验：序列化 logs+完成值，超限为显式失败而非带内替换 */
  private checkOutputLimit(logs: string[], value: unknown, maxBytes: number): string | null {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify({ logs, value }), "utf-8");
    } catch {
      bytes = Number.POSITIVE_INFINITY;
    }
    return bytes > maxBytes
      ? `Serialized output exceeded maxOutputBytes (${maxBytes} bytes)`
      : null;
  }

  private async ensureStripper(): Promise<void> {
    if (!this.stripperPromise) {
      this.stripperPromise = (async () => {
        try {
          const mod = (await import("node:module")) as { stripTypeScriptTypes?: Stripper };
          this.stripper = mod.stripTypeScriptTypes;
        } catch {
          this.stripper = undefined; // Node < 22.6：降级到 typescript.transpileModule
        }
      })();
    }
    await this.stripperPromise;
  }

  private stripTypes(program: string): StripResult {
    // 程序体是 async 函数体（顶层 return 合法），但剥离器按模块级解析：
    // 先包一层 async 箭头函数再剥离，最后解包出函数体（行号保持，函数体从第 1 行开始）。
    const wrapped = `async () => {\n${program}\n}`;

    // 优先 Node 原生 type-stripping：位置保留，运行时错误行号与模型源码一致
    if (this.stripper) {
      try {
        const stripped = this.stripper(wrapped, { mode: "strip" });
        return { ok: true, code: unwrapFunctionBody(stripped) };
      } catch (err) {
        // 不可擦除语法（enum/namespace/参数属性）或语法错误
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // 降级路径：typescript.transpileModule（语法诊断 + 不可擦除语法检测）
    try {
      const out = ts.transpileModule(wrapped, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.None,
          sourceMap: false,
        },
        reportDiagnostics: true,
      });
      const syntaxError = (out.diagnostics ?? []).find(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      if (syntaxError) {
        return {
          ok: false,
          error: ts.flattenDiagnosticMessageText(syntaxError.messageText, "\n"),
        };
      }
      const forbidden: string[] = [];
      const source = ts.createSourceFile(
        "program.ts",
        wrapped,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      collectForbiddenSyntax(source, forbidden);
      if (forbidden.length > 0) {
        return { ok: false, error: forbidden.join("; ") };
      }
      return { ok: true, code: unwrapFunctionBody(out.outputText) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * 从剥离/编译产物中解包出 async 函数体：
 * wrapper 形如 `async () => { <body> }`（首个 `{` 与末个 `}` 必属 wrapper），
 * 提取两者之间的文本即剥离后的函数体。
 */
function unwrapFunctionBody(stripped: string): string {
  const open = stripped.indexOf("{");
  const close = stripped.lastIndexOf("}");
  if (open === -1 || close === -1 || close <= open) {
    throw new Error("Failed to unwrap program function body");
  }
  return stripped.slice(open + 1, close);
}

/** 收集仅剥离模式下不可擦除的语法构造（降级路径用） */
function collectForbiddenSyntax(node: ts.Node, out: string[]): void {
  if (ts.isEnumDeclaration(node)) {
    out.push(`enum '${node.name.text}' is not erasable syntax; use only erasable TypeScript`);
  } else if (ts.isModuleDeclaration(node) && (node.flags & ts.NodeFlags.Namespace) !== 0) {
    out.push("namespace is not erasable syntax; use only erasable TypeScript");
  } else if (
    ts.isParameter(node) &&
    ts.isParameterPropertyDeclaration(node, node.parent)
  ) {
    out.push(`parameter property '${node.name.getText()}' is not erasable syntax`);
  }
  ts.forEachChild(node, (child) => collectForbiddenSyntax(child, out));
}
