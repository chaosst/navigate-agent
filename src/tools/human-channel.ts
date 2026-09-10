import { PERMISSION_LEVEL, type ToolPermission } from "./permission.js";

/** 审批模式：interactive 弹卡片 / allow 全放行（等价无审批）/ deny 自动拒绝 */
export type ApprovalMode = "interactive" | "allow" | "deny";

/** 环境变量解析：非法值一律回退 fallback（默认 interactive，即 TUI 语义） */
export function resolveApprovalMode(raw: string | undefined, fallback: ApprovalMode = "interactive"): ApprovalMode {
  return raw === "allow" || raw === "deny" || raw === "interactive" ? raw : fallback;
}

/**
 * 按模式组装审批装配件。
 * allow → 两者皆 undefined（不注入 = 不放审批门 = 行为与今天一致）
 * deny  → 通道已挂无人值守交互器（server / H5）
 * interactive → 通道空挂，等 TUI 渲染完成后 attach
 */
export function buildApproval(mode: ApprovalMode): { channel?: HumanChannel; policy?: ApprovalPolicy } {
  if (mode === "allow") return {};
  const channel = new HumanChannel();
  if (mode === "deny") channel.attach(new NonInteractiveInteractor());
  return { channel, policy: new ThresholdApprovalPolicy("write") };
}

/** 需要人回答的两类请求 */
export type HumanRequest =
  | { id: string; kind: "approval"; tool: string; args: unknown; permission: ToolPermission }
  | { id: string; kind: "question"; question: string; options?: string[] };

/** reason 仅在拒绝时有值：用户补的一句话，拼进 ToolMessage 当 LLM 的指引 */
export type HumanResponse =
  | { kind: "approval"; decision: "allow" | "always" | "deny"; reason?: string }
  | { kind: "question"; answer: string };

/**
 * Omit 在联合类型上不分配（keyof 只取公共键，会把联合塌缩成 { kind }），
 * 故用裸类型参数的条件类型触发分配 —— request() 的入参不能携带 id（由通道分配）。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 请求入参：HumanRequest 去掉通道分配的 id */
export type HumanRequestInput = DistributiveOmit<HumanRequest, "id">;

/** 谁来回答。三种实现：TUI（ManualInteractor）/ 无人值守 / 测试内联替身 */
export interface HumanInteractor {
  ask(req: HumanRequest): Promise<HumanResponse>;
}

/** 审批策略：哪些调用需要问 */
export interface ApprovalPolicy {
  shouldAsk(tool: string, permission: ToolPermission): boolean;
}

/** 默认档：minPermission（默认 write）及以上需要问，read 直通 */
export class ThresholdApprovalPolicy implements ApprovalPolicy {
  private minLevel: number;
  constructor(minPermission: ToolPermission = "write") {
    this.minLevel = PERMISSION_LEVEL[minPermission];
  }
  shouldAsk(_tool: string, permission: ToolPermission): boolean {
    return PERMISSION_LEVEL[permission] >= this.minLevel;
  }
}

/** 无人值守：审批一律拒绝、提问一律给可读兜底（server / H5） */
export class NonInteractiveInteractor implements HumanInteractor {
  async ask(req: HumanRequest): Promise<HumanResponse> {
    if (req.kind === "approval") {
      return { kind: "approval", decision: "deny", reason: "non-interactive environment" };
    }
    return { kind: "question", answer: "[no user available] This environment has no attached user." };
  }
}

/**
 * 手动交互器：ask() 挂起并登记 resolver，由外部（TUI 按键）调 answer() 兑现。
 * 不做 stdin 处理——那是 ApprovalPrompt 的事；本类保持无 UI 依赖，可单测。
 */
export class ManualInteractor implements HumanInteractor {
  private waiters = new Map<string, (res: HumanResponse) => void>();
  ask(req: HumanRequest): Promise<HumanResponse> {
    return new Promise<HumanResponse>((resolve) => {
      this.waiters.set(req.id, resolve);
    });
  }
  answer(id: string, res: HumanResponse): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter(res);
  }
}

/**
 * 请求通道：FIFO 串行，任一时刻只有一个待答请求。
 * plan 模式的 Promise.all 并发工具调用、PTC 的程序内子调用，都被这里天然串行化。
 */
export class HumanChannel {
  private interactor: HumanInteractor = new NonInteractiveInteractor();
  private queue: Array<{ req: HumanRequest; resolve: (res: HumanResponse) => void }> = [];
  private current: HumanRequest | null = null;
  private pumping = false;
  private allowAlways = new Set<string>();
  private waited = 0;
  private listeners = new Set<() => void>();
  private seq = 0;
  /** 等待量增量回调（单一订阅者：PTC runtime 用它延长墙钟预算） */
  onWait?: (deltaMs: number) => void;

  /** 后挂载交互器。bootstrap 先建空通道，App 渲染完成后再 attach。 */
  attach(interactor: HumanInteractor): void {
    this.interactor = interactor;
  }

  get pending(): HumanRequest | null {
    return this.current;
  }

  get waitMs(): number {
    return this.waited;
  }

  isAlwaysAllowed(tool: string): boolean {
    return this.allowAlways.has(tool);
  }

  /** 订阅 pending 变化（TUI 用它触发 re-render）；返回取消订阅函数 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 入队 → 等前一个 resolve → 问交互器 → 出队；Promise 挂起直到有人作答 */
  request(req: HumanRequestInput): Promise<HumanResponse> {
    const full = { ...req, id: `h${++this.seq}` } as HumanRequest;
    return new Promise<HumanResponse>((resolve) => {
      this.queue.push({ req: full, resolve });
      void this.pump();
    });
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.current = item.req;
        this.notify();
        const t0 = Date.now();
        let res: HumanResponse;
        try {
          res = await this.interactor.ask(item.req);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          res = item.req.kind === "approval"
            ? { kind: "approval", decision: "deny", reason: `[approval_error] ${msg}` }
            : { kind: "question", answer: `[no user available] ${msg}` };
        }
        if (res.kind === "approval" && res.decision === "always" && item.req.kind === "approval") {
          this.allowAlways.add(item.req.tool);
        }
        const delta = Date.now() - t0;
        this.waited += delta;
        this.onWait?.(delta);
        this.current = null;
        item.resolve(res);
        this.notify();
      }
    } finally {
      this.pumping = false;
    }
  }
}
