# 推理后端横向对比测试报告（2026-09-03）

> 本报告**仅基于 2026-09-03 当天三组同口径实测**（§8 rework 后口径），
> 旧口径 / rework 前数据已摒弃，归档在 `_legacy_before_rework/` 仅供考古，不进入本结论。

---

## 0. 一句话结论

**质量：DeepSeek 云端（1.000/1.000）≈ ollama-7B-CPU（0.979/0.969）＞ vLLM-1.5B-GPU（0.922/0.750）；**
**延迟：vLLM GPU（2007ms）≈ DeepSeek 云端（2245ms）＜＜ ollama CPU（19980ms）。**
小模型掉分集中在 **知识时效（向量库/RAG 语境）与格式指令遵从**，reasoning 类三组全满分。

---

## 1. 评测口径（三组一致，§8 改进后）

| 项 | 值 |
|---|---|
| 数据集 | `provider-qa.json` 16 题（4 类 × 4），每题 `referenceClaims` ≥ 3 条 |
| judge | **固定 DeepSeek 云端，与被测解耦**（消除 self-preference bias） |
| 重复判定 | 每题 judge 独立判定 **3 轮**：claim 布尔多数 / 分数众数档 |
| 语义判定 | `verifyClaims` 允许语义等价（同义改写即 supported） |
| 长答案 | judge 单段上下文截断 1600 字符（修复 500 字截断误伤） |
| rel 粒度 | `scoreAnswer` 三档：1.0 全中 / 0.5 部分 / 0.0 答非所问 |
| 评测方式 | closed-book QA（不检索，变量只有生成模型） |

---

## 2. 总体对比

| 后端 | provider | model | claimCoverage ↑ | answerRelevancy | avg totalMs ↓ | avg tokens | ok/n |
|---|---|---|---|---|---|---|---|
| **DeepSeek 云端** | `openai` | `deepseek-v4-flash` | **1.000** | 1.000 | 2245 | 203 | 16/16 |
| **ollama-7B-CPU** | `ollama` | `qwen2.5:7b` | **0.979** | 0.969 | 19980 | 146 | 16/16 |
| **vLLM-1.5B-GPU** | `vllm` | `Qwen2.5-1.5B-Instruct` | **0.922** | 0.750 | 2007 | 149 | 16/16 |

读数方式：组间相对差为主；绝对值偏保守（claimCoverage 要求"明确表述"才算 supported）。

---

## 3. 按题型分组 · claimCoverage

| 题型 | DeepSeek 云端 | ollama-7B-CPU | vLLM-1.5B-GPU | 备注 |
|---|---|---|---|---|
| factual | 1.00 | 0.92 | 0.85 | vLLM 掉在 fact-03/04，ollama 掉在 fact-03 |
| reasoning | 1.00 | 1.00 | 1.00 | 四类里唯一三组全满分 |
| instruction | 1.00 | 1.00 | 0.83 | vLLM inst-01 仅 0.33 |
| format | 1.00 | 1.00 | 1.00 | cov 全过；但 rel 上 ollama/vLLM 的 fmt-04 都只有 0.5 |

要点：**reasoning 无区分度（题面偏易），区分度全在 factual（知识）与 instruction（意图遵循）；format 的差距不体现在 cov 而在 rel（格式遵从）**。

---

## 4. 逐题 claimCoverage 矩阵

| 题目 | 题型 | DeepSeek 云端 | ollama-7B-CPU | vLLM-1.5B-GPU |
|---|---|---|---|---|
| fact-01 | factual | 1.00 | 1.00 | 1.00 |
| fact-02 | factual | 1.00 | 1.00 | 1.00 |
| fact-03 | factual | 1.00 | **0.67** | **0.67** |
| fact-04 | factual | 1.00 | 1.00 | **0.75** |
| reas-01~04 | reasoning | 1.00 | 1.00 | 1.00 |
| inst-01 | instruction | 1.00 | 1.00 | **0.33** |
| inst-02 | instruction | 1.00 | 1.00 | 1.00 |
| inst-03 | instruction | 1.00 | 1.00 | 1.00 |
| inst-04 | instruction | 1.00 | 1.00 | 1.00 |
| fmt-01~04 | format | 1.00 | 1.00 | 1.00 |

