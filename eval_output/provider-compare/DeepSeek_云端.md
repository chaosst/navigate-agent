# DeepSeek 云端

- provider: `openai` / model: `deepseek-v4-flash` @ `https://api.deepseek.com`
- judge: 固定 DeepSeek（**与被测解耦**，避免 self-preference bias）
- judge 判定：每题 3 轮独立判定取多数（claim 布尔多数 / 分数众数档）；claim 判定允许语义等价
- createdAt: 2026-09-03T04:00:52.931Z
- samples: 16（成功 16 / 失败 0）

## 汇总

| 指标 | 均值 |
|---|---|
| answerRelevancy（答案相关性） | 1.000 |
| claimCoverage（关键断言覆盖度） | 1.000 |
| totalMs（端到端延迟） | 2245 |
| outputTokens | 202.8 |

## 按题型分组

| 题型 | n | answerRelevancy | claimCoverage |
|---|---|---|---|
| factual | 4 | 1.000 | 1.000 |
| reasoning | 4 | 1.000 | 1.000 |
| instruction | 4 | 1.000 | 1.000 |
| format | 4 | 1.000 | 1.000 |

## 明细

| id | 题型 | answerRelevancy | claimCoverage | totalMs | tokens | status |
|---|---|---|---|---|---|---|
| fact-01 | factual | 1.00 | 1.00 | 3447 | 83 | ok |
| fact-02 | factual | 1.00 | 1.00 | 2296 | 232 | ok |
| fact-03 | factual | 1.00 | 1.00 | 9080 | 1011 | ok |
| fact-04 | factual | 1.00 | 1.00 | 2113 | 204 | ok |
| reas-01 | reasoning | 1.00 | 1.00 | 2060 | 250 | ok |
| reas-02 | reasoning | 1.00 | 1.00 | 619 | 46 | ok |
| reas-03 | reasoning | 1.00 | 1.00 | 1029 | 116 | ok |
| reas-04 | reasoning | 1.00 | 1.00 | 1632 | 166 | ok |
| inst-01 | instruction | 1.00 | 1.00 | 1142 | 91 | ok |
| inst-02 | instruction | 1.00 | 1.00 | 1577 | 165 | ok |
| inst-03 | instruction | 1.00 | 1.00 | 2185 | 154 | ok |
| inst-04 | instruction | 1.00 | 1.00 | 1525 | 119 | ok |
| fmt-01 | format | 1.00 | 1.00 | 1308 | 105 | ok |
| fmt-02 | format | 1.00 | 1.00 | 3176 | 342 | ok |
| fmt-03 | format | 1.00 | 1.00 | 1420 | 56 | ok |
| fmt-04 | format | 1.00 | 1.00 | 1319 | 105 | ok |
