---
description: Run today's ad scoring workflow — equivalent to invoking the score-today skill. Outputs winners, IP risks, keyword feedback, and HTML report path.
---

Run the score-today skill end-to-end:
1. Score images in ./creatives/$(date +%Y-%m-%d)/
2. Surface IP risks (top priority)
3. Identify top winners and bottom rejects from today's batch
4. Pull keyword feedback (top 20 emphasize / top 20 remove)
5. Generate HTML report
6. Summarize in the standard daily review format

If today's folder is empty or missing, ask where today's images are.
