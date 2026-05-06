# Ad Scorer — Alphawalk.ai

Automated rubric-based evaluation of ad images using Claude vision. Built to close the feedback loop between human-curated creative ads and automated keyword/prompt generation.

## What it does

1. **Scores ad images on 8 dimensions** (focal point, info density, hierarchy, brand consistency, differentiation, emotional tone, CTA clarity, anti-AI-feel) — total 0–40
2. **Flags IP/legal risk** automatically (anime characters, real public figures, trademarked logos)
3. **Outputs structured keyword feedback** — what to emphasize and what to put in negative prompts, ready to feed back into your generation pipeline
4. **Persists everything in SQLite** for historical analysis and trend tracking
5. **Generates HTML reports** with thumbnails, score breakdowns, and aggregated keyword tables

## Quick start

```bash
# 1. Install
cd ad-scorer
npm install

# 2. Configure
cp .env.example .env
# edit .env — at minimum set ANTHROPIC_API_KEY

# 3. Score a folder of images
npm run score ./path/to/creatives/

# 4. Generate HTML report
npm run report
open ./reports/report-2026-04-29.html

# 5. Get keyword feedback for your prompt pipeline
npm run keywords 30
```

## Commands

| Command | Description |
|---|---|
| `npm run score <path>` | Score a single image or all images in a folder. Use `--force` to rescore. |
| `npm run report` | Generate HTML report (`./reports/report-YYYY-MM-DD.html`) |
| `npm run winners [N]` | List top N ads by score (default 10) |
| `npm run losers [N]` | List bottom N ads with failure modes |
| `npm run stats` | Aggregate statistics + dimension averages |
| `npm run keywords [N]` | Top N keyword phrases to emphasize / remove |
| `npm run export` | Export all scores to CSV (`./reports/scores.csv`) |
| `npm run ab:gen --concept <slug> --brief "..." --keywords-b "..."` | Generate A/B prompt variants (control vs keyword override). Writes `prompts/ab/<slug>-<date>/{A.md,B.md,MANIFEST.md}`. |
| `npm run ab:compare <parent-folder>` | Compare scored A/ and B/ subfolders: per-dim Δ, total Δ, SE-of-difference, underpower warning. |

## The feedback loop

This is the core workflow:

```
[your auto-gen pipeline] → daily ad images → npm run score ./today/
                                                       ↓
                                                   SQLite DB
                                                       ↓
                                              npm run keywords 30
                                                       ↓
                          → emphasize: "single character POV", "cinematic night lighting" ...
                          → remove: "split-screen comparison", "billboard collage" ...
                                                       ↓
                                       update prompt template / negative prompts
                                                       ↓
                                             [back to auto-gen pipeline]
```

After 3–4 weeks of daily scoring, the keyword aggregation will surface stable winning patterns. Feed the top "emphasize" phrases into your positive prompt seeds, and the top "remove" phrases into negative prompts.

## Customizing the rubric

The scoring criteria live in `src/rubric.ts`. Edit the system prompt to:
- Adjust dimension definitions
- Change the verdict thresholds (currently winner ≥ 30, candidate 20-29, reject < 20)
- Add brand-specific scoring rules
- Tune keyword extraction style

After changing the rubric, you may want to rescore historical images: `npm run score ./creatives/ --force`

## Cron / automation

To score all new images in a folder daily at 9am:

```cron
0 9 * * * cd /path/to/ad-scorer && /usr/local/bin/npm run score ./creatives/$(date +\%Y-\%m-\%d)/ >> ./logs/scoring.log 2>&1
```

The scorer skips already-scored images by default (matched on full filepath), so re-running on the same folder is safe and idempotent.

## Cost

Per-image cost depends on model:
- `claude-haiku-4-5-20251001` — ~$0.005 / image (cheapest, lower aesthetic judgment)
- `claude-sonnet-4-6` — ~$0.015 / image (default, good balance)
- `claude-opus-4-7` — ~$0.07 / image (best aesthetic judgment, use for high-stakes review)

For 100 images/day:
- Haiku: ~$0.50/day = $15/month
- Sonnet: ~$1.50/day = $45/month
- Opus: ~$7/day = $210/month

Recommended workflow: Sonnet for daily batch, Opus for top candidates before paid promotion.

## Schema

```sql
CREATE TABLE scores (
  id INTEGER PRIMARY KEY,
  filename TEXT, filepath TEXT, scored_at TEXT,
  focal_point INTEGER, information_density INTEGER, information_hierarchy INTEGER,
  brand_consistency INTEGER, differentiation INTEGER, emotional_tone INTEGER,
  cta_clarity INTEGER, anti_ai_feel INTEGER, total INTEGER,
  winning_hypothesis TEXT, failure_modes_json TEXT,
  keywords_emphasize_json TEXT, keywords_remove_json TEXT,
  ip_or_legal_risk TEXT, verdict TEXT, raw_response TEXT
);
```

Connect any BI tool (Metabase, Grafana, your finance dashboard) to `data/scores.db` for custom dashboards.

## A/B prompt testing

Test whether a keyword pivot actually moves rubric scores before adopting it as the new default:

```bash
# Variant A = current DB-derived KEEP keywords (control)
# Variant B = explicit emphasize override
npm run ab:gen --concept "single-character-pov" \
  --brief "lead with brand memorability hook" \
  --keywords-b "single character POV, cinematic night lighting, calm gaze" \
  --n 5

# After pasting prompts into Imagen and scoring both folders:
npm run ab:compare creatives/ab/single-character-pov/2026-05-06/
```

Output reports per-dimension Δ (B − A) on aggregated multi-shot scores plus an "n<10" caveat or a "within run-to-run noise" note when |Δ_total| is below the standard error of the difference. The brief is held constant; the only deliberate variation is the keyword set the prompt generator sees.

## Next steps to consider

- **Slack/Lark notification** — post daily summary of winners + IP risks to your team channel.
- **Mobile review interface** — small Express app for reviewing borderline candidates on phone (you already have the dashboard pattern for this).
