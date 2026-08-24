/**
 * DispatchOrderBuffer — 把并发完成的子调用事件重排回提交顺序。
 *
 * DispatchBridge 的子调用事件在「完成时」emit（见 invokeTool），而并发执行
 * （maxParallelSubCalls > 1）时完成顺序 ≠ 提交顺序——最早提交的工具可能最后完成。
 * 若 TUI 按事件到达顺序渲染，会出现「最早调用的工具显示在最下方」的倒置。
 *
 * 本缓冲按 (parentId, seq) 重排：seq 是提交时分配的递增序号。
 * - 到达的事件 seq 正好是「该 parentId 的下一个期望值」→ 立即就绪输出；
 * - 否则缓存等待，等缺口补齐后按序补发。
 * 不同 parentId 互不阻塞（并发 run_code 各自独立排序）。
 */
import type { PtcDispatchEvent } from "./dispatch-bridge.js";

export class DispatchOrderBuffer {
  /** parentId -> 下一个期望的 seq */
  private expectedSeq = new Map<string, number>();
  /** parentId -> seq -> 事件（乱序到达的缓存） */
  private pending = new Map<string, Map<number, PtcDispatchEvent>>();
  /** 已就绪、待输出的事件（FIFO） */
  private ready: PtcDispatchEvent[] = [];

  push(ev: PtcDispatchEvent): void {
    const expected = this.expectedSeq.get(ev.parentId) ?? 0;
    if (ev.seq === expected) {
      this.ready.push(ev);
      this.expectedSeq.set(ev.parentId, expected + 1);
      this.flushCached(ev.parentId);
    } else {
      let bySeq = this.pending.get(ev.parentId);
      if (!bySeq) {
        bySeq = new Map();
        this.pending.set(ev.parentId, bySeq);
      }
      bySeq.set(ev.seq, ev);
    }
  }

  /** 取出所有已就绪事件（FIFO）；返回后缓冲区清空 */
  drain(): PtcDispatchEvent[] {
    if (this.ready.length === 0) return [];
    const out = this.ready;
    this.ready = [];
    return out;
  }

  private flushCached(parentId: string): void {
    const bySeq = this.pending.get(parentId);
    if (!bySeq) return;
    let expected = this.expectedSeq.get(parentId) ?? 0;
    while (bySeq.has(expected)) {
      this.ready.push(bySeq.get(expected)!);
      bySeq.delete(expected);
      expected++;
    }
    this.expectedSeq.set(parentId, expected);
  }
}
