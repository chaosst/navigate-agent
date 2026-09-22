/**
 * `agent-plan.html` 页面状态机的行为测试（真跑页面脚本）。
 *
 * 为什么值得单独一条：这个页面的三个高风险错都**沉默**（接口 200、tsc 干净、日志无异常）——
 *   ① 用死字段 plan.currentStepIndex 定位当前步（引擎恒写 0）→ 进行中态永远停在第一步；
 *   ② 工具 chip 归属错步 → 全部挂到下一步（依赖 plan → tool 的出流顺序）；
 *   ③ finalizing 阶段没接上 → 全绿之后白屏死等（之后还有一次完整 LLM 调用）。
 * 外加 chunk 边界（半截 SSE 帧）、XSS 净化路径、失败步骤渲染、503 分支。
 * 来源计划：docs/superpowers/plans/2026-09-22-plan-workflow-visualization.md（Task 4）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mountPlanPage, sseFrame, type FakeEl, type MountPlanPageOptions } from "./agent-plan-page-harness.js";

const HTML = readFileSync(
  path.join(process.cwd(), "src", "server", "public", "agent-plan.html"),
  "utf-8",
);

/** plan 快照构造器：引擎每轮 planner/executor 节点返回后都会发一份全量快照 */
function planSnap(steps: Array<Record<string, unknown>>, goal = "整理 docs") {
  return {
    type: "plan",
    plan: { goal, steps, currentStepIndex: 0, createdAt: 1, updatedAt: 2 },
  };
}
const s1done = { id: "s1", description: "读文件", status: "completed", result: "14 个文件" };
const s2pending = { id: "s2", description: "归类", status: "pending" };
const s3pending = { id: "s3", description: "写索引", status: "pending" };

function toolEv(tool: string, observation = "ok") {
  return { type: "tool", tool, input: { path: "a.md" }, observation };
}

/** stage 的直接子节点里 class 含 node 的（planner / 各步骤 / terminal），不含 connector */
const nodesOf = (stage: FakeEl) => stage.byClass("node");
const stepsOf = (stage: FakeEl) => nodesOf(stage).slice(1, -1);
const terminalOf = (stage: FakeEl) => nodesOf(stage)[nodesOf(stage).length - 1];
const classHas = (el: FakeEl, cls: string) => el.className.split(/\s+/).includes(cls);
/** terminal 的可见文案在子 span 里（结构：spinner + terminal-text） */
const terminalText = (el: FakeEl) => el.textContent + el.all().map((c) => c.textContent).join("");

