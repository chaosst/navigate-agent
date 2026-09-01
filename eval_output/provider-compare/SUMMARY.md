# 三后端生成质量 × 延迟对比（eval 工具实测）

- 汇总时间：2026-09-01T07:07:09.733Z
- 数据来源：`D:\develop\navigate\eval_output\provider-compare/*.json`（由 `scripts/compare-providers.ts` 产出）
- 评测方式：closed-book QA（不检索，变量只有生成模型），judge 固定为 DeepSeek

## 1. 总体对比

| 后端 | provider | model | claimCoverage ↑ | answerRelevancy | avg totalMs ↓ | avg tokens | ok/n |
|---|---|---|---|---|---|---|---|
| DeepSeek | `openai` | `deepseek-v4-flash` | **0.778** | 1.000 | 2371 | 173 | 12/12 |
| vLLM-1.5B-GPU | `vllm` | `Qwen2.5-1.5B-Instruct` | **0.653** | 1.000 | 2693 | 129 | 12/12 |
| ollama-7B-CPU | `ollama` | `qwen2.5:7b` | **0.597** | 1.000 | 19181 | 129 | 12/12 |

## 2. 按题型分组 · claimCoverage

| 题型 | DeepSeek | vLLM-1.5B-GPU | ollama-7B-CPU |
|---|---|---|---|
| factual | 0.61 | 0.50 | 0.61 |
| reasoning | 0.67 | 1.00 | 0.67 |
| instruction | 0.83 | 0.11 | 0.11 |
| format | 1.00 | 1.00 | 1.00 |

## 3. 逐题 claimCoverage 矩阵

| 题目 | 题型 | DeepSeek | vLLM-1.5B-GPU | ollama-7B-CPU |
|---|---|---|---|---|
| fact-01 | factual | 0.50 | 0.50 | 0.50 |
| fact-02 | factual | 1.00 | 0.67 | 1.00 |
| fact-03 | factual | 0.33 | 0.33 | 0.33 |
| reas-01 | reasoning | 1.00 | 1.00 | 1.00 |
| reas-02 | reasoning | 0.00 | 1.00 | 0.00 |
| reas-03 | reasoning | 1.00 | 1.00 | 1.00 |
| inst-01 | instruction | 0.50 | 0.00 | 0.00 |
| inst-02 | instruction | 1.00 | 0.33 | 0.33 |
| inst-03 | instruction | 1.00 | 0.00 | 0.00 |
| fmt-01 | format | 1.00 | 1.00 | 1.00 |
| fmt-02 | format | 1.00 | 1.00 | 1.00 |
| fmt-03 | format | 1.00 | 1.00 | 1.00 |

## 4. 逐题 totalMs 矩阵

| 题目 | DeepSeek | vLLM-1.5B-GPU | ollama-7B-CPU |
|---|---|---|---|
| fact-01 | 4038 | 4993 | 23455 |
| fact-02 | 2490 | 7440 | 49493 |
| fact-03 | 7753 | 4315 | 44747 |
| reas-01 | 2443 | 4766 | 35037 |
| reas-02 | 1097 | 510 | 2825 |
| reas-03 | 1641 | 2633 | 26144 |
| inst-01 | 839 | 438 | 4707 |
| inst-02 | 1587 | 1337 | 8421 |
| inst-03 | 1733 | 635 | 2861 |
| fmt-01 | 1361 | 996 | 7634 |
| fmt-02 | 2622 | 3730 | 22294 |
| fmt-03 | 853 | 519 | 2557 |

## 5. 口径与局限（读数据前必看）

1. **judge 固定为 DeepSeek**，与被测解耦，组间分数可比。若沿用 `eval rag` 的默认行为
   （judge 与被测共用同一实例），会产生 self-preference bias，分数不可比。
2. **claimCoverage 绝对值偏保守**：`LlmJudge.verifyClaims` 的 system prompt 要求
   「上下文没提到的一律 false」，对同义表述容忍度低（例如答案 `[1, 2, 5, 9]` 正确
   却可能被判 unsupported）。因此**绝对值不可直接当准确率引用，组间相对差才有意义**。
3. **answerRelevancy 出现天花板效应**：本批题目偏简单，三组的 rel 均为 1.000，
   该指标在此数据集上无分辨力，结论以 claimCoverage 为准。
4. **对比条件不对等**：7B（CPU）vs 1.5B（GPU）vs 云端未知规模，模型大小、硬件、
   网络路径均不同。这是**量级参考**，不是引擎性能上限的 benchmark。
5. **totalMs 为单次端到端含网络往返**，未做多轮取均值，抖动较大（尤其云端）。

### judge 自身缺陷的实证（为什么只能看相对差）

| 现象 | 证据 | 影响 |
|---|---|---|
| **同一答案，judge 给分不一致** | `reas-02` 三后端答案**完全相同** `[1, 2, 5, 9]`，
  覆盖度却是 DeepSeek `0.00` / vLLM `1.00` / ollama `0.00` | LLM-as-judge 固有抖动。
  该题只有 1 条 claim（非 0 即 1），单次抖动被放大到整题粒度 |
| **同义表述被判 unsupported** | `inst-03` ollama 答「此方案可能不尽如人意，建议再行斟酌」，
  语义已覆盖「方案不可行、需重新考虑」，仍判 0.00 | `verifyClaims` 的 prompt 要求
  「上下文没提到的一律 false」，对复述/改写容忍度低，绝对值系统性偏低 |
| **小模型语言跑偏判 0 是合理的** | `inst-03` vLLM 1.5B 用**英文**回答中文问题 | 
  这类 0 分是真实质量差异，不是 judge 误判 |

**结论**：claimCoverage 的**绝对值不可当准确率引用**，只能在同一数据集、同一 judge 下看
**组间相对差**。要拿可信绝对值需要：① claim 数 ≥ 3 摊薄单条抖动；② 每题重复判定 3 次取众数；
③ 放宽 `verifyClaims` 的 prompt，允许语义等价。
