/**
 * trace-export.ts — Agent 执行轨迹导出
 *
 * 目的：把 Tracer 的内存 TraceSession 持久化，供离线评估/分析。
 * 关键设计：TraceExporter 接口 —— 未来接 LangSmith 只需实现同一接口，评估链路零改动。
 *
 * 用法：
 *   const exporter = new JsonlTraceExporter();          // 默认 eval_output/traces.jsonl
 *   tracer.getSessions().forEach((s) => exporter.export(s));
 *   const sessions = loadSessionsFromJsonl("eval_output/traces.jsonl");
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TraceSession } from "../../agent/tracer.js";

/** 轨迹导出器抽象：评估/观测层只依赖这个接口，不关心落盘还是上报 */
export interface TraceExporter {
  export(session: TraceSession): Promise<void> | void;
}

/** JSONL 落盘实现：每行一个 session（JSON），追加写 */
export class JsonlTraceExporter implements TraceExporter {
  private filePath: string;

  constructor(filePath: string = "eval_output/traces.jsonl") {
    this.filePath = resolve(filePath);
  }

  export(session: TraceSession): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(session) + "\n", "utf-8");
  }
}