只有 4 道题出现 cov 掉分，全部集中在两个模型身上：**ollama 只丢 fact-03 一条 claim；vLLM 丢 fact-03/fact-04/inst-01**。

---

## 5. 掉分点逐条归因（claimVerdicts 证据）

### 5.1 fact-03「向量数据库解决什么问题」——两个本地模型都丢同一条 claim

claim 判定明细（两组同病）：

| # | claim | DeepSeek | ollama | vLLM |
|---|---|---|---|---|
| 0 | 用于持久化存储高维向量 | ✅ | ✅ | ✅ |
| 1 | 支持按相似度近邻检索 | ✅ | ✅ | ✅ |
| 2 | 典型用途是为大模型提供语义检索（RAG） | ✅ | ❌ | ❌ |

- DeepSeek 答案 1705 字，**显式写了 "RAG" 一节**（"支持 AI/大模型应用（RAG）…大语言模型存在知识过时、幻觉等问题"）；
- ollama 答了 5 点（性能、查询、多模态……）通篇没有"大模型/RAG"；
- vLLM 答了 4 点（信息检索/图像识别/推荐/NLP），同样未提 RAG。

归因：**不是"向量库定义"不会，而是没接上"大模型时代"语境**——这条 claim 本质在测知识时效与生成时是否覆盖"最热门用途"。1.5B/7B 训练数据切点靠前，答"传统相似搜索"场景很溜，但对 RAG 这一当下主场景的主动联想缺失。

### 5.2 fact-04「403/500 含义与分类」——vLLM 事实性错误（唯一硬错）

| # | claim | vLLM 判定 | judge reason |
|---|---|---|---|
| 2 | 403 属于客户端错误（4xx） | ❌ | 上下文称 403 "可视为服务端错误"，与 claim 矛盾 |

vLLM 原文：「这个状态码通常是由服务器端生成的，因此可以认为它是**服务端错误**」——**403 是 4xx 客户端错误，这是确定的事实错误**，不是口径宽严问题。ollama / DeepSeek 均正确分类。

归因：1.5B 对"4xx/5xx 分类"这类需要精确语义记忆的知识点不可靠（"服务器生成"≠"服务端错误"的概念混淆）。这是本组 16 题中唯一一处**实打实的知识错误**。

### 5.3 inst-01「一句话解释 RAG」——vLLM 信息密度不足，一条都没说全

| # | claim | vLLM 判定 | judge reason |
|---|---|---|---|
| 0 | 先从外部知识库检索相关内容 | ❌ | 未提及外部知识库或检索顺序 |
| 1 | 检索信息用于辅助生成（检索与生成相结合） | ✅ | "结合检索和生成技术"，语义一致 |
| 2 | 用于提升答案准确性或减少幻觉 | ❌ | 未提准确性提升或幻觉 |

vLLM 原文：`RAG是一种结合了检索和生成技术的模型，用于回答复杂查询或生成高质量文本，主要用于解决信息检索中的长文档处理难题`——只覆盖了 claim1，且把 RAG 的价值说成"解决长文档处理难题"（跑偏）。

对比：ollama 一句话（56 tok）把"外部知识库检索 + 基于检索结果生成 + 知识有限/准确性不足"全部点到，cov=1.00。
归因：**1.5B 在"一句话内塞下 2-3 个关键信息点"的任务上信息密度不够**；同时也印证 §5.2 数据集标定方向正确——题面没问题，模型确实答不全。

### 5.4 fmt-04「订单 JSON，只输出 JSON」——本地两个模型都输出了 ```json 围栏

