"""benchmarks/py-crewai/run.py —— CrewAI 侧统一 runner（选手 B，argv 分派 4 任务）

与 ts-navigate/runner.ts 同构：单文件分派 task-1..4，读 benchmarks/tasks/<task>.json，
输出统一结果契约到 benchmarks/results/crewai.<task_id>.json（契约见 docs/plans/p2-framework-benchmarks.md §3.1）。
工具【不】在 Python 侧实现——经 MCP stdio 拉起 TS 侧 benchmark-mcp-server（与 ts-navigate/MAF
同一份 tools.ts），比的是编排能力而非工具实现。

安装（Python 3.10+，建议 venv；CrewAI 依赖较重，首次安装需几分钟）：
    python -m venv .venv
    .venv/Scripts/pip install -U "crewai>=0.105"     # Windows venv 是 Scripts/（Git Bash 也是，无 .venv/bin/）
    # MCP 支持已随 crewai 安装；若报缺 mcp 包：.venv/Scripts/pip install -U mcp
    # 国内网络追加镜像：-i https://mirrors.aliyun.com/pypi/simple/（依赖较重）

运行（LLM 统一走 DeepSeek；任意 cwd 均可，路径按 __file__ 解析）：
    set DEEPSEEK_API_KEY=sk-xxx        # bash: export DEEPSEEK_API_KEY=sk-xxx
    python run.py task-1-rag-qa        # 全名或短 id 均可（task-1）
    python run.py task-4
    python run.py --help

★ 若本机只有 OpenAI 兼容 env（OPENAI_API_KEY + OPENAI_BASE_URL，ts runner 同套）：
    把下方 llm() 的返回改为显式对象（文件头不再赘述）：
        from crewai import LLM
        llm = LLM(model="openai/deepseek-chat", api_key=os.environ["OPENAI_API_KEY"],
                  base_url=os.environ["OPENAI_BASE_URL"])   # LiteLLM openai 兼容路径

API 锚点（2026-09 官方文档）：
  - MCP：Agent(mcps=[MCPServerStdio(command=..., args=...)]) —— 对象形态，非字典；
    退路：crewai_tools.MCPServerAdapter(StdioServerParameters(...)) + tools=adapter.tools()
  - 多 Agent 协作（task-3）：writer 的 Task(context=[researcher_task]) 表达依赖链，CrewAI 自动注入
    上一任务输出——CrewAI 原生 multi-agent 形态（对比点：navigate/MAF 是手工两次 run，见 notes）
  - 遥测：Crew 暴露 usage_metrics（llm_calls/tokens 真实值）——navigate/MAF 记 null 的差异点
  - 每任务新建 Agent/Crew，避免跨任务状态泄漏
"""

from __future__ import annotations

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


def llm() -> str:
    """LiteLLM 内置 provider 字符串（读 DEEPSEEK_API_KEY）；openai 兼容 env 的替换见文件头。"""
    return "deepseek/deepseek-chat"


def _crewai():
    """延迟 import：--help / 非法任务路径不依赖框架；未装时给安装指引而非裸 ImportError。"""
    try:
        from crewai import Agent, Crew, Task
        from crewai.mcp import MCPServerStdio
        return Agent, Crew, Task, MCPServerStdio
    except ImportError as exc:
        raise SystemExit(
            '缺少 crewai：请先创建 venv 并安装（见文件头）：python -m venv .venv 且 '
            '.venv/Scripts/pip install -U "crewai>=0.105"。原始错误：' + str(exc)
        ) from exc


def make_mcp(MCPServerStdio):
    """MCP stdio server 对象：暴露 calculator + weather_now（与 ts-navigate/MAF 同一份实现）。"""
    return MCPServerStdio(
        command="node",
        args=[str(TSX_CLI), str(MCP_SERVER)],
        cache_tools_list=True,  # CrewAI 缓存 5 分钟，避免每次拉起都 list 一次
    )


def collect_usage(crew) -> dict:
    """CrewAI 框架自带遥测 usage_metrics（navigate/MAF 无此暴露 → 报告对比点）。"""
    usage = getattr(crew, "usage_metrics", None)
    if usage is None:
        return {"llm_calls": None, "input_tokens": None, "output_tokens": None}
    return {
        "llm_calls": getattr(usage, "total_llm_calls", None),
        "input_tokens": getattr(usage, "prompt_tokens", None),
        "output_tokens": getattr(usage, "completion_tokens", None),
    }


