# navigate P2 Agent 框架对比实验

用**同一批任务**在三个 runner 上跑分，产出对比报告（`docs/interview-notes/framework-comparison.md`），支撑面试回答"为什么选 LangGraph"。

| runner | 语言 | 职责 | 代码量（run.py / runner.ts 实测净行） |
|---|---|---|---|
| `py-maf/` | Python | Microsoft Agent Framework 胶水层 | 228 行（单文件 4 任务） |
| `py-crewai/` | Python | CrewAI 胶水层 | 253 行（单文件 4 任务） |
| `ts-navigate/` | TypeScript | navigate 现有 LangGraph 执行器 | 284 行（单文件 4 任务） |

> 代码量为**胶水层**净行（去空行/纯注释）。共享的 `py-common/`（结果契约骨架）与 `tools/`（工具实现）三方共用，**不计入任何一方**——口径与计划文档 §3.1 一致。
>
> ✅ 三方均为**单文件分派 4 任务**（`run.py task-N` / `runner.ts task-N`），`code_lines` 是每方 runner 文件的总净行（所有任务同值，notes 注明）——不再存在"文件粒度不一致"问题。

> **三方共用** `tools/` 里的同一份工具实现（TS 写的 mock 工具），比的是框架编排能力，不是工具实现。Python 侧通过 MCP（stdio）连接，ts-navigate 直接 import。

## 目录

```
tasks/           共享任务定义（JSON，三方同一份，禁止改动）
tools/           统一工具层：tools.ts + benchmark-mcp-server.ts + tool-contract.json
py-common/       py runner 共享骨架（标准库：任务读取/结果契约写出，不计入 code_lines）
py-maf/          选手 A（Python，agent-framework-core）
py-crewai/       选手 B（Python）
ts-navigate/     选手 C（TypeScript，navigate 执行器）
results/         三方输出的统一契约 JSON（报告引用）
```

## 快速开始

### 1. 统一工具层（TS）

```bash
# 在仓库根目录（navigate/）安装依赖后，直接跑 MCP server（stdio）
node_modules/.bin/tsx benchmarks/tools/benchmark-mcp-server.ts

# 冒烟验证（已实测通过）：拉起后 tools/list 返回 calculator + weather_now，
# calculator("3+4*2") → { ok:true, value:11 }，非法表达式 → { ok:false, error }
```

### 2. ts-navigate（选手 C，先跑这个出基线）

```bash
cd benchmarks/ts-navigate
# env（DeepSeek，OpenAI 兼容）：
export OPENAI_API_KEY=sk-xxx
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat
node --import tsx runner.ts task-1-rag-qa        # 输出 ../results/navigate.task-1-rag-qa.json（全名）
node --import tsx runner.ts task-4               # 短 id 等价；输出 .../navigate.task-4-plan-execute.json
# ★ Node >=20.6 用 --import tsx（--loader 已废弃，Node 22+/24 会直接报错）
```

### 3. py-crewai（选手 B）

```bash
cd benchmarks/py-crewai
python -m venv .venv
# 注意：Windows venv 生成 .venv/Scripts/（Git Bash 也是，不存在 .venv/bin/）
# 国内网络建议追加镜像：-i https://mirrors.aliyun.com/pypi/simple/（依赖几百 MB）
.venv/Scripts/python -m pip install -U pip
.venv/Scripts/pip install -U "crewai>=0.105"    # 拉最新稳定版（2026-08 已到 1.15.x）
# MCP 支持已随 crewai 安装；缺 mcp 包则补：.venv/Scripts/pip install -U mcp
export DEEPSEEK_API_KEY=sk-xxx                  # 见"统一 LLM 配置"
.venv/Scripts/python run.py task-1-rag-qa       # 全名或短 id 均可；输出 ../results/crewai.<task_id>.json
.venv/Scripts/python run.py task-4
```

### 4. py-maf（选手 A，API 最新，放最后）

