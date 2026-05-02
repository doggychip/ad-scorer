# Multi-shot self-consistency scoring

**Status:** Design approved 2026-05-02
**Author:** Brainstormed with Claude in `/Users/rcheung/projects/ad-scorer/`

## Problem

Single-shot Claude vision scores have ±2-4 point noise on the 40-point
total, observed empirically: `9.png` swung 32 → 28 between two
identical-config runs (same image, same model, same `--ad-type
benchmark`); `8.png` swung 30 → 27 in the same retest. That noise puts
borderline images on the wrong side of the winner/candidate threshold
(28+ wins, 22-27 candidate, <22 reject) and undermines downstream trust
in keyword feedback aggregated from those scores.

The whole project's premise is rubric-driven feedback into the gen
pipeline; if the rubric output is ±10% noisy, the feedback loop is
unreliable.

## Goal

Replace single-call scoring with N-call self-consistency. Aggregate the
N runs into a stable per-image score with a known dispersion, and
expose that dispersion so reviewers can tell stable judgments from
noisy ones.

## Non-goals

- Cross-model consensus (Sonnet + Opus + Haiku averaging). Mixing
  models defeats same-model variance measurement.
- Adaptive N (run more if std too high). YAGNI; a fixed N=3 with a
  user-driven `--runs 5` escape hatch is enough.
- Reprocessing existing legacy single-shot rows. They stay as-is and
  render with a "single-shot" indicator.

## Design

### 1. Execution model

For each image in a folder:

- N runs in parallel via `Promise.all` (default N=3).
- Images processed sequentially (one image's N runs finish before the
  next image starts).
- Wall time for 21 images at N=3: ~2.5 min (vs ~7 min fully sequential,
  vs Tier-1 RPM risk if all 63 calls parallel).

Failure handling per image:

- Each of the N runs is independently try/catch'd.
- ≥2 successful runs → batch is valid, aggregate over the survivors.
- 1 successful run → batch failed, no DB write, log to console.
- 0 successful → batch failed, no DB write.

This means a transient API blip costs at most one retry-on-next-image,
not a whole-folder failure.

### 2. Aggregation rules

Per image, given N successful runs:

| Field | Aggregation |
|-------|-------------|
| 8 dimension scores | Median of N values, rounded to nearest int |
| `total` | Median, rounded to nearest int |
| `std_total` | Standard deviation of N totals (float, stored on aggregate row) |
| `verdict` | Recomputed from aggregated `total` via existing thresholds (winner ≥28, candidate ≥22, else reject) |
| `ip_or_legal_risk` | If **any** run flagged → flagged. Concatenate distinct flag texts. |
| `winning_hypothesis`, `failure_modes_json`, `keywords_emphasize_json`, `keywords_remove_json` | Take from the **representative run** (the one whose `total` is closest to the aggregated median). Tie-break: lowest `run_index` wins (deterministic). Rationale: text fields can't be averaged; merging would hallucinate. |
| `raw_response` | Each individual run keeps its own `raw_response` on its own row. |
| Stability label | `std_total > 2.0` → "⚠️ unstable"; ≤2.0 → "stable"; legacy single-shot rows → "single-shot" |

Stability threshold of 2.0 is calibrated against observed noise: most
images had σ≤1.5, the unstable cases (8.png, 9.png) had σ≈3-4. Threshold
will be revisited after a week of production data.

### 3. Storage

**Schema migration** (auto-applied on next `ScoreDB` instantiation):

```sql
ALTER TABLE scores ADD COLUMN batch_id TEXT;
ALTER TABLE scores ADD COLUMN run_index INTEGER;
UPDATE scores SET batch_id = 'legacy-' || id, run_index = 0
  WHERE batch_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_batch_id ON scores(batch_id);
```

Every row in `scores` represents **one raw run**. A batch of N runs
shares a `batch_id` (use `crypto.randomUUID()` from Node — no new
dependency). `run_index` is `0..N-1` within the batch. One batch
covers exactly one image (one `content_hash`) in one scoring session;
scoring a folder of 10 images at N=3 produces 10 distinct `batch_id`s
× 3 rows = 30 rows. Backfilled legacy rows become "size-1 batches"
tagged `legacy-{id}`.

**Aggregation lives in JS, not SQL.** SQLite has no native median, and
the qualitative-field "representative run" selection is awkward in
pure SQL. New method `db.getAggregatedRecords(filterPathSubstring?)`:

1. Load all matching raw rows (apply optional `filepath LIKE ?`).
2. Group by `batch_id` in JS.
3. For each group, compute the aggregated record per the rules above.
4. Return `AggregatedRecord[]` — same shape as `ImageRecord` plus
   `std_total: number | null`, `batch_size: number`, `stability:
   'stable' | 'unstable' | 'single-shot'`.

All display read-paths (`winners`, `losers`, `stats`, `keywords`,
`report`) switch to `getAggregatedRecords()`. The `export` (CSV)
command keeps emitting raw rows (one per run) for downstream
analytical use — adding aggregation there would hide the variance
data the export is most useful for.

Raw rows are accessible only via direct SQL or a future
`inspect-batch <batch_id>` command (deferred).

### 4. CLI

**New flag:** `--runs N` on the `score` command. Default 3.

