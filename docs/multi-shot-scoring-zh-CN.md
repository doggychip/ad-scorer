# 多shot评分 (Multi-shot Self-Consistency Scoring)

> 给非工程同事看的功能说明。技术细节看 `docs/superpowers/specs/2026-05-02-multi-shot-scoring-design.md`。

## 一句话

每张图现在默认评3次取中位数，分数旁边会显示稳定性标签 (`稳定` / `⚠️ 不稳定` / `单次`)，让你一眼看出哪些分数可信、哪些是noise。

---

## 为什么要改

之前每张图只评1次。同一张图、同一个模型，跑两次能差 ±2 到 ±4 分。

举个真实案例 (5月1日测试)：
- `9.png` 第一次跑：**32/40 winner**
- 同张图第二次跑：**28/40 candidate**

差4分，verdict从winner跳到candidate。这意味着：
- 边界图（27-29分那些）的winner/candidate判定**不可信**
- 把noise当信号反馈给生成pipeline → 错误的keyword feedback → 风格漂移
- 决策无法复现

整个项目的核心是"用rubric给生成pipeline反馈"。如果rubric本身±10%的噪声，反馈循环就是失效的。

---

## 现在的默认行为

```bash
npm run score ./creatives/2026-05-03/
```

每张图调用Claude vision **3次**（并行），3次结果取中位数显示。成本是之前的3倍，但你拿到的是真实可信的分数。

**输出长这样**：
```
→ 1.png [alphawalk] runs=3 ... 26±0.8/40 [candidate, stable]   (batch ab12cd, 3 runs)
→ 2.png [alphawalk] runs=3 ... 30±2.5/40 [winner, ⚠️unstable]  (batch ef34gh, 3 runs)
→ 3.png [alphawalk] runs=3 ... 19±0.0/40 [reject, stable]      (batch 88bb68, 3 runs)
```

每行从左到右：
- `26±0.8/40` — 中位数分数 ± 标准差 / 40满分
- `[candidate, stable]` — verdict + 稳定性
- `(batch ab12cd, 3 runs)` — 这次batch的ID + 几次runs成功

---

## 如何读稳定性标签

| 标签 | 含义 | 应该怎么看 |
|---|---|---|
| `稳定` | std ≤ 2.0 | 分数可信，按normal决策 |
| `⚠️ 不稳定` | std > 2.0 | rubric对这张图判定不一致，**不要单独信任**；要么再跑 `--runs 5` 多采样，要么把它当borderline（不是winner也不是reject） |
| `单次` (灰色) | 只评了1次 (legacy data 或 `--runs 1`) | 没有可信度数据，跟改feature前一样 |

举例：
- `30±0.5/40 [winner, stable]` → 真winner，可以投
- `30±2.8/40 [winner, ⚠️不稳定]` → 假winner，3次runs可能是 `32, 30, 28`，rubric举棋不定，别All-in
- `19±0.0/40 [reject, stable]` → 真reject，3次runs都给19，rubric笃定

---

## 三种N值什么时候用

| 场景 | 命令 | 成本 | 用途 |
|---|---|---|---|
| 日常scoring | `npm run score ./creatives/today/` | 1× × 3 = 3× | 默认N=3，平衡成本和可信度 |
| 早期iterate / 大批量过筛 | `npm run score ... -- --runs 1` | 1× | 1次cheap probe，scrore前先看哪些值得3次评 |
| Campaign投放前最终review | `npm run score ./creatives/finalist.png -- --runs 5 --force` | 5× | 高stakes，用更高resolution的std信号 |

`--force` 让已评过的图重新评（默认会skip）。

---

## Report里看什么

```bash
npm run report -- --filter-path=$(date +%Y-%m-%d)
open ./reports/report-$(date +%Y-%m-%d).html
```

Report是中文HTML（同事直接open浏览器看就行）。每张广告一张卡，关键变化：

1. **顶部summary stats** 多了一格"不稳定 N" — 一眼看出今天有几张rubric判定不稳的
2. **每张卡的总分** 从 `25/40 · 候选` 变成 `25.0±0.8/40 · 候选` + `稳定` 绿色badge
3. **Card不变的地方**：8个维度的score bar、winning hypothesis、failure modes、强化/移除的keywords都跟以前一样

每天的优先级看法：
1. 先扫summary里的"不稳定 N" — 这些图先放一边，决策不能基于不稳定batch
2. 看winners里有没有 `⚠️不稳定` — 这些是"假winner"，可能是noise顶上去的
3. 真winner（标 `稳定` 的）才是可投信号

---

## PDF分享

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="./reports/report-$(date +%Y-%m-%d)-zh-CN.pdf" \
  "file://$HOME/projects/ad-scorer/reports/report-$(date +%Y-%m-%d).html"
```

生成的PDF可以直飞团队群。

---

## 已知小坑

- **`npm run keywords` 计数偏高 3×**：因为3次runs每次都会加一遍keyword出现次数。相对排序仍然对，但绝对数字别跟旧数据直接比。
- **2 runs vs 3 runs 视觉一样**：偶尔某次API调用失败，batch会保存成 `2 runs`（CLI输出会标"2 runs"）。Report里这种batch的±std跟3-runs的badge长一样，分辨不出。如果想确定可信度，看CLI输出或DB。
- **凭经验定的阈值 2.0**：`std > 2.0` 才标不稳定。这个阈值跑一段时间后可能要调，目前是基于 5月1日21张IB广告的σ分布拍的。

---

## 想问问题？

实现细节：`docs/superpowers/specs/2026-05-02-multi-shot-scoring-design.md`
执行计划：`docs/superpowers/plans/2026-05-02-multi-shot-scoring.md`
项目conventions：`CLAUDE.md`
