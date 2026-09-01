# ollama-7B-CPU

- provider: `ollama` / model: `qwen2.5:7b` @ `http://localhost:11434/v1`
- judge: 固定 DeepSeek（**与被测解耦**，避免 self-preference bias）
- createdAt: 2026-09-01T07:02:58.838Z
- samples: 12（成功 12 / 失败 0）

## 汇总

| 指标 | 均值 |
|---|---|
| answerRelevancy（答案相关性） | 1.000 |
| claimCoverage（关键断言覆盖度） | 0.597 |
| totalMs（端到端延迟） | 19181 |
| outputTokens | 128.6 |

## 按题型分组

| 题型 | n | answerRelevancy | claimCoverage |
|---|---|---|---|
| factual | 3 | 1.000 | 0.611 |
| reasoning | 3 | 1.000 | 0.667 |
| instruction | 3 | 1.000 | 0.111 |
| format | 3 | 1.000 | 1.000 |

## 明细

| id | 题型 | answerRelevancy | claimCoverage | totalMs | tokens | status |
|---|---|---|---|---|---|---|
| fact-01 | factual | 1.00 | 0.50 | 23455 | 58 | ok |
| fact-02 | factual | 1.00 | 1.00 | 49493 | 364 | ok |
| fact-03 | factual | 1.00 | 0.33 | 44747 | 337 | ok |
| reas-01 | reasoning | 1.00 | 1.00 | 35037 | 257 | ok |
| reas-02 | reasoning | 1.00 | 0.00 | 2825 | 13 | ok |
| reas-03 | reasoning | 1.00 | 1.00 | 26144 | 191 | ok |
| inst-01 | instruction | 1.00 | 0.00 | 4707 | 32 | ok |
| inst-02 | instruction | 1.00 | 0.33 | 8421 | 59 | ok |
| inst-03 | instruction | 1.00 | 0.00 | 2861 | 15 | ok |
| fmt-01 | format | 1.00 | 1.00 | 7634 | 49 | ok |
| fmt-02 | format | 1.00 | 1.00 | 22294 | 157 | ok |
| fmt-03 | format | 1.00 | 1.00 | 2557 | 11 | ok |