```
npm run score <path> [--runs N] [--force] [--ad-type ...] [--model ...]
```

- `--runs 1` opt-out (cheap probe mode).
- `--runs 5` for high-stakes review (e.g. final sign-off on a campaign).

**`--force` semantics:** unchanged conceptually but now per-batch.
Without `--force`, skip if any complete batch exists for the
`(content_hash, model)` pair. With `--force`, always create a new
batch; old batches are preserved (for historical comparison).

**Cache check** becomes `db.hasBatchByHash(hash, model): boolean` —
true if any batch (size ≥ 1, including legacy single-shot batches)
exists for the hash+model. Consequence: legacy rows count as "already
scored" and are skipped without `--force` — matching the
non-goal of auto-rescoring legacy data.

**Score command output** (one line per image after its N runs finish):

```
→ 1.png [benchmark] runs=3 ... 25.0±0.8/40 [candidate, stable] (batch ab12cd)
→ 9.png [benchmark] runs=3 ... 30.0±2.5/40 [winner, ⚠️unstable] (batch ef34gh)
→ 6.png [benchmark] runs=3 ... 28.0±0.5/40 [candidate, stable] ⚠️ IP RISK (batch ij56kl)
```

`winners` / `losers` / `stats` outputs add `±std` after total and
`stable`/`unstable`/`single-shot` after verdict. `keywords` aggregates
over the representative run only (so a phrase appearing in N runs
counts as 1, not N).

### 5. Report integration

Card header total replaces `25/40 · 候选` with
`25.0±0.8/40 · 候选 · 稳定` (or `⚠️ 不稳定` / `单次`).

Per-dimension score bars **don't** show ±std (already busy enough; raw
spread is queryable via `sqlite3` directly).

Top summary stats grid adds one cell:

```
[ 总评 21 ]  [ 优胜 7 ]  [ 候选 14 ]  [ 不合格 0 ]  [ IP风险 1 ]  [ 不稳定 ⚠️ 3 ]  [ 平均 28.5/40 ]
```

`--filter-path` keeps working: filter applies to raw rows first, then
aggregation runs on the surviving rows.

Raw runs are not surfaced in the report. Future `--show-runs` flag
deferred until a real need.

### 6. Migration of existing data

Auto-migration on next code load:

- `ALTER TABLE` adds two columns + index.
- Backfill assigns `batch_id = 'legacy-{id}'`, `run_index = 0` to all
  existing rows. They become valid size-1 batches and continue to
  appear in all read commands.
- Aggregated view renders legacy rows with no `±std`, stability tag
  `单次` (gray, distinct from green `稳定` / yellow `⚠️ 不稳定`) so the
  reader knows that score is single-shot and lower-confidence.

The current 21 IB rows (id 78-98, single-shot) are not auto-rescored.
The user can opt in:

```
npm run score --force ./creatives/benchmarks/competitor-monitoring/interactive-brokers/2026-04-30/
```

Default `--runs=3` will create new batches; old single-shot rows stay
as historical comparison points.

## Implementation order

1. Schema migration in `src/db.ts` (`init()` adds the ALTER + backfill).
2. Add `db.getAggregatedRecords()` returning `AggregatedRecord[]`.
3. Add helpers:
   - `db.hasBatchByHash(hash: string, model: string): boolean`
   - `db.insertRun(filename, filepath, contentHash, model, batchId, runIndex, result, raw): number` — single-row insert, returns row id.
   - Caller (`cmdScore`) generates one `batchId` per image and calls
     `insertRun` once per surviving run.
4. Refactor `scorer.ts` to expose `scoreImageMultiShot(filepath, adType, n)` returning `{ runs: ScoreResult[], errors: Error[] }`.
5. Refactor `cmdScore` in `src/index.ts` to thread `--runs`, parallelize per-image, write all surviving runs under one `batch_id`.
6. Refactor read commands (`winners`, `losers`, `stats`, `keywords`,
   `report`) to use `getAggregatedRecords()`.
7. Update `report.ts` to render `±std`, stability badge, "不稳定" stat.
8. Update CLI usage docs in `cmdHelp` and any skill files referencing
   `npm run score`.
9. Update `CLAUDE.md` "Common workflows" section to mention default N=3.
10. Add a `--runs 1` example to docs for cheap probe use case.

## Test plan

- Run `npm run score --runs 3 ./creatives/benchmarks/competitor-monitoring/interactive-brokers/2026-04-30/ --force` on the 21 IB images. Compare aggregated medians to the previous single-shot scores; expect winners list to be more stable than the run-to-run swings observed in single-shot.
- Verify legacy rows still appear in `winners`/`losers` with `单次` badge and no `±std`.
- Verify `--filter-path` still scopes the report after aggregation.
- Verify `--runs 1` skips aggregation overhead and produces a size-1 batch indistinguishable from legacy rows in display.
- Verify a batch where 1 of 3 runs fails (simulate by killing API mid-call) results in no DB write for that image.

## Out of scope (deferred)

- `inspect-batch <batch_id>` CLI to dump raw runs.
- `--show-runs` flag in report to render the spread visually.
- Adaptive N (more runs if std too high).
- Cross-model consensus.
- Per-dimension std display in report cards.
- Migration tool to retroactively rescore the legacy validation set.
