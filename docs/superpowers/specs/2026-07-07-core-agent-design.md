---
title: Core Agent - Iter 1 设计文档
date: 2026-07-07
status: draft
---

# Core Agent - Iter 1 设计

## 概述

基于 LangChain + Node.js/TypeScript 构建一个交互式 agent 系统，核心功能包括 Agent Loop（ReAct 模式）、Function Call（工具调用）和终端 TUI 交互。这是三步分解中的第一个迭代。

## 技术栈

| 层 | 技术选择 |
|---|---|
| 语言 | TypeScript (Node.js) |
| Agent 框架 | LangChain.js（AgentExecutor + OpenAI tools agent）|
| LLM | OpenAI (GPT-4o)，通过 LangChain ChatOpenAI 集成 |
| TUI | ink（React for CLI）|
| 包管理 | npm / yarn |

## 架构

```
TUI (ink/React)
     │ 用户输入 / 流式输出
Agent Loop (AgentExecutor)
     │ 工具调用 / 结果
Tools Layer (Registry + 内置工具)
     │
OpenAI API (ChatOpenAI)
```

### 组件说明

#### 1. Agent Loop（src/agent/）

- **langchain.ts** — 初始化 ChatOpenAI 模型实例，配置 base URL、API key、model name
- **loop.ts** — 创建 OpenAIToolsAgent + AgentExecutor，配置 streaming、max iterations（默认 25）、early stopping
- **prompt.ts** — 构建 system prompt，包含 agent 人格定义、行为规则、工具使用约束
- **types.ts** — AgentConfig、ToolResult 等类型定义

#### 2. Function Call / Tools（src/tools/）

- **registry.ts** — 全局工具注册函数 createTools(config)，按需启用/禁用工具集
- **内置工具**（参考 Claude Code）：
  - execute_command — 执行 shell 命令，返回 stdout/stderr/exit code
  - read_file — 读取文件内容（支持行范围）
  - write_file — 写入或创建文件
  - edit_file — 精确定位替换/插入（search-and-replace 模式）
  - list_files — 列出目录内容
  - search_files — 基于 ripgrep 的文本搜索
- 每个工具使用 LangChain StructuredTool 定义，含名称、描述、输入 JSON Schema

#### 3. TUI（src/tui/）

- **app.tsx** — ink 主应用组件，管理应用生命周期
- **input.tsx** — 输入框组件，支持多行输入，快捷键 Ctrl+C 取消，Enter 提交
- **output.tsx** — 输出展示组件：
  - agent 思考步骤折叠展示
  - 工具调用展示（工具名 + 参数 + 结果）
  - 最终回复流式渲染
  - 彩色标记区分不同类型的输出
- **commands.ts** — 内建命令处理（/exit、/clear、/help）

#### 4. Config（src/config/）

- 从环境变量加载配置：OPENAI_API_KEY、OPENAI_MODEL（默认 gpt-4o）、MAX_ITERATIONS（默认 25）
- 可选 OPENAI_BASE_URL 支持代理/自定义端点

## 数据流

1. 用户通过 TUI 输入 prompt
2. AgentExecutor 接收 prompt + 历史记录
3. LLM 返回 tool_call 或最终回复
4. 若为 tool_call：执行对应工具 → 结果传回 LLM → 继续循环
5. 若为最终回复：流式渲染到 TUI，等待下一轮用户输入

## 错误处理

- 工具执行失败：错误信息作为 observation 传回 LLM，让 agent 自行决定重试或给出回复
- LLM 调用超时：重试 2 次后提示用户
- 超出 max iterations：agent 返回当前中间结果并提示

## 未包含在 Iter 1（后续迭代覆盖）

- 对话持久化（Iter 2 Memory）
- RAG 检索（Iter 3）
- 文档上传 RAG 页面（Iter 3）
