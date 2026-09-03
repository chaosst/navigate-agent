# vLLM-1.5B-GPU

- provider: `vllm` / model: `Qwen2.5-1.5B-Instruct` @ `http://localhost:8000/v1`
- judge: 固定 DeepSeek（**与被测解耦**，避免 self-preference bias）
- judge 判定：每题 3 轮独立判定取多数（claim 布尔多数 / 分数众数档）；claim 判定允许语义等价
- createdAt: 2026-09-03T04:48:47.642Z
- samples: 16（成功 16 / 失败 0）

## 汇总

| 指标 | 均值 |
|---|---|
| answerRelevancy（答案相关性） | 0.750 |
| claimCoverage（关键断言覆盖度） | 0.922 |
| totalMs（端到端延迟） | 2007 |
| outputTokens | 148.9 |

## 按题型分组

| 题型 | n | answerRelevancy | claimCoverage |
|---|---|---|---|
| factual | 4 | 0.625 | 0.854 |
| reasoning | 4 | 1.000 | 1.000 |
| instruction | 4 | 0.625 | 0.833 |
| format | 4 | 0.750 | 1.000 |

## 明细

| id | 题型 | answerRelevancy | claimCoverage | totalMs | tokens | status |
|---|---|---|---|---|---|---|
| fact-01 | factual | 1.00 | 1.00 | 4007 | 111 | ok |
| fact-02 | factual | 0.50 | 1.00 | 3805 | 347 | ok |
| fact-03 | factual | 0.50 | 0.67 | 2590 | 227 | ok |
| fact-04 | factual | 0.50 | 0.75 | 3820 | 340 | ok |
| reas-01 | reasoning | 1.00 | 1.00 | 3658 | 315 | ok |
| reas-02 | reasoning | 1.00 | 1.00 | 395 | 13 | ok |
| reas-03 | reasoning | 1.00 | 1.00 | 2130 | 170 | ok |
| reas-04 | reasoning | 1.00 | 1.00 | 3067 | 270 | ok |
| inst-01 | instruction | 0.50 | 0.33 | 648 | 32 | ok |
| inst-02 | instruction | 1.00 | 1.00 | 1161 | 74 | ok |
| inst-03 | instruction | 0.50 | 1.00 | 497 | 26 | ok |
| inst-04 | instruction | 0.50 | 1.00 | 1211 | 89 | ok |
| fmt-01 | format | 1.00 | 1.00 | 776 | 49 | ok |
| fmt-02 | format | 0.50 | 1.00 | 2653 | 227 | ok |
| fmt-03 | format | 1.00 | 1.00 | 453 | 11 | ok |
| fmt-04 | format | 0.50 | 1.00 | 1240 | 82 | ok |

## 低分题 claim 判定明细

### fact-03（factual，claimCoverage=0.67）

| # | claim | supported | reason |
|---|---|---|---|
| 0 | 向量数据库用于持久化存储高维向量 | ✅ | 上下文提到存储和检索高维特征数据，即向量数据 |
| 1 | 它支持按相似度进行近邻检索 | ✅ | 上下文明确说可以快速进行相似性搜索 |
| 2 | 典型用途是为大模型提供语义检索（RAG） | ❌ | 上下文未提及大模型、RAG或语义检索 |

### fact-04（factual，claimCoverage=0.75）

| # | claim | supported | reason |
|---|---|---|---|
| 0 | 403 表示服务器理解请求但拒绝执行（通常因权限不足） | ✅ | 上下文明确描述403是服务器理解请求但拒绝提供服务。 |
| 1 | 500 表示服务器内部错误 | ✅ | 上下文明确说明500表示服务器内部错误。 |
| 2 | 403 属于客户端错误（4xx） | ❌ | 上下文称403可视为服务端错误，与claim的客户端错误矛盾。 |
| 3 | 500 属于服务端错误（5xx） | ✅ | 上下文明确总结500是服务端错误。 |

### inst-01（instruction，claimCoverage=0.33）

| # | claim | supported | reason |
|---|---|---|---|
| 0 | 提到先从外部知识库检索相关内容 | ❌ | 上下文未提及外部知识库或检索顺序 |
| 1 | 提到检索到的信息被用于辅助生成（检索与生成相结合） | ✅ | 上下文明确'结合检索和生成技术'，语义一致 |
| 2 | 提到该机制用于提升答案准确性或减少幻觉 | ❌ | 上下文未提准确性提升或减少幻觉 |
