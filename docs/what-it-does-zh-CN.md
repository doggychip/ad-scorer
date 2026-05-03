# Alphawalk Ad Scorer — 这个项目能做什么

> 给团队同事的概览（不需要engineering背景，5分钟读完）。
> 想用：环境配置看 `CLAUDE.md`。多shot细节看 `multi-shot-scoring-zh-CN.md`。

## 一句话

**给Alphawalk建一套"按品牌DNA持续产广告 + 用Claude打分 + 反馈给下一批"的可信闭环。**

比手动眼判 + 经验调prompt更稳，因为：(a) 评分有可信度信号 (b) 反馈是数据驱动不是直觉。

---

## 能做的事（按场景分）

### 1. 评广告（核心）

```bash
npm run score ./creatives/2026-05-04/         # 默认N=3，每张3次取中位数
npm run score ./folder/ -- --runs 1           # 省钱probe模式（1次）
npm run score ./final.png -- --runs 5 --force # high-stakes review（5次）
```

每张图自动经过：
- **入口分类gate** — Haiku快速判断这是不是竞品图，是的话直接拦下不浪费Sonnet预算
- **超大图自动压缩** — ≥4MB的PNG自动降到1280px JPEG（Anthropic API 5MB限制）
- **多次评分取中位数** — N=3default，分数旁边标 `稳定` / `⚠️不稳定` / `单次`
- **8维度rubric打分** — 焦点 / 信息密度 / 信息层级 / 品牌一致性 / 差异化 / 情绪 / CTA / 反AI痕迹
- **IP风险flag** — 自动识别 Robinhood / IBKR / Apple / Tesla 等品牌出现

### 2. 看分析报告

```bash
npm run winners 5                            # 历史最高分前5
npm run losers 5                             # 历史最低分前5
npm run stats                                # 所有batch的aggregate stats
npm run keywords 30                          # 强化/移除关键词排行
npm run report -- --filter-path=2026-05-04   # 当天HTML报告
npm run export                               # 导CSV做外部分析
```

报告是中文HTML，含每张广告卡片 + 顶部summary stats（含"不稳定 N"那格）。可导PDF分享给非技术同事。

### 3. 生成下一批prompts（闭环关键）

```bash
npm run next-prompts                          # 5条，参考过去7天反馈
npm run next-prompts -- --n 10 --brief "..."  # 10条，加创意硬要求
```

读 `brand-dna.json`（视觉DNA硬约束）+ 最近winners/losers/keywords → Claude Sonnet → 输出可直接贴到 **Gemini Imagen** 或 **ChatGPT Image 2.0** 的natural-language prompts。

存档：`prompts/<日期>.md`

### 4. 竞品监控

```bash
mkdir -p creatives/benchmarks/competitor-monitoring/<brand>/<date>/
# 拖竞品广告图进来
npm run score ./creatives/benchmarks/competitor-monitoring/<brand>/<date>/
# 路径含 /benchmarks/ → 自动benchmark模式，竞品logo不算IP risk
```

可系统性研究 Robinhood / IBKR / eToro 等竞品的高分广告共同点。

### 5. 性能反馈（**等campaign数据到再用**）

```bash
npm run perf:import ./meta-export.csv         # 导Meta/TikTok/Google CSV
npm run perf:correlate                        # rubric维度 vs CTR的Pearson相关
npm run perf:overrated                        # 高分但CTR差（rubric overfit警示）
npm run perf:underrated                       # 低分但CTR好（rubric漏点警示）
```

骨架已建。等campaign投出去拿到Meta CSV就能跑，回答"rubric哪些维度真的预测市场signal"——这是验证整个系统是否overfit到设计学院审美的关键。

### 6. 数据持久 + 历史

所有评分进 SQLite (`data/scores.db`)。一行一次scoring run，按 `batch_id` 聚合。同图content_hash自动去重（--force 跳过缓存）。`scored_by_model` 字段允许对比不同模型评分。

---

## 完整每日工作流

```bash
# 1. 拉今天的prompts（自动学过去7天反馈）
npm run next-prompts

# 2. 复制prompts → Gemini Imagen 或 ChatGPT Image 2.0 → 下载图

# 3. 把图拖到 ./creatives/2026-05-04/，跑评分
npm run score ./creatives/2026-05-04/

# 4. 看报告
npm run report -- --filter-path=2026-05-04
open ./reports/report-2026-05-04.html
```

每天跑一遍，今天的scoring反馈自动进入明天的`next-prompts`。**循环compound**——brand DNA固定 + 反馈累积，理论上越跑越逼近"这个brand下哪种ad最有效"。

---

## 还没做的（roadmap）

- **Storyboard / 视频shot list生成** — 把这套pipeline扩展到视频广告（TikTok / Reels）
- **Lark / Slack daily digest** — scoring跑完自动push摘要到群（不用手动open report）
- **CTR pipeline接真实数据** — 骨架已有，等campaign投出来

---

## 上手checklist

```bash
# 1. clone repo
git clone https://github.com/doggychip/ad-scorer
cd ad-scorer

# 2. 环境
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY (从 console.anthropic.com)
npm install
npm test  # 应该 10/10 pass

# 3. 试一次
mkdir -p creatives/$(date +%Y-%m-%d)
# 拖几张广告图进去
npm run score ./creatives/$(date +%Y-%m-%d)/
npm run report -- --filter-path=$(date +%Y-%m-%d)
open ./reports/report-$(date +%Y-%m-%d).html
```

---

## 想深入看？

- 完整conventions + hard rules：`CLAUDE.md`
- 多shot评分细节：`docs/multi-shot-scoring-zh-CN.md`
- Brand DNA规范：`brand-dna.json`（90天锁定，不要乱改）
- 评分rubric：`src/rubric.ts`
- 设计文档：`docs/superpowers/specs/2026-05-02-multi-shot-scoring-design.md`
- 实施计划：`docs/superpowers/plans/2026-05-02-multi-shot-scoring.md`
