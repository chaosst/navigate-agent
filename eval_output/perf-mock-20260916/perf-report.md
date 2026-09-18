# Agent 性能测试报告（MOCK 模式 · 纯项目开销）

- 语料规模: 52 条 · 并发: 1 · 生成时间: 2026-09-17T06:33:57.585Z

## 判定线：overheadPct > 30% 或 overheadMs > 2s 记为项目瓶颈

| 类别 | n | totalMs p50/p90 | overheadMs p50/p90 | overheadPct p50 | llmMs avg |
|---|---|---|---|---|---|
| factual | 8 | 55 / 59 | 45 / 50 | 99% | 0 |
| reasoning | 8 | 28 / 30 | 21 / 22 | 99% | 0 |
| instruction | 8 | 23 / 36 | 23 / 28 | 99% | 0 |
| format | 8 | 22 / 23 | 22 / 23 | 99% | 0 |
| tool-read | 5 | 19 / 22 | 19 / 22 | 99% | 0 |
| tool-shell | 5 | 20 / 22 | 20 / 22 | 99% | 0 |
| rag | 5 | 19 / 22 | 19 / 22 | 99% | 0 |
| multi-step | 5 | 19 / 22 | 19 / 22 | 99% | 0 |
| **all** | 52 | 22 / 36 | 21 / 29 | 99% | 0 |

## 最慢工具 topN（本地执行耗时）

| 工具 | 调用次数 | 累计耗时 ms |
|---|---|---|
| list_files | 10 | 93 |

## 最慢任务 topN

| id | category | totalMs | overheadMs | overheadPct | iters | in/out tokens | error |
|---|---|---|---|---|---|---|---|
| fact-01 | factual | 95 | 82.34749999999985 | 87% | 3 | 0/0 |  |
| fact-02 | factual | 59 | 50.01469999999972 | 85% | 3 | 0/0 |  |
| fact-04 | factual | 57 | 45.31340000000091 | 79% | 3 | 0/0 |  |
| fact-03 | factual | 55 | 45.552599999999984 | 83% | 3 | 0/0 |  |
| inst-03 | instruction | 42 | 41.822299999999814 | 100% | 3 | 0/0 |  |
| inst-02 | instruction | 36 | 24.47669999999971 | 68% | 3 | 0/0 |  |
| inst-01 | instruction | 35 | 27.663700000000517 | 79% | 3 | 0/0 |  |
| reas-01 | reasoning | 30 | 21.749900000000707 | 72% | 3 | 0/0 |  |

## ⚠️ 项目瓶颈清单