```bash
cd benchmarks/py-maf
python -m venv .venv
# MAF 已 GA（2026-09 实测装到 agent-framework-core 1.16.x + agent-framework-openai 1.14.x）
.venv/Scripts/python -m pip install -U pip
.venv/Scripts/pip install -U "agent-framework-core[all]"
# mcp 包：新版本 core 依赖已自带 mcp[ws]；若 import MCPStdioTool 报缺 mcp 再手动装：
# .venv/Scripts/pip install -U mcp
export OPENAI_API_KEY=sk-xxx                    # 与 ts-navigate 同套 env（见下）
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat               # ★ 模型变量名是 OPENAI_MODEL，MAF 不认 OPENAI_CHAT_MODEL_ID
.venv/Scripts/python run.py task-1-rag-qa       # 输出 ../results/maf.<task_id>.json
.venv/Scripts/python run.py task-3
```

> 结果文件名统一为 `<framework>.<task_id 全名>.json`（如 `navigate.task-4-plan-execute.json`），三方命名口径一致，报告/汇总脚本可直接 glob。

## 统一 LLM 配置（三方必须同后端 DeepSeek，否则不可比）

| runner | env | 说明 |
|---|---|---|
| ts-navigate | `OPENAI_API_KEY` `OPENAI_BASE_URL=https://api.deepseek.com/v1` `OPENAI_MODEL=deepseek-chat` | 自包含构造 ChatOpenAI |
| py-crewai | `DEEPSEEK_API_KEY` | `llm="deepseek/deepseek-chat"`（LiteLLM 内置 provider） |
| py-maf | `OPENAI_API_KEY` `OPENAI_BASE_URL=https://api.deepseek.com/v1` `OPENAI_MODEL=deepseek-chat` | 无参 `OpenAIChatCompletionClient()` 读 env，与 ts 同套变量。★ 必须用 ChatCompletion 版：`OpenAIChatClient` 是 Responses API（DeepSeek 404，2026-09-03 源码实锤） |

- 三方指向**同一个** `base_url` + 模型，否则 token 与耗时不可比
- py-crewai 若无 `DEEPSEEK_API_KEY`、只有 OpenAI 兼容 env：改 `LLM(model="openai/deepseek-chat", api_key=..., base_url=...)`（见 run.py 文件头）
- 每轮调用设 `max_iterations` 上限（建议 10），控制成本

## 指标口径（写死，改口径需同步改文档）

| 指标 | 定义 |
|---|---|
| `wall_time_ms` | 端到端耗时（不含冷启动/import；从任务开始到输出完成） |
| `llm_calls` | LLM 请求次数（不含 embedding；本实验无 embedding） |
| `tool_calls` | 工具调用次数（三方均为对 `tools/` 的调用） |
| `input_tokens` / `output_tokens` | 取不到就写 `null`，**禁止编造** |
| `code_lines` | 该 runner 实现此任务的净行数，**不含 `tools/` 与 navigate 的 `src/`** |
| `trace[].kind` | `llm \| tool \| handoff \| checkpoint`，用于对比控制流 |

## MCP 桥接快速参考（2026-09 实测/官方文档口径）

- `benchmark-mcp-server.ts` 用 `@modelcontextprotocol/sdk`（1.30.0）实现，stdio 拉起组合已在 Windows 实测：
  `command="node", args=[<repo>/node_modules/tsx/dist/cli.mjs, <repo>/benchmarks/tools/benchmark-mcp-server.ts]`
  （本地纯计算工具，**无需任何 API key**；tsc strict + MCP client 冒烟均通过）
- CrewAI：`from crewai.mcp import MCPServerStdio` → `Agent(..., mcps=[MCPServerStdio(command=..., args=...)])`
  （对象形态，非字典；退路：`crewai_tools.MCPServerAdapter` + `tools=adapter.tools()`）
- MAF：`from agent_framework import MCPStdioTool` → `async with MCPStdioTool(command=..., args=...) as mcp_tool:`，
  tools 传 `[mcp_tool]`（部分版本为 `mcp_tool.functions`）；主类 `Agent`/`ChatAgent` 命名随版本，见 py-maf 文件头
- Windows 注意：`command`/`args` 用**绝对路径**（`__file__` 推导），反斜杠转义是高频翻车点

## 防踩坑

- **MAF 无 TS SDK**，别把 `microsoft/Agents-for-js`（Microsoft 365 Agents SDK）当成 MAF 的 TS 版
- 每框架独立 venv，MAF 与 CrewAI 依赖树都重，勿混装
- 跑不通就降级：README 记录"未做/降级"原因，报告如实写，不硬凑