describe("agent-plan.html 编排视图状态机", () => {
  it("空输入不发起请求，只提示", async () => {
    const page = await mountPlanPage(HTML, { frames: [] });
    await page.clickRun("   ");
    expect(page.alerts).toHaveLength(1);
    expect(page.alerts[0]).toContain("请先描述");
    expect(page.requests).toHaveLength(0);
  });

  it("请求 URL 带 token、body 带 trim 后的问题", async () => {
    const page = await mountPlanPage(HTML, { frames: [sseFrame({ type: "answer", text: "ok" })] });
    await page.clickRun("  读 docs  ");
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0].url).toContain("/api/agent/plan?token=test-token");
    expect(JSON.parse(page.requests[0].body)).toEqual({ question: "读 docs" });
  });

  it("首份 plan 到达 → 阶段进 executing，节点按状态着色（此时流未结束）", async () => {
    const page = await mountPlanPage(HTML, {
      holdOpen: true,
      frames: [sseFrame(planSnap([s1done, s2pending, s3pending]))],
    });
    await page.clickRun("读 docs 并汇总");

    expect(page.phaseEls[1].className).toContain("active"); // executing
    expect(page.phaseEls[1].textContent).toContain("执行中");
    expect(page.phaseEls[0].className).toContain("done");   // planning 已完成
    expect(page.metrics.textContent).toContain("3 步");
    expect(nodesOf(page.stage)[0].textContent).toContain("整理 docs"); // planner 节点带目标

    const steps = stepsOf(page.stage);
    expect(steps).toHaveLength(3);
    expect(steps[0].className).toContain("completed");
    expect(steps[2].className).toContain("pending");
    await page.release();
  });

  /**
   * 本文件最重要的一条：进行中态必须靠 steps[].status 派生，
   * 绝不能用 plan.currentStepIndex（引擎全文件只写它 0 次非零值）。
   * 若页面用了那个字段，第 2 步会被渲染成 pending 而不是 running。
   */
  it("进行中态由 status 派生：currentStepIndex=0 也不影响定位（死字段陷阱）", async () => {
    const page = await mountPlanPage(HTML, {
      holdOpen: true,
      frames: [sseFrame(planSnap([s1done, s2pending, s3pending]))],
    });
    await page.clickRun("读 docs 并汇总");

    const steps = stepsOf(page.stage);
    expect(steps[1].className).toContain("running");   // 第一个非终态步 = 进行中
    expect(steps[1].className).not.toContain("pending");
    expect(steps[2].className).toContain("pending");   // 后续步仍等待
    expect(steps[0].className).not.toContain("running");

    // 徽章：进行中 = ▶（而非 ⏳），等待 = ⏳，完成 = ✅
    // —— 曾经写成 `BADGE[status] || …`，status 恒有值导致 ▶ 永远不显示（首轮视觉校验发现）
    const badge = (i: number) => steps[i].byClass("node-badge")[0].textContent;
    expect(badge(0)).toBe("✅");
    expect(badge(1)).toBe("▶");
    expect(badge(2)).toBe("⏳");
    await page.release();
  });

  it("工具 chip 归属「本轮刚落地的那一步」，不挂到下一步", async () => {
    const page = await mountPlanPage(HTML, {
      holdOpen: true,
      frames: [
        sseFrame(planSnap([s1done, s2pending, s3pending])),
        sseFrame(toolEv("read_file")),
        sseFrame(toolEv("list_files")),
      ],
    });
    await page.clickRun("读 docs 并汇总");

    const steps = stepsOf(page.stage);
    expect(steps[0].byClass("tool-chip")).toHaveLength(2);
    expect(steps[1].byClass("tool-chip")).toHaveLength(0);
    expect(steps[0].byClass("node-count")[0].textContent).toBe("2 次工具");
    expect(steps[0].byClass("tool-chip")[0].textContent).toBe("▸ read_file");
    expect(page.metrics.textContent).toContain("2 次工具");
    await page.release();
  });

  it("全步终态 → 阶段进 finalizing，且给出「正在综合最终答案」文案 + 转圈（不白屏）", async () => {
    const page = await mountPlanPage(HTML, {
      holdOpen: true,
      frames: [
        sseFrame(planSnap([s1done, s2pending, s3pending])),
        sseFrame(planSnap([s1done, { ...s2pending, status: "completed", result: "分 3 类" }, s3pending])),
        sseFrame(planSnap([
          s1done,
          { ...s2pending, status: "completed", result: "分 3 类" },
          { ...s3pending, status: "completed", result: "done" },
        ])),
      ],
    });
    await page.clickRun("读 docs 并汇总");

    expect(page.phaseEls[2].className).toContain("active"); // finalizing
    expect(page.phaseEls[2].textContent).toContain("收口中");
    const terminal = terminalOf(page.stage);
    expect(classHas(terminal, "terminal")).toBe(true);
    expect(terminalText(terminal)).toContain("正在综合最终答案");
    expect(terminal.childByClass("spinner")?.hidden).toBe(false); // 转圈可见
    expect(page.answerBox.capturedHtml).toBeNull();               // 答案还没到 → 不假装有

    await page.release();                                         // 流结束 → 收口为 done
    expect(page.phaseEls[3].className).toContain("active");
  });

  it("answer 到达 → 阶段 done，走 marked + DOMPurify 渲染到答案区；重复渲染被守卫", async () => {
    const page = await mountPlanPage(HTML, {
      frames: [
        sseFrame(planSnap([s1done])),
        sseFrame({ type: "answer", text: "# 索引\n共 14 个文件" }),
      ],
    });
    await page.clickRun("读 docs 并汇总");

    expect(page.phaseEls[3].className).toContain("active"); // done
    expect(page.answerPanel.hidden).toBe(false);
    // 内容没变 → 只解析一次（render 在 answer 事件与 finally 各被调一次）
    expect(page.mdCalls.parsed).toHaveLength(1);
    expect(page.mdCalls.sanitized[0]).toContain("共 14 个文件");
    expect(page.answerBox.capturedHtml).toContain("<p># 索引");
    expect(terminalText(terminalOf(page.stage))).toContain("完成");
    expect(terminalOf(page.stage).childByClass("spinner")?.hidden).toBe(true);
  });

  it("答案里的 <script> 被 DOMPurify 拦掉（净化路径真的被走，不是摆设）", async () => {
    const page = await mountPlanPage(HTML, {
      frames: [
        sseFrame(planSnap([s1done])),
        sseFrame({ type: "answer", text: "<script>alert(1)</script>正常内容" }),
      ],
    });
    await page.clickRun("q");

    expect(page.mdCalls.sanitized).toHaveLength(1);
    expect(page.answerBox.capturedHtml).toContain("正常内容");
    expect(page.answerBox.capturedHtml).not.toContain("<script>");
  });

  it("marked / DOMPurify 不可用（CDN 挂了）→ 降级为转义文本，不炸", async () => {
    const page = await mountPlanPage(HTML, {
      frames: [sseFrame(planSnap([s1done])), sseFrame({ type: "answer", text: "<b>x</b>" })],
      injectMd: false,
    });
    await page.clickRun("q");
    expect(page.answerBox.capturedHtml).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("失败步骤：显示 error、节点标 failed、答案照常落地（fallback 路径不崩）", async () => {
    const page = await mountPlanPage(HTML, {
      frames: [
        sseFrame(planSnap([s1done, s2pending])),
        sseFrame(planSnap([
          s1done,
          { ...s2pending, status: "failed", error: "Path escape detected: /etc/shadow" },
        ])),
        sseFrame({ type: "answer", text: "⚠️ 任务未完成：1 步失败" }),
      ],
    });
    await page.clickRun("读 /etc/shadow");

    const steps = stepsOf(page.stage);
    expect(steps[1].className).toContain("failed");
    expect(steps[1].byClass("node-result")[0].textContent).toContain("Path escape detected");
    expect(steps[1].byClass("node-result")[0].className).toContain("err");
    expect(page.phaseEls[3].className).toContain("active");
    expect(page.answerBox.capturedHtml).toContain("任务未完成");
  });

  it("SSE 帧被切成任意片段也能拼回（半截帧缓冲）", async () => {
    const page = await mountPlanPage(HTML, {
      chunkSize: 7,
      frames: [
        sseFrame(planSnap([s1done, s2pending])),
        sseFrame(toolEv("search_documents", "命中 3 条")),
        sseFrame({ type: "answer", text: "答案" }),
      ],
    });
    await page.clickRun("q");

    const steps = stepsOf(page.stage);
    expect(steps).toHaveLength(2);
    expect(steps[0].byClass("tool-chip")).toHaveLength(1);
    expect(page.answerBox.capturedHtml).toContain("答案");
  });

  it("工具 chip 可展开/收起，且展开态在重绘后保留（状态在 JS 不在 DOM）", async () => {
    const page = await mountPlanPage(HTML, {
      frames: [sseFrame(planSnap([s1done, s2pending])), sseFrame(toolEv("read_file", "文件内容 ABC"))],
    });
    await page.clickRun("q");

    expect(stepsOf(page.stage)[0].byClass("tool-body")).toHaveLength(0); // 默认收起

    stepsOf(page.stage)[0].byClass("tool-chip")[0].onclick?.();
    const bodies = stepsOf(page.stage)[0].byClass("tool-body");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].className).toContain("open");
    expect(bodies[0].textContent).toContain("文件内容 ABC");
    expect(stepsOf(page.stage)[0].byClass("tool-chip")[0].dataset.open).toBe("1");

    stepsOf(page.stage)[0].byClass("tool-chip")[0].onclick?.();
    expect(stepsOf(page.stage)[0].byClass("tool-body")).toHaveLength(0);
  });

  it("工具返回以 Error 开头 → chip 标红（failed）", async () => {
    const page = await mountPlanPage(HTML, {
      frames: [
        sseFrame(planSnap([{ ...s1done, status: "failed", error: "Error: 读取失败" }])),
        sseFrame(toolEv("read_file", "Error: 读取失败")),
      ],
    });
    await page.clickRun("q");
    expect(classHas(stepsOf(page.stage)[0].byClass("tool-chip")[0], "failed")).toBe(true);
  });

  it("接口 503（未装配）→ 显示错误文案，不留白屏", async () => {
    const page = await mountPlanPage(HTML, { frames: [], errorStatus: 503 });
    await page.clickRun("q");

    expect(page.phaseEls[3].className).not.toContain("active");
    expect(page.answerPanel.hidden).toBe(false);
    expect(page.answerBox.capturedHtml).toContain("Plan agent 未装配");
    expect(terminalText(terminalOf(page.stage))).toContain("执行中断");
    expect(terminalOf(page.stage).childByClass("spinner")?.hidden).toBe(true);
  });

  it("再次执行会清空上一轮节点与展开态（不残留、不叠加）", async () => {
    const opts: MountPlanPageOptions = {
      frames: [sseFrame(planSnap([s1done, s2pending])), sseFrame(toolEv("read_file"))],
    };
    const page = await mountPlanPage(HTML, opts);
    await page.clickRun("q");
    expect(stepsOf(page.stage)).toHaveLength(2);
    expect(stepsOf(page.stage)[0].byClass("tool-chip")).toHaveLength(1);

    // 两轮共用同一份帧队列：第二轮帧已耗尽 → 收不到任何事件，
    // 恰好是「清空是否彻底」的对照组 —— 残留会看到 4 个节点 / 1 个 chip。
    await page.clickRun("q2");
    expect(stepsOf(page.stage)).toHaveLength(0);
    expect(page.stage.byClass("tool-chip")).toHaveLength(0);
    expect(page.metrics.textContent).not.toContain("2 步");
    expect(page.answerPanel.hidden).toBe(true); // 上一轮答案区被清空
  });

  it("重跑时前一页的 phase 状态不会污染新一轮（重置到 planning）", async () => {
    const page = await mountPlanPage(HTML, {
      holdOpen: true,
      frames: [sseFrame(planSnap([s1done, s2pending])), sseFrame({ type: "answer", text: "上一轮答案" })],
    });
    await page.clickRun("q");
    expect(page.phaseEls[3].className).toContain("active"); // done
    await page.release();

    // 第二轮（帧已耗尽）应立即被收口，且不再显示上一轮的答案
    await page.clickRun("q2");
    expect(page.answerBox.capturedHtml).toBeNull();
  });
});