def run_task1(task: dict) -> tuple[str, dict]:
    """task-1 RAG 问答：无工具。context 进 backstory（对应 ts 的 system），question 进 description。"""
    Agent, Crew, Task, _ = _crewai()
    material = task["context"]
    agent = Agent(
        role="navigate 技术问答助手",
        goal="只依据给定上下文回答用户问题，禁止编造上下文之外的事实",
        backstory=f"上下文：{material}。回答要求：直接给出结论，一句话到三句话，包含关键术语（如技术栈：JavaScript、C++、MAF等）。",
        llm=llm(),
        verbose=True,
    )
    t = Task(
        description=task["question"],
        agent=agent,
        expected_output="依据上下文的结论，一句话到三句话，包含关键术语（如技术栈：JavaScript、C++、MAF等）",
    )
    crew = Crew(agents=[agent], tasks=[t])
    t0 = time.perf_counter()
    out = final_text(crew.kickoff())
    wall_ms = round((time.perf_counter() - t0) * 1000)
    return out, {
        "wall_time_ms": wall_ms,
        **collect_usage(crew),
        "tool_calls": None,  # 无工具
        "trace": [{"step": 1, "kind": "llm", "name": "kickoff(单 agent)", "ms": wall_ms}],
    }


def run_task2(task: dict) -> tuple[str, dict]:
    """task-2 工具编排：单 agent + MCP（calculator + weather_now）。"""
    Agent, Crew, Task, MCPServerStdio = _crewai()
    mcp_server = make_mcp(MCPServerStdio)
    agent = Agent(
        role="工具调度员",
        goal="自主调用 calculator 与 weather_now 工具完成任务，答案必须来自工具返回的真实结果",
        backstory="工具报错就修正参数重试；最后用一句中文总结。",
        llm=llm(),
        mcps=[mcp_server],
        verbose=True,
    )
    t = Task(
        description=task["question"],
        agent=agent,
        expected_output="计算结果与天气的最终答案；只依据工具返回值，禁止编造",
    )
    crew = Crew(agents=[agent], tasks=[t])
    t0 = time.perf_counter()
    out = final_text(crew.kickoff())
    wall_ms = round((time.perf_counter() - t0) * 1000)
    return out, {
        "wall_time_ms": wall_ms,
        **collect_usage(crew),
        "tool_calls": None,  # CrewAI 未直接暴露工具调用计数（verbose 只打日志）→ null
        "trace": [{"step": 1, "kind": "llm", "name": "kickoff(agent 自主工具循环)", "ms": wall_ms}],
    }


