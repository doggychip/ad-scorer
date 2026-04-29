---
name: score-today
description: Run the complete daily ad scoring workflow — score today's creatives folder, surface IP risks, generate keyword feedback, and produce HTML report. Use when user says "score today's ads", "run the daily review", or asks for a status on this morning's creative batch.
---

# Daily ad scoring workflow

This skill executes the standard daily review of today's creative batch. It assumes the gen pipeline drops new images into `./creatives/YYYY-MM-DD/` (today's date).

## Steps

1. **Locate today's folder**:
   ```bash
   TODAY=$(date +%Y-%m-%d)
   FOLDER="./creatives/$TODAY"
   ```
   If the folder doesn't exist, ask the user where today's images are.

2. **Score the batch** (skips already-scored, so safe to re-run):
   ```bash
   npm run score "$FOLDER"
   ```

3. **Check for IP risks first** — these are blocking:
   ```bash
   sqlite3 data/scores.db "SELECT filename, ip_or_legal_risk FROM scores WHERE ip_or_legal_risk IS NOT NULL AND scored_at >= date('now', '-1 day')"
   ```
   If any rows return, surface them at the TOP of your summary with a 🚨 marker. The user must see these before anything else.

4. **Get top 3 winners and bottom 3 from today's batch**:
   ```bash
   sqlite3 data/scores.db "SELECT filename, total, verdict, winning_hypothesis FROM scores WHERE scored_at >= date('now', '-1 day') ORDER BY total DESC LIMIT 3"
   sqlite3 data/scores.db "SELECT filename, total, verdict, failure_modes_json FROM scores WHERE scored_at >= date('now', '-1 day') ORDER BY total ASC LIMIT 3"
   ```

5. **Pull keyword feedback for the gen pipeline**:
   ```bash
   npm run keywords 20
   ```

6. **Generate HTML report**:
   ```bash
   npm run report
   ```

7. **Summarize for the user** in this exact structure:

   ```
   📊 Daily Ad Review — YYYY-MM-DD
   
   Scored: N images (M winners, K candidates, J rejects)
   
   🚨 IP/Legal risks: <count, or "none">
   <list each one if present>
   
   ✅ Top winner: <filename> · <score>/40
       <winning hypothesis>
   
   ❌ Bottom: <filename> · <score>/40
       <dominant failure mode>
   
   📈 Pattern this batch: <1 sentence diagnosis>
   
   🎯 Recommended adjustments to gen pipeline:
   - Emphasize: <top 3 keywords from "EMPHASIZE" list>
   - Remove: <top 3 keywords from "REMOVE" list>
   
   Full report: ./reports/report-YYYY-MM-DD.html
   ```

## What NOT to do

- Don't re-score images that are already in the DB (the CLI handles this; don't pass `--force` unless user explicitly asks)
- Don't lecture the user on rubric details — give the signal, link to the report for details
- Don't suggest changing `brand-dna.json` — that's a separate quarterly decision