- `fact-01` (factual): overheadMs=82.34749999999985 (87%), graphMs=86.1273000000001, parseMs=0.002599999999802094, routeMs=73.47479999999996, outsideMs=8.870100000000093
- `fact-02` (factual): overheadMs=50.01469999999972 (85%), graphMs=38.1592999999998, parseMs=0.0032999999998537533, routeMs=29.173999999999523, outsideMs=20.837400000000343
- `fact-03` (factual): overheadMs=45.552599999999984 (83%), graphMs=34.29659999999967, parseMs=0.0032999999998537533, routeMs=24.849199999999655, outsideMs=20.700100000000475
- `fact-04` (factual): overheadMs=45.31340000000091 (79%), graphMs=57.201500000000124, parseMs=0.001299999999901047, routeMs=45.514900000001035, outsideMs=0
- `reas-01` (reasoning): overheadMs=21.749900000000707 (72%), graphMs=31.91080000000011, parseMs=0.0012000000001535227, routeMs=23.660700000000816, outsideMs=0
- `reas-02` (reasoning): overheadMs=20.713700000000244 (69%), graphMs=30.06179999999995, parseMs=0.001299999999901047, routeMs=20.775500000000193, outsideMs=0
- `reas-03` (reasoning): overheadMs=20.499800000000505 (68%), graphMs=31.48109999999997, parseMs=0.0012000000001535227, routeMs=21.980900000000474, outsideMs=0
- `reas-04` (reasoning): overheadMs=19.958900000000995 (71%), graphMs=29.822900000000118, parseMs=0.0014000000001033186, routeMs=21.781800000001112, outsideMs=0
- `inst-01` (instruction): overheadMs=27.663700000000517 (79%), graphMs=36.6592999999998, parseMs=0.0016999999998006388, routeMs=29.32300000000032, outsideMs=0
- `inst-02` (instruction): overheadMs=24.47669999999971 (68%), graphMs=36.43010000000004, parseMs=0.0009000000000014552, routeMs=24.90679999999975, outsideMs=0
- `inst-03` (instruction): overheadMs=41.822299999999814 (100%), graphMs=42.83060000000023, parseMs=0.0007999999997991836, routeMs=42.652900000000045, outsideMs=0
- `inst-04` (instruction): overheadMs=22.8417000000004 (99%), graphMs=23.73160000000007, parseMs=0.0008000000002539309, routeMs=23.573300000000472, outsideMs=0
- `fmt-01` (format): overheadMs=22.78520000000026 (99%), graphMs=23.79430000000002, parseMs=0.0009999999997489795, routeMs=23.57950000000028, outsideMs=0
- `fmt-02` (format): overheadMs=20.83690000000024 (99%), graphMs=21.424400000000333, parseMs=0.0010000000002037268, routeMs=21.261300000000574, outsideMs=0
- `fmt-03` (format): overheadMs=21.820700000000215 (99%), graphMs=22.674399999999878, parseMs=0.0007999999997991836, routeMs=22.495100000000093, outsideMs=0
- `fmt-04` (format): overheadMs=28.797700000000077 (99%), graphMs=29.697599999999966, parseMs=0.0009000000000014552, routeMs=29.495300000000043, outsideMs=0
- `fact-05` (factual): overheadMs=22.838700000000244 (99%), graphMs=23.426400000000285, parseMs=0.0007999999997991836, routeMs=23.26510000000053, outsideMs=0
- `fact-06` (factual): overheadMs=21.82220000000052 (99%), graphMs=22.59180000000015, parseMs=0.0009000000000014552, routeMs=22.41400000000067, outsideMs=0
- `fact-07` (factual): overheadMs=24.829899999999725 (99%), graphMs=25.9384, parseMs=0.0009000000000014552, routeMs=25.768299999999726, outsideMs=0
- `fact-08` (factual): overheadMs=25.769400000000132 (99%), graphMs=26.673099999999977, parseMs=0.0009000000000014552, routeMs=26.44250000000011, outsideMs=0
- `reas-05` (reasoning): overheadMs=24.830200000000332 (99%), graphMs=25.6242000000002, parseMs=0.0011000000004059984, routeMs=25.454400000000533, outsideMs=0
- `reas-06` (reasoning): overheadMs=19.83719999999903 (99%), graphMs=21.00590000000011, parseMs=0.0007000000005064066, routeMs=20.84309999999914, outsideMs=0
- `reas-07` (reasoning): overheadMs=19.852399999998852 (99%), graphMs=19.944000000000415, parseMs=0.0010000000002037268, routeMs=19.796399999999267, outsideMs=0.054999999999381544
- `reas-08` (reasoning): overheadMs=20.84230000000025 (99%), graphMs=21.40400000000045, parseMs=0.001299999999901047, routeMs=21.2463000000007, outsideMs=0
- `inst-05` (instruction): overheadMs=20.832099999998718 (99%), graphMs=21.652100000000246, parseMs=0.0008000000007086783, routeMs=21.484199999998964, outsideMs=0
- `inst-06` (instruction): overheadMs=21.821500000000015 (99%), graphMs=21.970800000000054, parseMs=0.0010000000002037268, routeMs=21.79230000000007, outsideMs=0.02819999999974243
- `inst-07` (instruction): overheadMs=22.835699999999633 (99%), graphMs=23.51850000000013, parseMs=0.0010000000002037268, routeMs=23.354199999999764, outsideMs=0
- `inst-08` (instruction): overheadMs=18.829499999999825 (99%), graphMs=19.4378999999999, parseMs=0.0011000000004059984, routeMs=19.267399999999725, outsideMs=0
- `fmt-05` (format): overheadMs=18.8100000000004 (99%), graphMs=19.443099999999504, parseMs=0.0009000000000014552, routeMs=19.253099999999904, outsideMs=0
- `fmt-06` (format): overheadMs=19.82339999999931 (99%), graphMs=19.716600000000653, parseMs=0.0010999999994965037, routeMs=19.539999999999964, outsideMs=0.2822999999998501
- `fmt-07` (format): overheadMs=21.82719999999881 (99%), graphMs=22.474099999999453, parseMs=0.0009000000000014552, routeMs=22.301299999998264, outsideMs=0
- `fmt-08` (format): overheadMs=19.847600000000057 (99%), graphMs=20.82720000000063, parseMs=0.0007999999997991836, routeMs=20.674800000000687, outsideMs=0
- `agt-01` (tool-read): overheadMs=18.85620000000017 (99%), graphMs=19.681499999999687, parseMs=0.0011999999996987754, routeMs=19.53769999999986, outsideMs=0
- `agt-02` (tool-read): overheadMs=21.832499999998618 (99%), graphMs=22.048099999999977, parseMs=0.0009000000000014552, routeMs=21.880599999998594, outsideMs=0
- `agt-03` (tool-read): overheadMs=18.821900000000824 (99%), graphMs=19.754399999999805, parseMs=0.0008000000007086783, routeMs=19.57630000000063, outsideMs=0
- `agt-04` (tool-shell): overheadMs=21.815099999998893 (99%), graphMs=22.759799999999814, parseMs=0.0010000000002037268, routeMs=22.574899999998706, outsideMs=0
- `agt-05` (tool-shell): overheadMs=19.842000000000553 (99%), graphMs=20.73610000000008, parseMs=0.0010000000002037268, routeMs=20.57810000000063, outsideMs=0
- `agt-06` (rag): overheadMs=21.823099999999613 (99%), graphMs=22.555699999999888, parseMs=0.0010999999994965037, routeMs=22.3787999999995, outsideMs=0
- `agt-07` (multi-step): overheadMs=20.827299999999923 (99%), graphMs=20.844700000000557, parseMs=0.0008000000007086783, routeMs=20.67200000000048, outsideMs=0.15449999999873398
- `agt-08` (multi-step): overheadMs=18.84140000000116 (99%), graphMs=19.68579999999929, parseMs=0.0007999999997991836, routeMs=19.527200000000448, outsideMs=0
- `agt-09` (tool-read): overheadMs=19.846200000001772 (99%), graphMs=19.503200000000106, parseMs=0.0007999999997991836, routeMs=19.34940000000188, outsideMs=0.4960000000000946
- `agt-10` (tool-read): overheadMs=18.83179999999993 (99%), graphMs=19.738600000000588, parseMs=0.0009000000000014552, routeMs=19.570400000000518, outsideMs=0
- `agt-11` (tool-shell): overheadMs=19.807400000000598 (99%), graphMs=20.985999999999876, parseMs=0.0007999999997991836, routeMs=20.793400000000474, outsideMs=0
- `agt-12` (tool-shell): overheadMs=18.829799999999523 (99%), graphMs=20.894100000000435, parseMs=0.0007999999997991836, routeMs=20.723899999999958, outsideMs=0
- `agt-13` (tool-shell): overheadMs=21.836600000000544 (99%), graphMs=21.76760000000013, parseMs=0.0008000000007086783, routeMs=21.604200000000674, outsideMs=0.2315999999991618
- `agt-14` (rag): overheadMs=19.788700000000063 (99%), graphMs=20.776200000000244, parseMs=0.0008000000007086783, routeMs=20.564900000000307, outsideMs=0
- `agt-15` (rag): overheadMs=18.84179999999924 (99%), graphMs=19.417099999999664, parseMs=0.0009000000000014552, routeMs=19.258899999998903, outsideMs=0
- `agt-16` (rag): overheadMs=18.834200000000237 (99%), graphMs=19.618000000000393, parseMs=0.0009000000000014552, routeMs=19.45220000000063, outsideMs=0
- `agt-17` (rag): overheadMs=18.844599999999446 (99%), graphMs=19.523300000000745, parseMs=0.0009000000000014552, routeMs=19.36790000000019, outsideMs=0
- `agt-18` (multi-step): overheadMs=18.82470000000012 (99%), graphMs=19.379399999999805, parseMs=0.0015000000003055902, routeMs=19.204099999999926, outsideMs=0
- `agt-19` (multi-step): overheadMs=21.826500000000124 (99%), graphMs=21.71230000000014, parseMs=0.0010000000002037268, routeMs=21.538800000000265, outsideMs=0.2866999999996551
- `agt-20` (multi-step): overheadMs=18.842499999999745 (99%), graphMs=19.783699999999953, parseMs=0.0007999999997991836, routeMs=19.6261999999997, outsideMs=0
