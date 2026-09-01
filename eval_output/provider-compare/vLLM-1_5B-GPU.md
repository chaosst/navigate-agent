# vLLM-1.5B-GPU

- provider: `vllm` / model: `Qwen2.5-1.5B-Instruct` @ `http://localhost:8000/v1`
- judge: 固定 DeepSeek（**与被测解耦**，避免 self-preference bias）
- createdAt: 2026-09-01T07:05:12.567Z
- samples: 12（成功 12 / 失败 0）

## 汇总

| 指标 | 均值 |
|---|---|
| answerRelevancy（答案相关性） | 1.000 |
| claimCoverage（关键断言覆盖度） | 0.653 |
| totalMs（端到端延迟） | 2693 |
| outputTokens | 129.3 |

## 按题型分组

| 题型 | n | answerRelevancy | claimCoverage |
|---|---|---|---|
| factual | 3 | 1.000 | 0.500 |
| reasoning | 3 | 1.000 | 1.000 |
| instruction | 3 | 1.000 | 0.111 |
| format | 3 | 1.000 | 1.000 |

## 明细

| id | 题型 | answerRelevancy | claimCoverage | totalMs | tokens | status |
|---|---|---|---|---|---|---|
| fact-01 | factual | 1.00 | 0.50 | 4993 | 74 | ok |
| fact-02 | factual | 1.00 | 0.67 | 7440 | 347 | ok |
| fact-03 | factual | 1.00 | 0.33 | 4315 | 227 | ok |
| reas-01 | reasoning | 1.00 | 1.00 | 4766 | 315 | ok |
| reas-02 | reasoning | 1.00 | 1.00 | 510 | 13 | ok |
| reas-03 | reasoning | 1.00 | 1.00 | 2633 | 170 | ok |
| inst-01 | instruction | 1.00 | 0.00 | 438 | 19 | ok |
| inst-02 | instruction | 1.00 | 0.33 | 1337 | 74 | ok |
| inst-03 | instruction | 1.00 | 0.00 | 635 | 26 | ok |
| fmt-01 | format | 1.00 | 1.00 | 996 | 49 | ok |
| fmt-02 | format | 1.00 | 1.00 | 3730 | 227 | ok |
| fmt-03 | format | 1.00 | 1.00 | 519 | 11 | ok |
