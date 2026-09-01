# DeepSeek

- provider: `openai` / model: `deepseek-v4-flash` @ `https://api.deepseek.com`
- judge: 固定 DeepSeek（**与被测解耦**，避免 self-preference bias）
- createdAt: 2026-09-01T06:56:20.641Z
- samples: 12（成功 12 / 失败 0）

## 汇总

| 指标 | 均值 |
|---|---|
| answerRelevancy（答案相关性） | 1.000 |
| claimCoverage（关键断言覆盖度） | 0.778 |
| totalMs（端到端延迟） | 2371 |
| outputTokens | 172.5 |

## 按题型分组

| 题型 | n | answerRelevancy | claimCoverage |
|---|---|---|---|
| factual | 3 | 1.000 | 0.611 |
| reasoning | 3 | 1.000 | 0.667 |
| instruction | 3 | 1.000 | 0.833 |
| format | 3 | 1.000 | 1.000 |

## 明细

| id | 题型 | answerRelevancy | claimCoverage | totalMs | tokens | status |
|---|---|---|---|---|---|---|
| fact-01 | factual | 1.00 | 0.50 | 4038 | 99 | ok |
| fact-02 | factual | 1.00 | 1.00 | 2490 | 179 | ok |
| fact-03 | factual | 1.00 | 0.33 | 7753 | 717 | ok |
| reas-01 | reasoning | 1.00 | 1.00 | 2443 | 261 | ok |
| reas-02 | reasoning | 1.00 | 0.00 | 1097 | 65 | ok |
| reas-03 | reasoning | 1.00 | 1.00 | 1641 | 112 | ok |
| inst-01 | instruction | 1.00 | 0.50 | 839 | 50 | ok |
| inst-02 | instruction | 1.00 | 1.00 | 1587 | 116 | ok |
| inst-03 | instruction | 1.00 | 1.00 | 1733 | 101 | ok |
| fmt-01 | format | 1.00 | 1.00 | 1361 | 81 | ok |
| fmt-02 | format | 1.00 | 1.00 | 2622 | 236 | ok |
| fmt-03 | format | 1.00 | 1.00 | 853 | 53 | ok |
