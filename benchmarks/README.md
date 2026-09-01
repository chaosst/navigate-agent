# navigate P2 Agent 框架对比实验

用**同一批任务**在三个 runner 上跑分，产出对比报告（`docs/interview-notes/framework-comparison.md`），支撑面试回答"为什么选 LangGraph"。

| runner | 语言 | 职责 | 代码量 |
|---|---|---|---|
| `py-maf/` | Python | Microsoft Agent Framework 胶水层 | 每任务 ~60-80 行 |
| `py-crewai/` | Python | CrewAI 胶水层 | 每任务 ~50-70 行 |
| `ts-navigate/` | TypeScript | navigate 现有 LangGraph 执行器 | 每任务 ~80-120 行 |

> **三方共用** `tools/` 里的同一份工具实现（TS 写的 mock 工具），比的是框架编排能力，不是工具实现。Python 侧通过 MCP（stdio）连接，ts-navigate 直接 import。

## 目录

```
tasks/           共享任务定义（JSON，三方同一份，禁止改动）
tools/           统一工具层：tools.ts + benchmark-mcp-server.ts + tool-contract.json
py-maf/          选手 A（Python）
py-crewai/       选手 B（Python）
ts-navigate/     选手 C（TypeScript）
results/         三方输出的统一契约 JSON（报告引用）
```

## 快速开始

### 1. 统一工具层（TS）

```bash
# 在仓库根目录（navigate/）安装依赖后，直接跑 MCP server（stdio）
node_modules/.bin/tsx benchmarks/tools/benchmark-mcp-server.ts

# 冒烟验证：用任意 MCP 客户端（如 opencode / mcp-inspector）发起 tools/list，
# 应返回 calculator 与 weather_now，且与 tool-contract.json 一致
```

### 2. ts-navigate（选手 C，先跑这个出基线）

```bash
cd benchmarks/ts-navigate
node --loader tsx runner.ts task-1-rag-qa        # 输出 ../results/navigate.task-1.json
node --loader tsx runner.ts task-4-plan-execute
```

### 3. py-crewai（选手 B）

```bash
cd benchmarks/py-crewai
python -m venv .venv
# Git Bash:  .venv/bin/pip install -r requirements.txt
# CMD/PS:    .venv\Scripts\pip install -r requirements.txt
.venv/bin/python run_task1.py
.venv/bin/python run_task2.py
```

### 4. py-maf（选手 A，API 最新，放最后）

```bash
cd benchmarks/py-maf
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run_task1.py
```

## 统一 LLM 配置（三方必须同后端，否则不可比）

```bash
export DEEPSEEK_API_KEY=sk-xxx
export OPENAI_BASE_URL=https://api.deepseek.com    # 或写到各 runner 的配置里
export OPENAI_MODEL=deepseek-chat                   # 以 DeepSeek 文档为准
```

- 三方必须指向**同一个** `base_url` + 模型，否则 token 与耗时不可比
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

## MCP 桥接快速参考

- `benchmark-mcp-server.ts` 用 `@modelcontextprotocol/sdk`（1.30.0）实现，**照搬** `rag-mcp/src/index.ts` 的 stdio 写法
- CrewAI：agent 的 `mcps` 字段（`transport: "stdio"`）；API 有出入时改用 `crewai_tools.MCPServerAdapter`
- MAF：原生 MCP client，API 以官方文档为准；**遇 AutoGen 0.4 写法直接判定过时**
- Windows 注意：`command`/`args` 用**绝对路径**或相对 `benchmarks/` 的路径，反斜杠转义是高频翻车点

## 防踩坑

- **MAF 无 TS SDK**，别把 `microsoft/Agents-for-js`（Microsoft 365 Agents SDK）当成 MAF 的 TS 版
- 每框架独立 venv，MAF 与 CrewAI 依赖树都重，勿混装
- 跑不通就降级：README 记录"未做/降级"原因，报告如实写，不硬凑