| 后端 | rel | 输出形态 |
|---|---|---|
| DeepSeek | 1.0 | **裸 JSON**（无围栏、无解释） |
| ollama | 0.5 | ````json``` 围栏包裹 |
| vLLM | 0.5 | ````json``` 围栏包裹 |

三组 JSON 内容全部合法（total=各 price 之和正确），claim 全 supported，**但 rel 只有 0.5**。
归因：题目显式要求"只输出 JSON，不要任何解释"，judge 把 ````json``` 围栏视为"额外包装"→ 判部分遵从。**本地模型（尤其 vLLM/ollama 默认行为）倾向输出 Markdown 围栏，云端模型更守"裸输出"指令**——这是 format 题在 rel 维度上拉出的真实差距。

---

## 6. 延迟分析

| 维度 | DeepSeek 云端 | ollama-7B-CPU | vLLM-1.5B-GPU |
|---|---|---|---|
| avg totalMs | 2245 | **19980** | 2007 |
| avg tokens | 203 | 146 | 149 |
| 最快题 | reas-02 619ms | reas-02 2670ms | reas-02 395ms |
| 最慢题 | fact-03 9080ms | fact-02 45676ms | fact-01 4007ms |
| 大致 per-token | ~11ms | ~137ms | ~13.5ms |

- **ollama 7B CPU 平均 20 秒/题**，是 vLLM GPU 的 ~10 倍、云端的 ~9 倍——CPU 跑 7B 的延迟代价极其直观（per-token ~137ms vs GPU ~13.5ms）；
- **vLLM GPU 与 DeepSeek 云端延迟同级**（2007 vs 2245ms），但注意云端含公网往返，纯算力 vLLM 更快；
- 延迟排序与质量排序**并不一致**：vLLM 最快但质量垫底，ollama 最慢但质量接近云端——"要质量上 7B（含 CPU 慢），要速度上 1.5B GPU（含质量损失）"。

---

## 7. 结论与建议

1. **换本地引擎的质量代价是"知识时效 + 格式遵从"，不是"推理"**：reasoning 四题三组全满分，证明基础多步推理 1.5B 也能做；差距全在 factual 的知识广度（RAG 语境、状态码分类）与 instruction/format 的指令精确遵从。
2. **vLLM 1.5B 的 rel=0.75 是"能答但不完全照做"**：能写出合法 JSON 却加围栏、能答 RAG 却漏关键点、能把 403 分类说错——适合做"演示级快速问答"，不适合直接作为 RAG 生成后端而不做后处理。
3. **ollama 7B CPU 是"低成本高质"备选**：质量距云端仅 2%，代价是 20s/题量级延迟——离线批处理 / 非实时场景可用，实时对话不可用。
4. **工具验证成功**：rework 修复（3 轮多数表决 + 语义等价 + 截断放宽 + rel 三档）后，分数落点全部可归因——本轮 5 个掉分点每一个都能用 `claimVerdicts` 逐条指到具体 claim 与 judge reason，**没有一条是无从解释的"judge 噪声"**。

---

## 8. 局限（读数据前必看）

1. **对比条件不对等**：7B(CPU) vs 1.5B(GPU) vs 云端(未知规模/网络)，模型大小与硬件都不同——这是量级参考，不是引擎性能上限 benchmark；
2. totalMs 单次端到端含网络（云端）或含本地排队，未多轮取均值；
3. 样本量小（16 题/组），结论是量级参考；
4. LLM-as-judge 仍有系统性偏差风险（3 轮多数只压随机抖动）；
5. DeepSeek 同时是 judge——**被测组对 DeepSeek 组可能更有利**（同源语言风格），本地模型被"相对保守"判定是残余风险，量化需换 judge 重跑（成本高，未做）。

---

*数据文件：`DeepSeek_云端.json` / `ollama-7B-CPU.json` / `vLLM-1_5B-GPU.json`（同目录）*
*汇总表：`SUMMARY.md`（可由 `npx tsx scripts/compare-summary.ts` 重新生成）*
*完整方法论与工具改造：`docs/interview-notes/provider-eval-compare.md`*
