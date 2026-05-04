# Ad Scorer 5月更新说明

> 给同事的changelog。所有更新已push到`main`分支，clone/pull即可使用。

## TL;DR

整个系统从"评分工具"升级成**完整闭环**：

```
brand-dna.json → prompt-engineer → 生成图 → Claude评分 → feedback反馈 → 下一批prompt-engineer
```

每一环都做了升级。新增 4 个CLI命令，自动化了之前所有手工环节。

---

## 主要新功能

### 1. 多次评分取中位数（解决rubric噪声）

**之前**：每张图评1次。同图重跑分数差±2-4分（有真实案例：`9.png` 32 → 28）。Winner/candidate边界判定不可信。

**现在**：默认每张图评 **3 次**，取中位数 + 标注稳定性。

```bash
npm run score ./creatives/2026-05-04/             # 默认N=3
npm run score ./folder/ -- --runs 1               # 省钱probe模式
npm run score ./final.png -- --runs 5 --force    # high-stakes review
```

输出长这样：
```
→ 1.png runs=3 ... 26±0.8/40 [candidate, stable] (batch ab12cd, 3 runs)
→ 9.png runs=3 ... 30±2.5/40 [winner, ⚠️unstable] (batch ef34gh, 3 runs)
```

`±X.X` = std deviation。`⚠️不稳定`（std > 2.0）说明rubric对这张图判定不一致，**不要单独信**。

---

### 2. 入口gate（防"竞品图被错评"）

**之前**：拖一folder Robinhood截图进 `creatives/`，全部21张被Sonnet评分一遍才flag为IP risk。浪费API预算 + 需要手动清理DB。这个月发生过2次。

**现在**：score前先用便宜的Haiku扫一遍每张图（每张约$0.0025），认出主广告主品牌。如果跟期望不符直接拦下：

```
$ npm run score ./creatives/2026-05-04/
Pre-classifying 3 image(s) for primary advertiser ... done.

⚠️  Classifier detected competitor brands in 3 of 3 image(s):
  Screenshot 2.17.53 PM.png  →  Robinhood
  Screenshot 2.18.02 PM.png  →  Robinhood

Move them to ./creatives/benchmarks/competitor-monitoring/robinhood/2026-05-04/ and re-run
No Sonnet API spend incurred. Aborting.
```

**节省的不是钱**（多花$0.0075 vs省3次×3 runs Sonnet ≈ $0.15），**节省的是错误数据进DB+清理时间**。

Bypass：`--skip-classify`（误判时） / `--ad-type benchmark`（你确实想以alphawalk模式评含竞品logo的对比图）。

---

### 3. 自动压缩超大图

**之前**：gen pipeline输出8-10MB PNGs，超Anthropic 5MB上限，每天手动 `sips -Z 1280` 压缩才能跑score。

**现在**：scorer自动检测 ≥4MB 图，临时降到1280px JPEG再调API，不污染原文件。Done。

---

### 4. 自动产prompts（闭环上半）

新命令 `npm run next-prompts`：

```bash
npm run next-prompts                              # 5条，参考过去7天反馈
npm run next-prompts -- --n 10 --brief "..."    # 10条，加创意硬要求
```

它做的事：
- 读 `brand-dna.json`（视觉DNA硬约束）
- 读过去7天的winners（>=28分的） → 学其`winning_hypothesis`
- 读过去7天的losers → 学其`failure_modes`
- 读aggregated keywords → emphasize positives, avoid negatives
- 喂给 Claude Sonnet → 输出N条可直接贴 **Gemini Imagen** 或 **ChatGPT Image 2.0** 的自然语言prompts
- 存档 `prompts/<日期>.md`

成本：1次Sonnet call ≈ $0.05。

---

### 5. Feedback digest（闭环下半）

新命令 `npm run feedback`：

读最近7天的scoring → 生成结构化的 `creative-feedback.md`（KEEP/AVOID关键词表 + dimension趋势 + top/bottom creatives）。

**用法**：prompt-engineer subagent 现在每次draft prompts前会读这个文件，自动应用学到的偏好。也可以手动看：

```bash
npm run feedback                  # 默认7天窗口
npm run feedback -- --archive     # 同时存档历史版本
npm run feedback -- --since 2026-04-15  # 自定义窗口
```