def run_task3(task: dict) -> tuple[str, dict]:
    """task-3 多 Agent：researcher → writer。CrewAI 原生形态：writer Task(context=[research_task])
    自动接收上一任务输出（对比点：navigate/MAF 为手工两次 run）。"""
    Agent, Crew, Task, _ = _crewai()
    material = task["context"]
    topic = task["topic"]
    researcher = Agent(
        role="研究员",
        goal="基于给定材料提炼要点，禁止编造材料之外的内容",
        backstory="输出格式：编号列表，至少 3 条要点，每条一句话。",
        llm=llm(),
        verbose=True,
    )
    writer = Agent(
        role="撰稿人",
        goal="依据研究员给出的要点写成短文，必须覆盖全部要点，不得新增材料之外的结论",
        backstory="输出 3-5 句连贯中文。",
        llm=llm(),
        verbose=True,
    )
    research_task = Task(
        description=f"材料：\n{material}\n\n请围绕「{topic}」提炼至少 3 条要点。",
        agent=researcher,
        expected_output="编号列表，至少 3 条要点，每条一句话",
    )
    article_task = Task(
        description="请依据研究员提炼的要点写成短文，覆盖全部要点，不得新增材料之外的结论。",
        agent=writer,
        context=[research_task],  # ★ CrewAI 依赖链：research_task 的输出自动注入本任务上下文（handoff 内置）
        expected_output="3-5 句连贯中文，覆盖全部要点",
    )
    crew = Crew(agents=[researcher, writer], tasks=[research_task, article_task])
    t0 = time.perf_counter()
    out = final_text(crew.kickoff())
    wall_ms = round((time.perf_counter() - t0) * 1000)
    return out, {
        "wall_time_ms": wall_ms,
        **collect_usage(crew),
        "tool_calls": None,  # 无工具
        "trace": [
            {"step": 1, "kind": "llm", "name": "researcher", "ms": wall_ms // 2},  # CrewAI 不暴露分段耗时，粗粒度近似（notes 注明）
            {"step": 2, "kind": "handoff", "name": "researcher→writer(context 注入)", "ms": 0},
            {"step": 3, "kind": "llm", "name": "writer", "ms": wall_ms - wall_ms // 2},
        ],
    }


def run_task4(task: dict) -> tuple[str, dict]:
    """task-4 预算 replan：单 agent + calculator（MCP）。prompt 四步节奏与 ts 侧同源；
    replan 靠 calculator 返回的超预算事实驱动模型重算（非结构层硬编码——notes 如实写）。"""
    Agent, Crew, Task, MCPServerStdio = _crewai()
    budget = task["budget"]
    people = task["people"]
    mcp_server = make_mcp(MCPServerStdio)
    agent = Agent(
        role="预算规划执行员",
        goal="先计划再执行，逐项用 calculator 计算；超预算必须回退修改计划后重算，直到满足约束",
        backstory=(
            "任务节奏：1) 计划：先输出编号列出的至少 3 个具体步骤，明确每项花费与计算式；"
            f"2) 执行：逐项用 calculator 工具计算，算出每步结果与总花费；3) 校验：若总花费超过 {budget} 元，"
            f"必须回退修改计划（删减/降价项目）后重新计算，直到不超过 {budget} 元；"
            "4) 输出最终方案：列出保留项目与总花费并说明已满足预算约束。"
            "规则：花费数字必须来自 calculator 的真实返回值，禁止心算编造。"
        ),
        llm=llm(),
        mcps=[mcp_server],
        verbose=True,
    )
    t = Task(
        description=f"{task['goal']} 预算上限 {budget} 元，共 {people} 人。",
        agent=agent,
        expected_output="保留项目清单 + 总花费（≤ 预算上限），并说明已满足约束",
    )
    crew = Crew(agents=[agent], tasks=[t])
    t0 = time.perf_counter()
    out = final_text(crew.kickoff())
    wall_ms = round((time.perf_counter() - t0) * 1000)
    return out, {
        "wall_time_ms": wall_ms,
        **collect_usage(crew),
        "tool_calls": None,  # 同 task-2：未直接暴露 → null
        "trace": [{"step": 1, "kind": "llm", "name": "kickoff(计划→执行→校验→重算循环)", "ms": wall_ms}],
    }


def main() -> None:
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

    output, metrics = run_func(task)
    ok, detail = check_success(task, output)  # 与 ts/MAF 同口径机械校验
    result = build_result(
        framework="crewai",
        framework_version=framework_version(("crewai",)),
        task=task,
        success=ok,
        output=output,
        metrics={
            "wall_time_ms": metrics["wall_time_ms"],
            "llm_calls": metrics["llm_calls"],
            "tool_calls": metrics["tool_calls"],
            "input_tokens": metrics["input_tokens"],
            "output_tokens": metrics["output_tokens"],
        },
        trace=metrics["trace"],
        notes=(
            f"校验: {detail} | 工具经 MCP stdio（TS 侧 benchmark-mcp-server）桥接，"
            "与 ts-navigate/MAF 同一份实现 | llm_calls/tokens 来自 CrewAI usage_metrics（框架自带遥测），"
            "tool_calls 未直接暴露记 null | task-3 为 CrewAI 原生 context 链（自动注入），"
            "trace 分段耗时为墙钟近似 | task-4 replan 由 backstory 指令 + calculator 返回事实驱动，非结构层硬编码 | "
            "code_lines 为 run.py 净行数（共享 py-common 与 tools/ 不计入）"
        ),
        caller_lines=code_lines(Path(__file__)),
    )
    write_result("crewai", task, result)
    print(f"success={ok} wall={metrics['wall_time_ms']}ms llm_calls={metrics['llm_calls']}")


if __name__ == "__main__":
    main()
