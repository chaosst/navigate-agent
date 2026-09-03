# 推理后端生成质量 × 延迟对比（eval 工具实测）

- 汇总时间：2026-09-03T04:49:41.529Z
- 数据来源：`eval_output/provider-compare/*.json`（由 `scripts/compare-providers.ts` 产出）
- 评测方式：closed-book QA（不检索，变量只有生成模型），judge 固定为 DeepSeek

### judge 判定口径（§8 改进后，各组一致）

| 项 | 做法 |
|---|---|
| claim 数 | 每题 ≥ 3 条（数据集已加厚），摊薄单条判定抖动 |
| 重复判定 | 每题 judge 独立判定 3 轮，claim 取布尔多数、分数取众数档 |
| 同义判定 | `verifyClaims` prompt 允许语义等价，杜绝「同义改写即判 0」 |
| 长答案 | judge 单段上下文截断放宽至 1600 字符，避免证据被切 |
| rel 粒度 | `scoreAnswer` 三档化：1.0 全中 / 0.5 部分回答 / 0.0 答非所问 |

## 1. 总体对比

| 后端 | provider | model | claimCoverage ↑ | answerRelevancy | avg totalMs ↓ | avg tokens | ok/n | judge rounds |
|---|---|---|---|---|---|---|---|---|---|
| DeepSeek 云端 | `openai` | `deepseek-v4-flash` | **1.000** | 1.000 | 2245 | 203 | 16/16 | 3 |
| ollama-7B-CPU | `ollama` | `qwen2.5:7b` | **0.979** | 0.969 | 19980 | 146 | 16/16 | 3 |
| vLLM-1.5B-GPU | `vllm` | `Qwen2.5-1.5B-Instruct` | **0.922** | 0.750 | 2007 | 149 | 16/16 | 3 |

## 2. 按题型分组 · claimCoverage

| 题型 | DeepSeek 云端 | ollama-7B-CPU | vLLM-1.5B-GPU |
|---|---|---|---|
| factual | 1.00 | 0.92 | 0.85 |
| reasoning | 1.00 | 1.00 | 1.00 |
| instruction | 1.00 | 1.00 | 0.83 |
| format | 1.00 | 1.00 | 1.00 |

## 3. 逐题 claimCoverage 矩阵

| 题目 | 题型 | DeepSeek 云端 | ollama-7B-CPU | vLLM-1.5B-GPU |
|---|---|---|---|---|
| fact-01 | factual | 1.00 | 1.00 | 1.00 |
| fact-02 | factual | 1.00 | 1.00 | 1.00 |
| fact-03 | factual | 1.00 | 0.67 | 0.67 |
| fact-04 | factual | 1.00 | 1.00 | 0.75 |
| reas-01 | reasoning | 1.00 | 1.00 | 1.00 |
| reas-02 | reasoning | 1.00 | 1.00 | 1.00 |
| reas-03 | reasoning | 1.00 | 1.00 | 1.00 |
| reas-04 | reasoning | 1.00 | 1.00 | 1.00 |
| inst-01 | instruction | 1.00 | 1.00 | 0.33 |
| inst-02 | instruction | 1.00 | 1.00 | 1.00 |
| inst-03 | instruction | 1.00 | 1.00 | 1.00 |
| inst-04 | instruction | 1.00 | 1.00 | 1.00 |
| fmt-01 | format | 1.00 | 1.00 | 1.00 |
| fmt-02 | format | 1.00 | 1.00 | 1.00 |
| fmt-03 | format | 1.00 | 1.00 | 1.00 |
| fmt-04 | format | 1.00 | 1.00 | 1.00 |

## 4. 逐题 totalMs 矩阵

| 题目 | DeepSeek 云端 | ollama-7B-CPU | vLLM-1.5B-GPU |
|---|---|---|---|
| fact-01 | 3447 | 31994 | 4007 |
| fact-02 | 2296 | 45676 | 3805 |
| fact-03 | 9080 | 41598 | 2590 |
| fact-04 | 2113 | 36740 | 3820 |
| reas-01 | 2060 | 32863 | 3658 |
| reas-02 | 619 | 2670 | 395 |
| reas-03 | 1029 | 24387 | 2130 |
| reas-04 | 1632 | 41336 | 3067 |
| inst-01 | 1142 | 7713 | 648 |
| inst-02 | 1577 | 7922 | 1161 |
| inst-03 | 2185 | 2650 | 497 |
| inst-04 | 1525 | 5475 | 1211 |
| fmt-01 | 1308 | 6572 | 776 |
| fmt-02 | 3176 | 18363 | 2653 |
| fmt-03 | 1420 | 2461 | 453 |
| fmt-04 | 1319 | 11261 | 1240 |

## 5. 口径与局限（读数据前必看）

1. **judge 固定为 DeepSeek，与被测解耦**，组间分数可比。`eval rag` 子命令现支持
   `JUDGE_BASE_URL` / `JUDGE_MODEL` / `JUDGE_API_KEY` 显式拆分独立 judge（未配置时仍共用）。
2. **claimCoverage 语义**：模型答案需**明确表述**出断言才算 supported（判定允许同义改写，
   但不会替模型脑补它没说的内容）。所以它是「答案内容覆盖度」而非「正确答案率」——
   答案正确但没展开的部分仍会计 0，绝对值仍偏保守，**组间相对差是主要读数**。
3. **answerRelevancy 三档化（1.0/0.5/0.0）**：云端大模型通常答满拿 1.0（天花板属正常）；
   0.5/0.0 的区分度主要落在本地小模型上（陷阱题：多子问 fact-04、双段计算 reas-04、
   双句约束 inst-04、schema+计算 fmt-04）。
4. **对比条件不对等**：7B（CPU）vs 1.5B（GPU）vs 云端未知规模，模型大小、硬件、
   网络路径均不同。这是**量级参考**，不是引擎性能上限的 benchmark。
5. **totalMs 为单次端到端含网络往返**，未做多轮取均值，抖动较大（尤其云端）。
6. **样本量小**：16 题（4 类 × 4 题），结论是量级参考，不是统计显著性结论。

### 已修复的历史缺陷（2026-09 rework，见 provider-eval-compare.md §8）

| 缺陷 | 旧现象 | 修复 |
|---|---|---|
| 单条 claim 抖动 | `reas-02` 同答案 `[1,2,5,9]` 三后端判定 0.00/1.00/0.00 | claim 加厚至 ≥3 + 每题 3 轮多数表决 |
| 同义改写判 0 | `inst-03` ollama 答「此方案可能不尽如人意」语义已覆盖仍判 0.00 | prompt 明确允许语义等价 |
| 长答案证据被切 | `fact-03` 答案 1790 字、RAG 证据在第 950 字后，500 字截断导致误判 0 | 单段截断放宽到 1600 字符 |
| rel 天花板 | 题目过简，三组 rel 恒 1.000 无区分度 | 数据集加入 4 道多约束陷阱题 + score 三档化 |
| 数据集与题目不匹配 | `inst-01/02/03` 掉分实为 claim 过度指定（细节断言/固定三件套/语义强度放大），非模型缺陷 | 回放标定（replay calibration）逐条修正 claim，合理答案 1.00、负面样本 0.00 |
| judge 与被测共用 | `eval rag` 内 judge 与被测同实例（self-preference bias） | `RagEvalOptions.judge` 支持注入独立 judge |

**残余局限**：LLM-as-judge 仍有系统性偏差风险（多数表决只压随机抖动，压不掉 judge 自身的
风格倾向），claimCoverage 绝对值仍偏保守 —— 因此本报告结论以**组间相对差**为准。
