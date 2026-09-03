"""benchmarks/py-maf/run.py —— MAF (python) 侧统一 runner（选手 A，argv 分派 4 任务）

与 ts-navigate/runner.ts 同构：单文件分派 task-1..4，读 benchmarks/tasks/<task>.json，
输出统一结果契约到 benchmarks/results/maf.<task_id>.json（契约见 docs/plans/p2-framework-benchmarks.md §3.1）。
工具【不】在 Python 侧实现——MCPStdioTool 拉起 TS 侧 benchmark-mcp-server（与 ts-navigate/CrewAI
同一份 tools.ts），比的是编排能力而非工具实现。

⚠️ 版本提示：MAF python（agent-framework-core 1.16.x + agent-framework-openai 1.14.x，2026-09 实测）。
  ★ 关键实测结论（2026-09-03 源码级确认，agent_framework_openai/_chat_client.py）：
      - OpenAIChatClient 是 **Responses API** 客户端（docstring: "OpenAI Responses client class"），
        DeepSeek 只有 /chat/completions → 用它必 404，【不要用】。
      - 正确类是 OpenAIChatCompletionClient（_chat_completion_client.py，chat completions），
        与 Agent/MCPStdioTool 同在 agent_framework / agent_framework.openai 命名空间导出。
      - 二者 model env 均为 "OPENAI_MODEL" 兜底（chat 类优先读 OPENAI_CHAT_COMPLETION_MODEL）。
  本文 import 形态（已实测可 import，GA 后是 Agent 而非 ChatAgent）：
      from agent_framework import Agent, MCPStdioTool
      from agent_framework.openai import OpenAIChatCompletionClient
  Agent 构造用 client.as_agent(**kwargs)（as_agent 定义在 agent_framework/_clients.py，ChatClient 基类方法；
  等价写法 Agent(client=..., name=..., instructions=...)）。

安装（Python 3.10+，建议 venv；Windows venv 是 Scripts/，Git Bash 也是，无 .venv/bin/）：
    python -m venv .venv
    .venv/Scripts/pip install -U "agent-framework-core[all]"    # 已 GA（1.0.0），无需 --pre
    # mcp 包：新版 core 依赖自带 mcp[ws]；若 import MCPStdioTool 报缺 mcp 再手动装：
    # .venv/Scripts/pip install -U mcp

运行（env 与 ts-navigate/runner.ts 完全一致——DeepSeek chat completions 兼容 OpenAI；
    注意模型变量名是 OPENAI_MODEL，不是 OPENAI_CHAT_MODEL_ID）：
    export OPENAI_API_KEY=sk-xxx
    export OPENAI_BASE_URL=https://api.deepseek.com/v1
    export OPENAI_MODEL=deepseek-chat
    python run.py task-1-rag-qa        # 全名或短 id 均可（task-1）
    python run.py task-4
    python run.py --help

实测确认点（写报告前必须验证，README/notes 要交代）：
  1) ✅ 已实锤（2026-09-03）：OpenAIChatClient=Responses API（DeepSeek 不可用），
     必须用 OpenAIChatCompletionClient（chat completions）——下方代码已改用。
  2) MCPStdioTool 的 tools 传参形态：构造 tools=[mcp_tool]（下方采用）vs tools=mcp_tool.functions
     vs run(tools=...)，以安装版本为准（Learn 文档三处示例并不完全一致）。
  3) task-3 用两次独立 agent run + 显式拼接表达 handoff（与 ts-navigate 同构）；
     未用 MAF 的 Workflow/SequentialProcess API——pre-release 形态不稳，且两次 run 更贴近
     ts-navigate 的手工交接口径（notes 如实写）。
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py-common"))
from bench_common import (  # noqa: E402（共享骨架，不计入 code_lines，与 tools/ 同口径）
    REPO,
    build_result,
    check_success,
    code_lines,
    final_text,
    framework_version,
    load_task,
    short_id,
    write_result,
)

# Windows spawn：node 拉起 tsx CLI → benchmark-mcp-server.ts（本机实测可行的组合）
TSX_CLI = REPO / "node_modules" / "tsx" / "dist" / "cli.mjs"
MCP_SERVER = REPO / "benchmarks" / "tools" / "benchmark-mcp-server.ts"


def usage() -> str:
    return "用法: python run.py <task-id>  (如 task-1-rag-qa 或短 id task-1；--help 查看说明)"


def _maf():
    """延迟 import：--help / 非法任务路径不依赖框架；未装时给安装指引而非裸 ImportError。"""
    try:
        from agent_framework import Agent, MCPStdioTool
        # ★ OpenAIChatCompletionClient（chat completions，DeepSeek 可用）；
        #   OpenAIChatClient 是 Responses API 客户端（DeepSeek 404），勿用。
        from agent_framework.openai import OpenAIChatCompletionClient
        return Agent, MCPStdioTool, OpenAIChatCompletionClient
    except ImportError as exc:
        raise SystemExit(
            '缺少 agent-framework：请先创建 venv 并安装（见文件头）：python -m venv .venv 且 '
            '.venv/Scripts/pip install -U "agent-framework-core[all]" '
            '（若 import MCPStdioTool 报缺 mcp 再装 mcp）。原始错误：' + str(exc)
        ) from exc


def extract(raw) -> str:
    """MAF AgentRunResult 提取纯文本：.final_message.content 优先，再退化到共享 final_text。"""
    fm = getattr(raw, "final_message", None)
    if fm is not None:
        content = getattr(fm, "content", None)
        if content is not None:
            return str(content)
    return final_text(raw)


def make_mcp_tool(MCPStdioTool):
    return MCPStdioTool(
        name="benchmark-tools",
        command="node",
        args=[str(TSX_CLI), str(MCP_SERVER)],
    )


def new_agent(client, name: str, instructions: str, mcp_tool=None):
    kwargs = {"name": name, "instructions": instructions}
    if mcp_tool is not None:
        kwargs["tools"] = [mcp_tool]  # 见文件头"实测确认点 2"：若需 functions 形态改用 mcp_tool.functions
    return client.as_agent(**kwargs)


async def run_task1(client, task: dict) -> tuple[str, dict]:
    """task-1 RAG 问答：无工具。context 进 instructions（对应 ts 的 system），run(question)。"""
    material = task["context"]
    agent = new_agent(
        client,
        "qa-assistant",
        "你是 navigate 技术问答助手。只依据下面给定的上下文回答用户问题，禁止编造上下文之外的事实。"
        f"\n\n上下文：{material}\n\n回答要求：直接给出结论，一句话到三句话，包含关键术语依据上下文的结论，一句话到三句话，包含关键术语（如技术栈：JavaScript、C++、MAF等）。",
    )
    t0 = time.perf_counter()
    raw = await agent.run(task["question"])
    wall_ms = round((time.perf_counter() - t0) * 1000)
    return extract(raw), {
        "wall_time_ms": wall_ms,
        "trace": [{"step": 1, "kind": "llm", "name": "agent.run(单 agent)", "ms": wall_ms}],
    }


async def run_task2(client, task: dict) -> tuple[str, dict]:
    """task-2 工具编排：单 agent + MCPStdioTool（calculator + weather_now）。"""
    MCPStdioTool = _maf()[1]
    async with make_mcp_tool(MCPStdioTool) as mcp_tool:
        agent = new_agent(
            client,
            "tool-orchestrator",
            "你是工具调度员。自主调用可用工具完成任务，并给出最终答案。"
            "规则：答案必须来自工具返回的真实结果；工具报错就修正参数重试；最后用一句中文总结。",
            mcp_tool=mcp_tool,
        )
        t0 = time.perf_counter()
        raw = await agent.run(task["question"])
        wall_ms = round((time.perf_counter() - t0) * 1000)
    return extract(raw), {
        "wall_time_ms": wall_ms,
        "trace": [{"step": 1, "kind": "llm", "name": "agent.run(自主工具循环)", "ms": wall_ms}],
    }


async def run_task3(client, task: dict) -> tuple[str, dict]:
    """task-3 多 Agent：两次独立 run + 显式拼接（researcher 输出喂给 writer）——与 ts-navigate 同构。
    MAF 未用 Workflow API（pre-release 形态不稳），此形态即"手工编排"对照（对比 CrewAI 原生 context 链）。"""
    material = task["context"]
    topic = task["topic"]
    researcher = new_agent(
        client,
        "researcher",
        "你是研究员（researcher）。基于给定材料提炼要点，禁止编造材料之外的内容。"
        "输出格式：编号列表，至少 3 条要点，每条一句话。",
    )
    t0 = time.perf_counter()
    r_start = time.perf_counter()
    raw_points = await researcher.run(f"材料：\n{material}\n\n请围绕「{topic}」提炼至少 3 条要点。")
    research_ms = round((time.perf_counter() - r_start) * 1000)
    points = extract(raw_points)

    writer = new_agent(
        client,
        "writer",
        "你是撰稿人（writer）。依据研究员给出的要点写成短文。"
        "规则：必须覆盖全部要点，不得新增材料之外的结论；输出 3-5 句连贯中文。",
    )
    w_start = time.perf_counter()
    raw_article = await writer.run(f"研究员的要点：\n{points}")
    writer_ms = round((time.perf_counter() - w_start) * 1000)
    wall_ms = round((time.perf_counter() - t0) * 1000)
    return extract(raw_article), {
        "wall_time_ms": wall_ms,
        "trace": [
            {"step": 1, "kind": "llm", "name": "researcher", "ms": research_ms},
            {"step": 2, "kind": "handoff", "name": "researcher→writer(手工拼接)", "ms": 0},
            {"step": 3, "kind": "llm", "name": "writer", "ms": writer_ms},
        ],
    }


async def run_task4(client, task: dict) -> tuple[str, dict]:
    """task-4 预算 replan：单 agent + MCPStdioTool（calculator）。instructions 四步节奏与 ts 侧同源；
    replan 靠 calculator 返回的超预算事实驱动模型重算（非结构层硬编码——notes 如实写）。"""
    budget = task["budget"]
    people = task["people"]
    MCPStdioTool = _maf()[1]
    async with make_mcp_tool(MCPStdioTool) as mcp_tool:
        agent = new_agent(
            client,
            "budget-planner",
            "你是预算规划执行员。任务必须按以下节奏完成：\n"
            "1. 计划：先输出计划——用编号列出至少 3 个具体步骤，明确每项花费与计算式。\n"
            "2. 执行：逐项用 calculator 工具计算，把每步结果与总花费算出来。\n"
            f"3. 校验：若总花费超过 {budget} 元，必须回退修改计划（删减/降价项目）后重新用 calculator 计算，"
            f"直到不超过 {budget} 元。\n"
            "4. 输出最终预算方案：列出保留项目与总花费，并说明已满足预算约束。\n"
            "规则：花费数字必须来自 calculator 的真实返回值，禁止心算编造。",
            mcp_tool=mcp_tool,
        )
        goal = f"{task['goal']} 预算上限 {budget} 元，共 {people} 人。"
        t0 = time.perf_counter()
        raw = await agent.run(goal)
        wall_ms = round((time.perf_counter() - t0) * 1000)
    return extract(raw), {
        "wall_time_ms": wall_ms,
        "trace": [{"step": 1, "kind": "llm", "name": "agent.run(计划→执行→校验→重算循环)", "ms": wall_ms}],
    }


async def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if not arg or arg in ("--help", "-h"):
        print(usage())
        return
    try:
        task = load_task(arg)  # 支持全名/短前缀
    except FileNotFoundError as exc:
        raise SystemExit(str(exc)) from exc
    run_func = {
        "task-1": run_task1,
        "task-2": run_task2,
        "task-3": run_task3,
        "task-4": run_task4,
    }.get(short_id(task["id"]))
    if run_func is None:
        raise SystemExit(f"runner 未实现任务分派: {short_id(task['id'])}（当前支持 task-1..4）")

    # env 驱动：OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL（与 ts-navigate/runner.ts 同套变量；
    # 注意是 OPENAI_MODEL——MAF 不认 OPENAI_CHAT_MODEL_ID）
    OpenAIChatCompletionClient = _maf()[2]
    chat_client = OpenAIChatCompletionClient()
    output, m = await run_func(chat_client, task)

    ok, detail = check_success(task, output)  # 与 ts/CrewAI 同口径机械校验
    result = build_result(
        framework="maf",
        framework_version=framework_version(("agent-framework-core", "agent-framework")),
        task=task,
        success=ok,
        output=output,
        metrics={
            "wall_time_ms": m["wall_time_ms"],
            "llm_calls": None,  # MAF python 未直接暴露 usage 统计 → null（不编造；报告差异点）
            "tool_calls": None,
            "input_tokens": None,
            "output_tokens": None,
        },
        trace=m["trace"],
        notes=(
            f"校验: {detail} | 工具经 MCPStdioTool（TS 侧 benchmark-mcp-server）桥接，"
            "与 ts-navigate/CrewAI 同一份实现 | MAF python 未直接暴露 usage 统计，"
            "llm_calls/tokens/tool_calls 记 null（不编造）| task-3 为手工两次 run 表达 handoff"
            "（未用 Workflow API，pre-release 形态不稳）| task-4 replan 由 instructions 指令 + "
            "calculator 返回事实驱动，非结构层硬编码 | MAF python 为 pre-release，API 以安装版本实测为准 | "
            "code_lines 为 run.py 净行数（共享 py-common 与 tools/ 不计入）"
        ),
        caller_lines=code_lines(Path(__file__)),
    )
    write_result("maf", task, result)
    print(f"success={ok} wall={m['wall_time_ms']}ms")


if __name__ == "__main__":
    asyncio.run(main())
