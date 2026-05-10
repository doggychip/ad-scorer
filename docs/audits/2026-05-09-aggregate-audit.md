# Scores Table Aggregate-Query Audit

Date: 2026-05-09
Context: After multi-shot N=3 scoring went live (2026-05-02), 
existing aggregate queries needed audit for per-image vs per-row semantics.

## Methodology

Inventoried all read paths against scores table by class:
- (a) per-row aggregate (reads raw scores rows, may be wrong)
- (b) per-image aggregate via getAggregatedRecords (correct)
- (c) single-row lookup (correct as-is)
- (d) raw-row dump (intentional, per spec §3 — CSV export)

## Findings

### M1: src/performance.ts:127-138 correlateRubricWithMetric()
**Current**: INNER JOIN scores s ON p.ad_id = s.id, GROUP BY s.id, 
correlates raw run_index=0 scores against AVG(p.metric). Only 1 of N 
rows joins because perf FK points at run_index=0 specifically.
**Should**: correlate AGGREGATED MEDIAN scores per image against 
perf metric.
**Impact**: Throws away 2/3 of multi-shot signal. Pearson r ≠ what 
user thinks it measures. CRITICAL — this powers the "is rubric 
scientific" answer.

### M2: src/performance.ts:163-177 findOverratedAds / findUnderratedAds
**Current**: WHERE s.total >= threshold filters on raw run_index=0 
total.
**Should**: Filter on aggregated median total per image.
**Impact**: Borderline images flicker in/out depending on which run 
finished first.

### M3: src/db.ts:241-262 getStats() — DEAD CODE
**Current**: COUNT(*) + AVG over raw rows + GROUP BY verdict + IP 
count over raw rows. All weighted N× by multi-shot; legacy single-shot 
weighted 1×.
**Status**: Dead code — no callers in src/. cmdStats reimplemented at 
index.ts:245 using getAggregatedRecords directly. getStats() is leftover 
from pre-multi-shot.
**Action**: Delete.

### M4: src/db.ts:219-234 getTopN / getBottomN — DEAD CODE
**Current**: ORDER BY total DESC/ASC LIMIT N over raw rows. Top-3 of 
a benchmark folder could be 3 runs of the same image.
**Status**: Dead code — no callers in src/. cmdWinners/cmdLosers use 
getAggregatedRecords directly.
**Action**: Delete.

### M5: src/db.ts:214-217 getById — DEAD CODE
**Current**: Returns one raw run as ImageRecord; type implies "image" 
but it's a run.
**Status**: Dead code — no callers in src/.
**Risk**: Future code calling getById() expecting an image will silently 
get one run.
**Action**: Delete.

### M6: src/performance.ts schema — ARCHITECTURAL DEBT
**Current**: performance.ad_id is FK to scores.id (per-run primary key), 
bound at import to run_index=0 row of whichever batch existed at import 
time.
**Issue**: After `score --force` creates a new batch, the new run_index=0 
has a NEW id; the old performance row still points at the OLD id → silent 
orphan.
**Should**: Either FK on content_hash OR document the binding-to-batch 
behavior.
**Impact**: Re-scoring a campaign creative for fresh medians breaks its 
perf join.
**Action**: Document with JSDoc warning. Defer FK redesign until real 
performance data exists and we feel the friction.

### M7: src/db.ts benchmark_baselines table — UNDOCUMENTED CONTRACT
**Current**: Schema exists (sample_size INTEGER NOT NULL declared), no 
insert/read code anywhere.
**Risk**: Future writer-author may use COUNT(*) (per-row) instead of 
COUNT(DISTINCT content_hash) (per-image) when implementing.
**Action**: Add SQL comment to schema explaining sample_size MUST be 
per-image count.

## Triage decisions (from claude.ai sync 2026-05-09)

| ID | Severity | Action |
|---|---|---|
| M1 | CRITICAL | Fix to use aggregated median per image |
| M2 | CRITICAL | Same pattern as M1 |
| M3-M5 | Cleanup | Delete dead methods |
| M6 | Architectural debt | Document with JSDoc; defer fix |
| M7 | Future trap | Add SQL comment to schema |

## Open issue: Home directory may be a git repo

During session 2026-05-09, `git rev-parse --show-toplevel` returned 
`/Users/rcheung` instead of `/Users/rcheung/projects/ad-scorer`, 
suggesting home directory might be its own git repo. Needs verification 
before any git operations from sessions that might cd up the tree.

## Next session protocol (2026-05-10+)

1. `cd ~/projects/ad-scorer && pwd && git rev-parse --show-toplevel`
   Confirm working directory and git repo are correct.

2. `ls -la ~/.git`
   Verify home is not a git repo. If it is, investigate before any 
   further git operations.

3. Read this audit file to pick up M1-M7 state.

4. Independently verify audit findings still hold in current code:
   `grep -n "correlateRubricWithMetric\|findOverratedAds\|getStats\|getTopN\|getById" src/`
   Output should match the file:line references in this audit.

5. Begin M1-M7 fixes only after steps 1-4 confirm clean state.

---

Generated during session 2026-05-09 with claude.ai. Audit performed 
by Claude Code in ~/projects/ad-scorer. Triage decisions made jointly.
