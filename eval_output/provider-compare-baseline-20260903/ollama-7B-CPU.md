# ollama-7B-CPU

- provider: `ollama` / model: `qwen2.5:7b` @ `http://localhost:11434/v1`
- judge: 固定 DeepSeek（**与被测解耦**，避免 self-preference bias）
- judge 判定：每题 3 轮独立判定取多数（claim 布尔多数 / 分数众数档）；claim 判定允许语义等价
- createdAt: 2026-09-03T04:26:25.372Z
- samples: 16（成功 16 / 失败 0）

## 汇总

| 指标 | 均值 |
|---|---|
| answerRelevancy（答案相关性） | 0.969 |
| claimCoverage（关键断言覆盖度） | 0.979 |
| totalMs（端到端延迟） | 19980 |
| outputTokens | 146.4 |

## 按题型分组

| 题型 | n | answerRelevancy | claimCoverage |
|---|---|---|---|
| factual | 4 | 1.000 | 0.917 |
| reasoning | 4 | 1.000 | 1.000 |
| instruction | 4 | 1.000 | 1.000 |
| format | 4 | 0.875 | 1.000 |

## 明细

| id | 题型 | answerRelevancy | claimCoverage | totalMs | tokens | status |
|---|---|---|---|---|---|---|
| fact-01 | factual | 1.00 | 1.00 | 31994 | 96 | ok |
| fact-02 | factual | 1.00 | 1.00 | 45676 | 364 | ok |
| fact-03 | factual | 1.00 | 0.67 | 41598 | 337 | ok |
| fact-04 | factual | 1.00 | 1.00 | 36740 | 294 | ok |
| reas-01 | reasoning | 1.00 | 1.00 | 32863 | 257 | ok |
| reas-02 | reasoning | 1.00 | 1.00 | 2670 | 13 | ok |
| reas-03 | reasoning | 1.00 | 1.00 | 24387 | 191 | ok |
| reas-04 | reasoning | 1.00 | 1.00 | 41336 | 325 | ok |
| inst-01 | instruction | 1.00 | 1.00 | 7713 | 56 | ok |
| inst-02 | instruction | 1.00 | 1.00 | 7922 | 59 | ok |
| inst-03 | instruction | 1.00 | 1.00 | 2650 | 15 | ok |
| inst-04 | instruction | 1.00 | 1.00 | 5475 | 35 | ok |
| fmt-01 | format | 1.00 | 1.00 | 6572 | 49 | ok |
| fmt-02 | format | 1.00 | 1.00 | 18363 | 157 | ok |
| fmt-03 | format | 1.00 | 1.00 | 2461 | 11 | ok |
| fmt-04 | format | 0.50 | 1.00 | 11261 | 83 | ok |

## 低分题 claim 判定明细

### fact-03（factual，claimCoverage=0.67）

| # | claim | supported | reason |
|---|---|---|---|
| 0 | 向量数据库用于持久化存储高维向量 | ✅ | 上下文说明向量数据库专门用于存储和查询向量数据，向量数据为高维向量。 |
| 1 | 它支持按相似度进行近邻检索 | ✅ | 上下文提到向量相似性搜索和最近邻搜索，即按相似度检索。 |
| 2 | 典型用途是为大模型提供语义检索（RAG） | ❌ | 上下文未提及大模型、语义检索或RAG，属额外背景知识。 |
