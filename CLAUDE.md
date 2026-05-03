# Alphawalk.ai Ad Scorer — Claude Code Project Memory

This file is auto-loaded at the start of every Claude Code session in this project. Keep it under 300 lines. Edit when the project's context shifts.

## What this project does

Automated rubric-based scoring of ad images for **Alphawalk.ai** (AI investment assistant for retail traders, target market: East Asia). The core loop:

```
brand-dna.json (single source of truth)
    ├──→ image generation prompts (positive constraints)
    ├──→ scorer rubric (drift detection)
    └──→ video shot list (when storyboard pipeline ships)
              ↓
       creatives generated
              ↓
       npm run score → SQLite
              ↓
       npm run keywords → feedback into next gen cycle
```

**Goal:** stop the "风格漂移→ 高CAC" feedback loop by locking visual DNA and measuring drift.

## Stack conventions

- **TypeScript only**, no frameworks. ES modules. `tsx` for execution.
- **SQLite** via `better-sqlite3` for all persistence
- **Anthropic SDK** for Claude vision calls (`claude-sonnet-4-6` default, `claude-opus-4-7` for high-stakes review, `claude-haiku-4-5-20251001` for cheap batch)
- **Zeabur** for any deployment
- No React/Vue/etc — keep it CLI + HTML reports

## Key files

- `brand-dna.json` — **locked visual identity spec.** Inject into every gen prompt and every scorer call. Lock period: 90 days. Do not edit during lock.
- `brand-dna.md` — rationale companion for `brand-dna.json`. Read this before suggesting any DNA change.
- `src/rubric.ts` — the scorer's system prompt. The single most important tunable in the project.
- `src/scorer.ts` — Claude vision API wrapper. Uses JSON prefill (`{`) to lock structured output.
- `src/db.ts` — SQLite schema + keyword aggregation queries.
- `data/scores.db` — historical scores. Don't delete; this is the learning corpus.

## Hard rules (do NOT violate)

1. **Never edit `brand-dna.json` without referencing `brand-dna.md` rationale.** Each field is a deliberate decision; explain why before changing.
2. **Never bypass `brand-dna.json` injection** when generating image prompts. Drift starts here.
3. **Never use `claude-3-*` model names** — they are deprecated. Always use `claude-sonnet-4-6` / `claude-opus-4-7` / `claude-haiku-4-5-20251001`.
4. **Never store the API key in code** — only in `.env` (gitignored).
5. **Never quote characters from existing IPs** in ad copy or image prompts (千早愛音, Genshin, Hololive, etc.). Auto-rejected by scorer.
6. **Never use lists/bullets in actual ad copy headlines** — that's the PPT病 trigger. Headlines ≤ 8 words.

## Common workflows

### Daily ad scoring
```bash
# Default: 3 runs per image (more reliable scores, ~3x API cost)
npm run score ./creatives/$(date +%Y-%m-%d)/

# Cheap probe mode (single-shot, useful for early-day iteration)
# npm run score ./creatives/$(date +%Y-%m-%d)/ -- --runs 1

npm run keywords 30
npm run report -- --filter-path=$(date +%Y-%m-%d)
open ./reports/report-$(date +%Y-%m-%d).html
```

### After a Meta/TikTok campaign closes (when CTR/CVR data comes in)
Compare scorer ratings vs actual performance. Look for:
- Dimensions where our rubric correlates with CTR (these dimensions are validated)
- Dimensions where it doesn't (these need rubric revision)

### Competitor benchmarking
Drop competitor ads into `./competitors/{brand}/`, score with same rubric, compare dimension averages. Look for:
- Where we systematically underperform vs winning competitors
- What aesthetic patterns dominate in long-running competitor ads (= profitable patterns)

## Failure modes to watch for

- **PPT病** — keyword pipeline drifts toward "include all features" → scorer's `information_density` < 2 → reject
- **Style drift** — daily images aesthetic varies → `brand_consistency` low across recent batch → time to remind the gen pipeline of brand-dna
- **Local optima** — scorer rates highly but real CTR is poor → rubric overfits to design-school criteria, missing market signal → revise rubric weights based on performance data
- **IP creep** — gen pipeline starts riffing on existing IPs because they're in training data → scorer's `ip_or_legal_risk` field catches it, but we should also catch in prompt-construction
- **Rubric noise** — if a batch comes back `⚠️ unstable` (std > 2.0 across N runs), the rubric is making an unsteady judgment on this image. Don't trust the median; either rescore at `--runs 5` or accept that this image is borderline.
- **Degraded 2-shot batches** — if you see batches saving with `2 runs` instead of `3 runs`, a transient API call failed mid-batch; the ≥2 threshold preserved the result but it has lower stability resolution. Re-run if stability matters.

## What's NOT in this project (yet)

- Performance correlation (CTR/CVR data join with scores) — planned, not built
- Competitor benchmark mode — planned, not built
- Storyboard / video shot list generation — planned, not built
- Lark/Slack daily digest notifications — planned, not built

## Subagents available

- `ad-scorer` — scores a folder of images, summarizes winners/losers/IP risks
- `prompt-engineer` — generates image generation prompts that comply with brand-dna.json

Use them via `> Use the ad-scorer agent to ...` or `> Have prompt-engineer draft 5 ad concepts for ...`

## Skills available

- `score-today` — runs the daily scoring workflow end-to-end
- `new-concept` — takes a creative brief, outputs brand-dna-compliant prompts ready for image generation