**或者用slash command**（Claude Code里）：`/feedback` — 跑aggregator + 给你diff摘要。

每次跑完 `ad-scorer` subagent 自动重生成 `creative-feedback.md`（设了SubagentStop hook）。

---

### 6. 报告升级

报告HTML现在每张广告卡片显示：
- `25.0±0.8/40 · 候选` + `稳定` 绿色badge（多shot结果）
- `25/40 · 候选` + `单次` 灰色badge（legacy单次评分数据）
- 顶部summary多一格 **"不稳定 N"** —— 一眼看出今天有几张rubric判定不稳的

阅读优先级：
1. 先看不稳定数 — 这些先放一边
2. winner里有没有 `⚠️不稳定` —— 这些是"假winner"
3. 真winner（标稳定的）才是可投信号

---

## 完整每日工作流

```bash
# 1. 拉今天的prompts（学过去7天反馈）
npm run next-prompts

# 2. 复制prompts → Gemini / ChatGPT → 下载图 → 拖到 ./creatives/$(date +%Y-%m-%d)/

# 3. Score（intake gate + multi-shot N=3）
npm run score ./creatives/$(date +%Y-%m-%d)/

# 4. 重生成feedback digest（下次prompt-engineer会读）
npm run feedback -- --archive

# 5. 看报告
npm run report -- --filter-path=$(date +%Y-%m-%d)
open ./reports/report-$(date +%Y-%m-%d).html
```

每天跑一遍。今天的scoring反馈自动进入明天的`next-prompts`和prompt-engineer的context。**循环compound**。

---

## 一个真实例子（5月3日 smoke test）

跑 `npm run feedback` 跑出来一行扎眼的：

```
| Keyword                    | Drag  | Avg score | Used N times |
| purple gold color palette  | -30.8 | 35.0      | 3            |
```

`purple gold color palette` 是**brand DNA核心**，但被标"AVOID"。原因是gen pipeline在尝试brand colors时**执行不到位**（3张含此关键词的图都评了35分）。

**这个信号告诉我们**：不是色板有问题（brand-dna仍然锁定），而是图像生成模型在brand colors上还没调好——需要在prompt里更明确地约束色板使用方式。这是过去几天brand记忆点调试的具体抓手。

这正是为什么feedback要 vs brand-dna 分离：**brand-dna locked = 硬规则；feedback = 学到的执行偏好**。冲突时brand-dna永远赢。

---

## 给同事的快速上手

```bash
# clone + 配环境
git clone https://github.com/doggychip/ad-scorer
cd ad-scorer
cp .env.example .env
# 编辑 .env 填 ANTHROPIC_API_KEY (从 console.anthropic.com)
npm install
npm test  # 应该 10/10 pass

# 试一次完整循环
npm run next-prompts
# → 复制prompts去Gemini生成5张图
# → 下载到 ./creatives/$(date +%Y-%m-%d)/
npm run score ./creatives/$(date +%Y-%m-%d)/
npm run feedback
npm run report
```

---

## 文档索引

- **本文档** — changelog with examples
- `docs/what-it-does-zh-CN.md` — 系统概览（5分钟读完）
- `docs/multi-shot-scoring-zh-CN.md` — 多shot评分细节
- `CLAUDE.md` — 项目conventions + hard rules
- `brand-dna.json` — 视觉DNA规范（90天锁定）
- `creative-feedback.md` — 自动生成的learned preferences（gitignored，跑 `npm run feedback` 在本地生成）

---

## 还没做（roadmap）

- **CTR/CVR 真实数据 join** — 骨架已建（`src/perf-import.ts`、`src/perf-cli.ts`），等campaign投出去拿到Meta/TikTok CSV就能跑相关性分析
- **视频storyboard / shot list生成** — 静态图pipeline已稳定，下一步扩展到TikTok/Reels
- **Lark / Slack 每日digest推送** — scoring跑完自动push摘要到群（不用手动open报告）

---

## 关键数字

- **22** commits this month
- **5** 新TypeScript modules（aggregate, classifier, next-prompts, feedback module + adapter）
- **3** 新CLI命令（next-prompts, feedback, 加上多个新flag）
- **3** 篇zh-CN docs给团队
- **零** breaking changes — 老命令仍然work，只是默认行为更可信了

---

有问题问我，或直接跑 `npm run` 看help。
