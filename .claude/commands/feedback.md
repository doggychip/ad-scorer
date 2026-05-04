---
description: Regenerate creative-feedback.md from the latest scoring data and summarize what changed
allowed-tools: Bash, Read
---

Run the feedback aggregator from the latest scoring data:

!`npm run feedback -- --archive`

Then read @creative-feedback.md and summarize for me:

1. **Top 3 changes** vs the previous version (which keywords moved into KEEP, which moved into AVOID, anything that flipped sign)
2. **Dimension shifts** worth flagging — anything that moved by more than 0.5 vs prior window
3. **Anomalies** — keywords with very few occurrences that surfaced in either list (likely noise; flag for me to review)
4. **Recommended action** — should I commit this version, re-run with a tighter window, or investigate a specific creative before trusting it?

Do NOT auto-apply this to the generator agent's context. I will review the diff and commit manually.

If `feedback-archive/` has a previous version, diff against the most recent file there.
