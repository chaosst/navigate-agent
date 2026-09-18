# RAG 评估报告

- 生成时间：2026-09-17T07:18:00.486Z
- 样本数：6（失败 0）
- 检索 top-k：5

## 指标汇总

| 指标 | mean | min | max | 有效样本 |
|---|---|---|---|---|
| hitRate@k（找没找到） | 0.000 | 0.000 | 0.000 | 6 |
| MRR@k（首个相关排名） | 0.000 | 0.000 | 0.000 | 6 |
| nDCG@k（排序质量） | 0.000 | 0.000 | 0.000 | 6 |
| contextPrecision@k（检索精度） | - | - | - | 0 |
| contextRecall（召回） | 0.417 | 0.000 | 1.000 | 6 |
| faithfulness（忠实度） | 0.967 | 0.800 | 1.000 | 6 |
| answerRelevancy（相关性） | 0.083 | 0.000 | 0.500 | 6 |

## 样本明细

### [miss-01] 《里斯本条约》第 3 章主要讲了什么内容？

- 检索命中：0/1
- contextKeys: `4995a1ff-2984-4c68-ad00-3e03fc07d379:3`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=-；contextRecall（召回）=0.500；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据提供的 RAG 检索结果，上下文中未包含《里斯本条约》第 3 章的相关内容。

现有上下文主要涉及以下软件开发主题：
- 异步初始化耗时任务
- 功耗控制
- 版本与维护
- 日志规范
- 开发规范的优秀案例分享

这些内容与《里斯本条约》无关，因此无法基于当前上下文回答《里斯本条约》第 3 章主要讲了什么内容。

### [miss-02] navigate 项目里 Kubernetes Helm chart 的 values.yaml 把副本数配成了多少？

- 检索命中：0/2
- contextKeys: `fb8696b3-ef9d-4f73-aaeb-8a72b1aa15ab:0`, `5392e643-9810-9013-e235-4ac6816894b5:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=-；contextRecall（召回）=0.500；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据提供的 RAG 检索上下文，**没有找到**关于 navigate 项目里 Kubernetes Helm chart 的 `values.yaml` 中副本数配置的信息。

上下文中仅包含 Navigate Agent 的架构 UML 图，涉及配置、入口、Agent 引擎、工具层、MCP 等模块，并未提及 Helm chart、`values.yaml` 或副本数（replicaCount）相关内容。因此无法从现有上下文中得出答案。

### [miss-03] OHOS 开发指南里规定的最低 API 版本号是多少？

- 检索命中：0/1
- contextKeys: `4995a1ff-2984-4c68-ad00-3e03fc07d379:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=-；contextRecall（召回）=0.500；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据提供的 OHOS 开发指南上下文，**未包含关于最低 API 版本号的规定或说明**。

当前上下文主要涉及代码与设计规范、类型声明强制化、目录结构与命名等内容，并未提及 API 版本号相关要求。因此，无法从给定信息中确定 OHOS 开发指南规定的最低 API 版本号。

### [miss-04] 燕云十六声里重剑普攻造成的击退距离具体是多少数值？

- 检索命中：0/2
- contextKeys: `f3544e4a-a562-45b3-bbec-0d432c3a45b3:0`, `f3544e4a-a562-45b3-bbec-0d432c3a45b3:1`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=-；contextRecall（召回）=1.000；faithfulness（忠实度）=0.800；answerRelevancy（相关性）=0.500

- 答案：根据提供的上下文，**无法确定“重剑普攻造成的击退距离”具体是多少数值**。

上下文只提到：

- 重剑普攻**不是完全没有击退**，怪物受击时会有“伴随着动作位置轻微击退”。
- 但该效果存在触发判断问题：**只要敌人在出招，受击硬直和击退效果就会消失**，导致攻击反馈断断续续。

因此，资料中没有给出具体的击退距离数值。

### [miss-05] navigate 在 2026 年 12 月发布的下一个版本里新增了哪些功能？

- 检索命中：0/1
- contextKeys: `f037973e-08db-4223-9e5e-6479b6cd315d:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=-；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据当前提供的 RAG 检索上下文，**无法回答该问题**。

现有上下文仅包含一份关于 **“Wiki 知识库迁移：自建系统 → Wiki.js”** 的设计稿，其中：

- 日期为 **2026-07-11**
- 状态为 **设计稿（待审批）**
- 版本为 **1.0**
- 内容主要对比自建 Wiki 与 Wiki.js 的差异，并涉及迁移架构

上下文中**没有提及**：

- `navigate` 这一产品或项目
- `navigate` 在 **2026 年 12 月**发布的版本
- 该版本新增的任何功能

因此，依据现有上下文无法生成关于“navigate 在 2026 年...

### [miss-06] 我上一次会话里让你改的那个文件名是什么？

- 检索命中：0/2
- contextKeys: `8ebcfb03-b533-4ed5-8f87-2389e934ba39:1`, `8ebcfb03-b533-4ed5-8f87-2389e934ba39:0`
- 指标：hitRate@k（找没找到）=0.000；MRR@k（首个相关排名）=0.000；nDCG@k（排序质量）=0.000；contextPrecision@k（检索精度）=-；contextRecall（召回）=0.000；faithfulness（忠实度）=1.000；answerRelevancy（相关性）=0.000

- 答案：根据提供的 RAG 检索结果，**没有找到关于“上一次会话中让你改的文件名”的任何信息**。

现有上下文只包含 Memory + RAG 的设计文档，涉及以下内容：

- Memory 层：基于 `better-sqlite3` + LangChain，支持会话持久化与向量记忆检索
- RAG 引擎：基于 LangChain 文档加载器 + 向量检索
- 技术栈、架构、API 端点、存储结构等

其中没有提及用户曾要求修改某个具体文件名的记录。因此，无法依据当前上下文确定你所说的那个文件名。
