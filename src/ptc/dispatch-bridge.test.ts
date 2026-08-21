import { describe, it, expect } from "vitest";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { DispatchBridge } from "./dispatch-bridge.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 假工具：返回参数值（JSON 字符串），可配置延迟 */
class EchoTool extends StructuredTool {
  name = "echo";
  description = "echo the input";
  schema = z.object({ v: z.unknown() });

  constructor(private delay = 0) {
    super();
  }

  async _call({ v }: { v: unknown }): Promise<string> {
    if (this.delay) await sleep(this.delay);
    return JSON.stringify(v);
  }
}

/** 假工具：执行中记录 active/maxActive，用于并发断言 */
class TrackingTool extends StructuredTool {
  name = "track";
  description = "track concurrency";
  schema = z.object({});

  active = 0;
  maxActive = 0;

  async _call(): Promise<string> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await sleep(20);
    this.active--;
    return "ok";
  }
}

describe("DispatchBridge", () => {
  it("exposes bindings and executes sub-calls", async () => {
    const bridge = new DispatchBridge([new EchoTool()]);
    const ns = bridge.buildBindings("");
    const value = await ns.functions.echo({ v: { x: 1 } });
    // EchoTool 返回 JSON.stringify(v) 字符串，toLosslessJson 保持字符串
    expect(value).toEqual('{"x":1}');
    await bridge.drain(new AbortController().signal);
  });

  it("caps parallel sub-calls at maxParallelSubCalls", async () => {
    const tracking = new TrackingTool();
    const bridge = new DispatchBridge([tracking], undefined, undefined, undefined, 2);
    const ns = bridge.buildBindings("");
    await Promise.all([
      ns.functions.track({}),
      ns.functions.track({}),
      ns.functions.track({}),
      ns.functions.track({}),
      ns.functions.track({}),
    ]);
    expect(tracking.maxActive).toBeLessThanOrEqual(2);
    await bridge.drain(new AbortController().signal);
  });

  it("runs sequentially when maxParallelSubCalls = 1", async () => {
    const tracking = new TrackingTool();
    const bridge = new DispatchBridge([tracking], undefined, undefined, undefined, 1);
    const ns = bridge.buildBindings("");
    await Promise.all([
      ns.functions.track({}),
      ns.functions.track({}),
      ns.functions.track({}),
    ]);
    expect(tracking.maxActive).toBe(1);
    await bridge.drain(new AbortController().signal);
  });

  it("runs exclusive tools only when nothing else is in flight", async () => {
    const events: string[] = [];
    class Echo extends StructuredTool {
      name = "echo";
      description = "e";
      schema = z.object({});
      async _call(): Promise<string> {
        events.push("echo:start");
        await sleep(15);
        events.push("echo:end");
        return "ok";
      }
    }
    class Exclusive extends StructuredTool {
      name = "exclusive";
      description = "x";
      schema = z.object({});
      async _call(): Promise<string> {
        events.push("exclusive:start");
        await sleep(15);
        events.push("exclusive:end");
        return "ok";
      }
    }

    const bridge = new DispatchBridge(
      [new Echo(), new Exclusive()],
      undefined,
      undefined,
      undefined,
      5,
      ["exclusive"],
    );
    const ns = bridge.buildBindings("");
    const results = await Promise.all([
      ns.functions.echo({}),
      ns.functions.echo({}),
      ns.functions.exclusive({}),
      ns.functions.echo({}),
    ]);
    expect(results).toHaveLength(4);

    // 独占区间 [exclusive:start, exclusive:end] 内不得有 echo:start
    const exclStart = events.indexOf("exclusive:start");
    const exclEnd = events.indexOf("exclusive:end");
    const echoStarts = events
      .map((e, i) => (e === "echo:start" ? i : -1))
      .filter((i) => i >= 0);
    for (const i of echoStarts) {
      expect(i < exclStart || i > exclEnd).toBe(true);
    }
    await bridge.drain(new AbortController().signal);
  });

  it("rejects failed sub-calls so the program can catch them", async () => {
    class BoomTool extends StructuredTool {
      name = "boom";
      description = "b";
      schema = z.object({});
      async _call(): Promise<string> {
        throw new Error("kaboom");
      }
    }
    const bridge = new DispatchBridge([new BoomTool()]);
    const ns = bridge.buildBindings("");
    await expect(ns.functions.boom({})).rejects.toThrow("kaboom");
    await bridge.drain(new AbortController().signal);
  });

  it("drain rejects queued calls that never started", async () => {
    const bridge = new DispatchBridge([new EchoTool(100)], undefined, undefined, undefined, 1);
    const ns = bridge.buildBindings("");
    const p1 = ns.functions.echo({ v: 1 }); // 占用唯一并发槽（100ms）
    const p2 = ns.functions.echo({ v: 2 }); // 排队，未启动
    // 提前挂 handler，避免 drain 在等待期间同步 reject 导致 unhandled rejection
    const p2Settled = p2.catch((e: unknown) => e);
    await sleep(50); // p1 仍在执行、p2 仍在队列
    await bridge.drain(new AbortController().signal);
    const err = await p2Settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/settled|abort/i);
    await p1; // 在飞调用应正常结算
  });

  it("emits dispatch events with isError flag", async () => {
    class OkTool extends StructuredTool {
      name = "ok";
      description = "o";
      schema = z.object({});
      async _call(): Promise<string> {
        return "fine";
      }
    }
    class BadTool extends StructuredTool {
      name = "bad";
      description = "b";
      schema = z.object({});
      async _call(): Promise<string> {
        throw new Error("bad");
      }
    }
    const bridge = new DispatchBridge([new OkTool(), new BadTool()]);
    const events: unknown[] = [];
    const unsubscribe = bridge.onDispatch((ev) => events.push(ev));
    const ns = bridge.buildBindings("");
    await ns.functions.ok({});
    await ns.functions.bad({}).catch(() => undefined);
    unsubscribe();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ tool: "ok", isError: false });
    expect(events[1]).toMatchObject({ tool: "bad", isError: true });
    await bridge.drain(new AbortController().signal);
  });

  it("increments subCallCount per executed sub-call", async () => {
    const bridge = new DispatchBridge([new EchoTool()]);
    const ns = bridge.buildBindings("");
    await ns.functions.echo({ v: 1 });
    await ns.functions.echo({ v: 2 });
    expect(bridge.subCallCount).toBe(2);
    await bridge.drain(new AbortController().signal);
  });
});
