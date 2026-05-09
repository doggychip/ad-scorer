# Scores Table Aggregate-Query Audit

Date: 2026-05-09
Context: After multi-shot N=3 scoring went live (2026-05-02), 
existing aggregate queries needed audit for per-image vs per-row semantics.

## Findings (M1-M7)

### M1: src/performance.ts:127-138 correlateRubricWithMetric()
[paste M1 detail from audit]

### M2: src/performance.ts:163-177 findOverratedAds / findUnderratedAds  
[paste M2 detail]

### M3: src/db.ts:241-262 getStats() — DEAD CODE
[paste M3 detail]

### M4: src/db.ts:219-234 getTopN/getBottomN — DEAD CODE
[paste M4 detail]

### M5: src/db.ts:214-217 getById — DEAD CODE
[paste M5 detail]

### M6: src/performance.ts schema — ARCHITECTURAL DEBT
[paste M6 detail]

### M7: src/db.ts benchmark_baselines — UNDOCUMENTED CONTRACT
[paste M7 detail]

## Triage decisions (from claude.ai sync 2026-05-09)

- M1, M2: CRITICAL — fix to use aggregated median per image
- M3, M4, M5: DELETE dead methods
- M6: DOCUMENT only with JSDoc warning
- M7: ADD SQL comment to schema

## Open question (from same session)

Home directory may be a git repo (~/.git exists?). Need to verify 
this is not the case before running git operations from session that
might cd up. Marker for next session: 
- Run `ls -la ~/.git` first
- If exists, investigate what it tracks before any git commands
