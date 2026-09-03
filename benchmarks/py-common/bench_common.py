"""benchmarks/py-common/bench_common.py —— py 侧（CrewAI / MAF）runner 共享骨架

纯标准库、零第三方依赖。职责：
  1. 任务读取：benchmarks/tasks/<task>.json
  2. 结果契约写出：benchmarks/results/<framework>.<task_id>.json（对齐 docs/plans/p2-framework-benchmarks.md §3.1）
  3. code_lines / run_at 等口径统一

口径声明（重要，报告用）：
  - 本模块是共享实现，等价于 tools/（TS 侧共享工具），【不计入任何一方的 code_lines】。
    各方 code_lines 只统计各自 runner 文件的净行数（去空行/纯注释）。
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # benchmarks/
TASKS_DIR = ROOT / "tasks"
RESULTS_DIR = ROOT / "results"
REPO = ROOT.parent  # 仓库根 D:/develop/navigate（MAF/CrewAI 拉起 TS MCP server 用）


def load_task(task_id: str) -> dict:
    """按任务 id 读取 tasks/*.json。

    支持两种写法：
      - 全名：task-2-tool-orchestrate
      - 短前缀：task-2（自动匹配唯一文件，要求前缀不歧义）
    文件不存在时抛 FileNotFoundError 并列出可用任务。
    """
    full = TASKS_DIR / f"{task_id}.json"
    if full.exists():
        with full.open("r", encoding="utf-8") as f:
            return json.load(f)

    matches = [p for p in TASKS_DIR.glob("*.json") if p.stem.startswith(task_id)]
    if len(matches) == 1:
        with matches[0].open("r", encoding="utf-8") as f:
            return json.load(f)
    if len(matches) > 1:
        names = ", ".join(p.stem for p in matches)
        raise FileNotFoundError(f"任务前缀 '{task_id}' 有歧义，匹配到多个：{names}")

    available = ", ".join(sorted(p.stem for p in TASKS_DIR.glob("*.json")))
    raise FileNotFoundError(
        f"找不到任务 '{task_id}'（期望 {TASKS_DIR} 下的文件名）。可用：{available}"
    )


def now_iso() -> str:
    """本地时区 ISO 8601（契约 run_at 示例带 +08:00）。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def code_lines(path: Path) -> int:
    """净行数口径：去空行与纯注释行（// # /* * 开头），与 ts 侧 countCodeLines 对齐。"""
    n = 0
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if t and not t.startswith(("#", "//", "/*", "*")):
                n += 1
    return n


def short_id(task_id: str) -> str:
    """task-1-rag-qa → task-1（与 ts runner 的短 id 口径一致，用于 argv 分派）。"""
    return task_id.split("-")[0] + "-" + task_id.split("-")[1]


def check_success(task: dict, output: str) -> tuple[bool, str]:
    """按任务 JSON 的 expected_keywords 机械校验（三方 runner 同口径）。

    - 有 expected_keywords：全部（大小写不敏感）命中才算成功，detail 返回缺失/命中列表
    - 无 expected_keywords（如 task-4）：不自动判失败，detail 提示需人工核（预算约束无法从文本可靠断言）
    """
    kws = task.get("expected_keywords") or []
    if not kws:
        return True, "无 expected_keywords 约束（人工核：task-4 需确认最终预算 ≤ budget）"
    low = output.lower()
    missing = [k for k in kws if k.lower() not in low]
    if missing:
        return False, f"缺少关键词: {', '.join(missing)}"
    return True, f"关键词命中: {', '.join(kws)}"


def framework_version(pkg_names: tuple[str, ...]) -> str:
    """从已安装发行版读框架版本；读不到返回 'unknown'（诚实，不编造）。"""
    try:
        from importlib import metadata
    except ImportError:  # py < 3.8 的兜底，本项目不会走到
        return "unknown"
    for name in pkg_names:
        try:
            return metadata.version(name)
        except metadata.PackageNotFoundError:
            continue
    return "unknown"


def build_result(
    framework: str,
    framework_version: str,
    task: dict,
    *,
    success: bool,
    output: str,
    metrics: dict,
    trace: list[dict],
    notes: str,
    caller_lines: int,
) -> dict:
    """按 §3.1 契约拼装结果 JSON。

    参数：
      metrics   : 除 code_lines 外的指标 dict（wall_time_ms/llm_calls/tool_calls/input_tokens/output_tokens）
      caller_lines: 调用方 runner 的净行数（code_lines(__file__)），写入 metrics.code_lines
    """
    assert metrics.keys() <= {
        "wall_time_ms", "llm_calls", "tool_calls", "input_tokens", "output_tokens",
    }, f"metrics 含未约定键：{metrics.keys() - {'wall_time_ms','llm_calls','tool_calls','input_tokens','output_tokens'}}"
    result = {
        "framework": framework,
        "framework_version": framework_version,
        "task_id": task["id"],
        "run_at": now_iso(),
        "success": success,
        "output": output,
        "metrics": {**metrics, "code_lines": caller_lines},
        "trace": trace,
        "notes": notes,
    }
    return result


def write_result(framework: str, task: dict, result: dict) -> Path:
    """写 benchmarks/results/<framework>.<task_id>.json，返回路径。"""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out = RESULTS_DIR / f"{framework}.{task['id']}.json"
    with out.open("w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"[bench_common] 结果已写入 {out}")
    return out


def final_text(raw) -> str:
    """把各框架返回对象统一成纯文本：优先 .raw/.text/.content 属性，再 str()。"""
    if raw is None:
        return ""
    for attr in ("raw", "text", "content", "final"):
        v = getattr(raw, attr, None)
        if v is not None and not callable(v):
            if attr == "content" and isinstance(v, list):
                parts = [getattr(c, "text", None) or str(c) for c in v]
                return "\n".join(parts)
            return str(v)
    return str(raw)
