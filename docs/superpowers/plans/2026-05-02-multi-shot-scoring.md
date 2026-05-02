# Multi-shot self-consistency scoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-call Claude vision scoring with N parallel calls per image, aggregated in JS via median + std + representative-run, surfaced as a stability badge in CLI and HTML report.

**Architecture:** Each row in the existing `scores` SQLite table represents one raw run; siblings of the same scoring batch share a `batch_id` (UUID). Aggregation is a pure JS function over raw rows grouped by `batch_id`. Read paths (winners/losers/stats/keywords/report) consume `getAggregatedRecords()` instead of `getAll()`. Default N=3 makes multi-shot the new normal.

**Tech Stack:** TypeScript (ESM), `better-sqlite3`, `@anthropic-ai/sdk`, `tsx` for execution, `vitest` for unit tests on aggregation logic only (CLI integration verified by running commands).

**Spec:** `docs/superpowers/specs/2026-05-02-multi-shot-scoring-design.md`

---

## File map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | Add `AggregatedRecord`, `Stability`, `BatchAggregateInput` types |
| `src/db.ts` | Modify | Schema migration; new `insertRun`, `hasBatchByHash`, `getAggregatedRecords`; preserve existing `insert` as wrapper |
| `src/aggregate.ts` | Create | Pure aggregation function: raw rows → AggregatedRecord (median, std, representative-run, IP union, stability) |
| `src/scorer.ts` | Modify | Add `scoreImageMultiShot(filepath, adType, n)` returning `{ runs, errors }` |
| `src/index.ts` | Modify | `cmdScore` parses `--runs N`, generates batch_id, parallel runs, writes survivors; `cmdReport`/`cmdWinners`/`cmdLosers`/`cmdStats`/`cmdKeywords` consume `getAggregatedRecords()`; usage docs updated |
| `src/report.ts` | Modify | Card header shows `±std`, stability badge; summary stats grid adds 不稳定 cell |
| `tests/aggregate.test.ts` | Create | Unit tests for aggregation correctness |
| `vitest.config.ts` | Create | Vitest config (ESM, tsx-compatible) |
| `package.json` | Modify | Add `vitest` devDep + `test` script |
| `CLAUDE.md` | Modify | Daily workflow section: default N=3 implied, mention `--runs 1` cheap mode |

---

## Task 1: Add vitest test framework

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/.gitkeep` (so the dir exists)

- [ ] **Step 1: Install vitest**

Run:
```bash
cd ~/projects/ad-scorer && npm install --save-dev vitest@^2.1.0
```

Expected: vitest added to devDependencies. No errors.

- [ ] **Step 2: Add `test` script to package.json**

Edit `package.json`. Locate the `"scripts"` object and add `"test": "vitest run"` between `"build"` and `"score"`:

```json
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "score": "tsx src/index.ts score",
```

- [ ] **Step 3: Create `vitest.config.ts`**

Create `vitest.config.ts` at repo root:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Verify scaffolding**

Create `tests/.gitkeep` (empty file). Then run:
```bash
cd ~/projects/ad-scorer && npm test
```

Expected: `No test files found` exit cleanly (vitest discovered the config but no tests yet).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/ad-scorer && git add package.json package-lock.json vitest.config.ts tests/.gitkeep && git commit -m "chore: add vitest for unit testing aggregation logic"
```

---

## Task 2: Add `AggregatedRecord` and `Stability` types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add new types to `src/types.ts`**

Append these exports to the end of `src/types.ts` (after `KeywordAggregation`):

```ts
export type Stability = "stable" | "unstable" | "single-shot";

/** A representative record summarizing one batch (one image's N runs). */
export interface AggregatedRecord {
  /** id of the representative run (the row whose total is closest to the median). */
  id: number;
  filename: string;
  filepath: string;
  scored_at: string;
  /** Aggregated scores: per-dimension median, total = median of run totals. */
  result: ScoreResult;
  /** Standard deviation of the N totals. null when batch_size === 1. */
  std_total: number | null;
  batch_id: string;
  batch_size: number;
  stability: Stability;
}

/** Shape of a single raw row used as input to aggregation. */
export interface RawRunRow {
  id: number;
  filename: string;
  filepath: string;
  scored_at: string;
  batch_id: string;
  run_index: number;
  result: ScoreResult;
}
```

- [ ] **Step 2: Verify types compile**

Run:
```bash
cd ~/projects/ad-scorer && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/ad-scorer && git add src/types.ts && git commit -m "types: add AggregatedRecord, Stability, RawRunRow"
```

---

## Task 3: Schema migration for `batch_id` and `run_index`

**Files:**
- Modify: `src/db.ts:55-67` (the existing migration loop in `init()`)

- [ ] **Step 1: Extend the column-add loop in `init()`**

In `src/db.ts`, locate the existing migration block:

```ts
    for (const col of [
      `ALTER TABLE scores ADD COLUMN content_hash TEXT`,
      `ALTER TABLE scores ADD COLUMN scored_by_model TEXT`,
    ]) {
```

Replace with:

```ts
    for (const col of [
      `ALTER TABLE scores ADD COLUMN content_hash TEXT`,
      `ALTER TABLE scores ADD COLUMN scored_by_model TEXT`,
      `ALTER TABLE scores ADD COLUMN batch_id TEXT`,
      `ALTER TABLE scores ADD COLUMN run_index INTEGER`,
    ]) {
```

- [ ] **Step 2: Backfill legacy rows + add index**

Below the column-add loop (before the index `CREATE INDEX` block at line ~70), insert:

```ts
    // Backfill legacy rows: each becomes a "size-1 batch" tagged legacy-{id}.
    // Idempotent — only touches rows where batch_id is still NULL.
    this.db.exec(`
      UPDATE scores
      SET batch_id = 'legacy-' || id, run_index = 0
      WHERE batch_id IS NULL;
    `);
```

In the existing `CREATE INDEX` block, append:

```ts
      CREATE INDEX IF NOT EXISTS idx_batch_id ON scores(batch_id);
```

- [ ] **Step 3: Verify migration runs and backfill is correct**

Run:
```bash
cd ~/projects/ad-scorer && npx tsx -e "
import { ScoreDB } from './src/db.js';
const db = new ScoreDB('./data/scores.db');
db.close();
" && sqlite3 data/scores.db "SELECT COUNT(*) AS total, COUNT(batch_id) AS with_batch FROM scores"
```

Expected: `total` and `with_batch` are equal (every row has a batch_id). Sample a row:

```bash
sqlite3 -column -header data/scores.db "SELECT id, batch_id, run_index FROM scores LIMIT 3"
```

Expected: `batch_id` values look like `legacy-1`, `legacy-17`, etc.; `run_index` is `0`.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/ad-scorer && git add src/db.ts && git commit -m "db: add batch_id+run_index columns, backfill legacy rows as size-1 batches"
```

---

## Task 4: Refactor `db.insert` into `db.insertRun` (preserving back-compat)

**Files:**
- Modify: `src/db.ts:95-138` (the existing `insert` method)

- [ ] **Step 1: Rename `insert` to `insertRun` and add batch params**

Replace the entire existing `insert(...)` method in `src/db.ts` with:

```ts
  insertRun(
    filename: string,
    filepath: string,
    contentHash: string,
    model: string,
    batchId: string,
    runIndex: number,
    result: ScoreResult,
    raw: string
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO scores (
        filename, filepath, content_hash, scored_by_model,
        batch_id, run_index,
        focal_point, information_density, information_hierarchy,
        brand_consistency, differentiation, emotional_tone,
        cta_clarity, anti_ai_feel, total,
        winning_hypothesis, failure_modes_json,
        keywords_emphasize_json, keywords_remove_json,
        ip_or_legal_risk, verdict, raw_response
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const info = stmt.run(
      filename,
      filepath,
      contentHash,
      model,
      batchId,
      runIndex,
      result.scores.focal_point,
      result.scores.information_density,
      result.scores.information_hierarchy,
      result.scores.brand_consistency,
      result.scores.differentiation,
      result.scores.emotional_tone,
      result.scores.cta_clarity,
      result.scores.anti_ai_feel,
      result.total,
      result.winning_hypothesis,
      JSON.stringify(result.failure_modes),
      JSON.stringify(result.suggested_keywords_to_emphasize),
      JSON.stringify(result.suggested_keywords_to_remove),
      result.ip_or_legal_risk,
      result.verdict,
      raw
    );

    return info.lastInsertRowid as number;
  }
```

- [ ] **Step 2: Verify the migration script still compiles**

The old `insert` is gone. The migration script in `src/migrations/backfill-content-hash.ts` doesn't call `insert` (it calls `setContentHash`), so it should be unaffected. Verify:

```bash
cd ~/projects/ad-scorer && npx tsc --noEmit
```

Expected: error in `src/index.ts` saying `db.insert(...)` doesn't exist (this is expected — Task 9 will fix it). All other files compile.

- [ ] **Step 3: Commit (intentionally broken state — fixed in Task 9)**

```bash
cd ~/projects/ad-scorer && git add src/db.ts && git commit -m "db: rename insert -> insertRun with batch_id+run_index params"
```

Note: this commit leaves `cmdScore` in `src/index.ts` calling the now-removed `insert`. Task 9 wires up the new call site. Don't run `npm run score` between this commit and Task 9.

---

## Task 5: Add `db.hasBatchByHash` cache check

**Files:**
- Modify: `src/db.ts:151-156` (existing `hasScoredByHash`)

- [ ] **Step 1: Add `hasBatchByHash` next to `hasScoredByHash`**

After the existing `hasScoredByHash` method in `src/db.ts`, add:

```ts
  /**
   * True iff at least one row exists for this content_hash + model combo.
   * Counts legacy single-shot batches as "already scored" — matching the
   * non-goal of auto-rescoring legacy data.
   */
  hasBatchByHash(contentHash: string, model: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM scores WHERE content_hash = ? AND scored_by_model = ? LIMIT 1`
      )
      .get(contentHash, model);
    return !!row;
  }
```

Keep `hasScoredByHash` — it's still used by `migrations/backfill-content-hash.ts` indirectly (via `hasScored`).

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd ~/projects/ad-scorer && npx tsc --noEmit
```

Expected: same `db.insert` error as Task 4; no new errors.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/ad-scorer && git add src/db.ts && git commit -m "db: add hasBatchByHash(hash, model) for multi-shot cache check"
```

---

## Task 6: Implement aggregation function — TDD

**Files:**
- Create: `src/aggregate.ts`
- Create: `tests/aggregate.test.ts`

- [ ] **Step 1: Write failing tests for the aggregation function**

Create `tests/aggregate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { aggregateBatch } from "../src/aggregate.js";
import { RawRunRow, ScoreResult } from "../src/types.js";

function mkRun(
  id: number,
  batchId: string,
  runIndex: number,
  total: number,
  overrides: Partial<ScoreResult> = {}
): RawRunRow {
  const result: ScoreResult = {
    scores: {
      focal_point: 4,
      information_density: 4,
      information_hierarchy: 4,
      brand_consistency: 3,
      differentiation: 3,
      emotional_tone: 3,
      cta_clarity: 3,
      anti_ai_feel: total - 24, // makes scores sum to total
    },
    total,
    winning_hypothesis: `hyp-${id}`,
    failure_modes: [`fail-${id}`],
    suggested_keywords_to_emphasize: [`emp-${id}`],
    suggested_keywords_to_remove: [`rem-${id}`],
    ip_or_legal_risk: null,
    verdict: total >= 28 ? "winner" : total >= 22 ? "candidate" : "reject",
    ...overrides,
  };
  return {
    id,
    filename: "x.png",
    filepath: "/p/x.png",
    scored_at: "2026-05-02 10:00:00",
    batch_id: batchId,
    run_index: runIndex,
    result,
  };
}

describe("aggregateBatch", () => {
  it("size-1 batch returns the single run with stability=single-shot, std=null", () => {
    const out = aggregateBatch([mkRun(1, "b1", 0, 25)]);
    expect(out.batch_size).toBe(1);
    expect(out.stability).toBe("single-shot");
    expect(out.std_total).toBeNull();
    expect(out.result.total).toBe(25);
    expect(out.id).toBe(1);
  });

  it("size-3 batch with low spread returns median, stable", () => {
    const out = aggregateBatch([
      mkRun(1, "b1", 0, 25),
      mkRun(2, "b1", 1, 26),
      mkRun(3, "b1", 2, 27),
    ]);
    expect(out.batch_size).toBe(3);
    expect(out.result.total).toBe(26); // median
    expect(out.stability).toBe("stable");
    expect(out.std_total).toBeCloseTo(0.816, 2); // pop std of [25,26,27]
  });

  it("size-3 batch with high spread returns median, unstable (std > 2.0)", () => {
    const out = aggregateBatch([
      mkRun(1, "b1", 0, 28),
      mkRun(2, "b1", 1, 32),
      mkRun(3, "b1", 2, 24),
    ]);
    expect(out.result.total).toBe(28); // median of [28,32,24]
    expect(out.stability).toBe("unstable");
    expect(out.std_total).toBeGreaterThan(2.0);
  });

  it("verdict is recomputed from aggregated total", () => {
    // Three runs with totals straddling the 28 threshold: 30 winner, 27 candidate, 26 candidate.
    // Median = 27 → verdict should be candidate.
    const out = aggregateBatch([
      mkRun(1, "b1", 0, 30),
      mkRun(2, "b1", 1, 27),
      mkRun(3, "b1", 2, 26),
    ]);
    expect(out.result.total).toBe(27);
    expect(out.result.verdict).toBe("candidate");
  });

  it("per-dimension median rounded to int", () => {
    // Build three runs with focal_point = 3, 4, 5 → median 4.
    const r1 = mkRun(1, "b1", 0, 25);
    r1.result.scores.focal_point = 3;
    const r2 = mkRun(2, "b1", 1, 25);
    r2.result.scores.focal_point = 4;
    const r3 = mkRun(3, "b1", 2, 25);
    r3.result.scores.focal_point = 5;
    const out = aggregateBatch([r1, r2, r3]);
    expect(out.result.scores.focal_point).toBe(4);
  });

  it("ip_or_legal_risk: any flag → flagged with concatenated distinct texts", () => {
    const r1 = mkRun(1, "b1", 0, 25, { ip_or_legal_risk: "Apple logo present" });
    const r2 = mkRun(2, "b1", 1, 25, { ip_or_legal_risk: null });
    const r3 = mkRun(3, "b1", 2, 25, { ip_or_legal_risk: "Tesla logo present" });
    const out = aggregateBatch([r1, r2, r3]);
    expect(out.result.ip_or_legal_risk).toContain("Apple logo present");
    expect(out.result.ip_or_legal_risk).toContain("Tesla logo present");
  });

  it("ip_or_legal_risk: all null → null", () => {
    const out = aggregateBatch([
      mkRun(1, "b1", 0, 25),
      mkRun(2, "b1", 1, 26),
      mkRun(3, "b1", 2, 27),
    ]);
    expect(out.result.ip_or_legal_risk).toBeNull();
  });

  it("representative run = run with total closest to median; tie-break = lowest run_index", () => {
    // Runs at totals 24, 28, 32 → median 28, representative run_index = 1, id = 2.
    const out = aggregateBatch([
      mkRun(1, "b1", 0, 24),
      mkRun(2, "b1", 1, 28),
      mkRun(3, "b1", 2, 32),
    ]);
    expect(out.id).toBe(2);
    expect(out.result.winning_hypothesis).toBe("hyp-2");

    // Tie case: totals 25, 27 → median 26, both equidistant. Lowest run_index wins → id=1.
    const out2 = aggregateBatch([
      mkRun(10, "b2", 0, 25),
      mkRun(11, "b2", 1, 27),
    ]);
    expect(out2.result.total).toBe(26);
    expect(out2.id).toBe(10);
  });

  it("size-2 batch (one run failed) is valid, std computed normally", () => {
    const out = aggregateBatch([
      mkRun(1, "b1", 0, 25),
      mkRun(2, "b1", 1, 27),
    ]);
    expect(out.batch_size).toBe(2);
    expect(out.result.total).toBe(26);
    expect(out.std_total).toBeCloseTo(1.0, 2); // pop std of [25,27]
    expect(out.stability).toBe("stable");
  });

  it("throws on empty input", () => {
    expect(() => aggregateBatch([])).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they all FAIL**

Run:
```bash
cd ~/projects/ad-scorer && npm test
```

Expected: All 10 tests FAIL with `Cannot find module ../src/aggregate.js` or similar.

- [ ] **Step 3: Implement `src/aggregate.ts`**

Create `src/aggregate.ts`:

```ts
import { AggregatedRecord, RawRunRow, RubricScores, Verdict } from "./types.js";

const STABILITY_STD_THRESHOLD = 2.0;

/** Recompute verdict from total via the project's existing thresholds. */
function verdictFromTotal(total: number): Verdict {
  if (total >= 28) return "winner";
  if (total >= 22) return "candidate";
  return "reject";
}

/** Median of a list of numbers. Throws on empty. */
function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median: empty input");
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Population standard deviation. Returns 0 for length<2. */
function popStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance =
    xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/**
 * Aggregate N runs of one image (sharing batch_id) into a single record.
 * - Numeric (per-dim + total): median, rounded to nearest int.
 * - std_total: population std of run totals; null when N=1.
 * - verdict: recomputed from aggregated total.
 * - ip_or_legal_risk: union of distinct flag texts; null if all null.
 * - Qualitative fields: copied from the "representative run" — the run whose
 *   total is closest to the median. Tie-break: lowest run_index.
 * - stability: "single-shot" if N=1, else "unstable" if std > 2.0, else "stable".
 */
export function aggregateBatch(runs: RawRunRow[]): AggregatedRecord {
  if (runs.length === 0) throw new Error("aggregateBatch: empty input");

  const n = runs.length;
  const totals = runs.map((r) => r.result.total);
  const medianTotal = Math.round(median(totals));
  const std = n === 1 ? null : popStd(totals);

  const stability =
    n === 1 ? "single-shot" : (std as number) > STABILITY_STD_THRESHOLD ? "unstable" : "stable";

  // Per-dimension median.
  const dimKeys: (keyof RubricScores)[] = [
    "focal_point",
    "information_density",
    "information_hierarchy",
    "brand_consistency",
    "differentiation",
    "emotional_tone",
    "cta_clarity",
    "anti_ai_feel",
  ];
  const aggScores = {} as RubricScores;
  for (const k of dimKeys) {
    const xs = runs.map((r) => r.result.scores[k]);
    aggScores[k] = Math.round(median(xs));
  }

  // Representative run: closest total to the median; tie → lowest run_index.
  const representative = [...runs].sort((a, b) => {
    const da = Math.abs(a.result.total - medianTotal);
    const db = Math.abs(b.result.total - medianTotal);
    if (da !== db) return da - db;
    return a.run_index - b.run_index;
  })[0];

  // IP risk union: any flag → flagged. Concatenate distinct texts with " | ".
  const ipTexts = runs
    .map((r) => r.result.ip_or_legal_risk)
    .filter((x): x is string => !!x);
  const ipUnion =
    ipTexts.length === 0
      ? null
      : Array.from(new Set(ipTexts)).join(" | ");

  return {
    id: representative.id,
    filename: representative.filename,
    filepath: representative.filepath,
    scored_at: representative.scored_at,
    batch_id: representative.batch_id,
    batch_size: n,
    std_total: std,
    stability,
    result: {
      scores: aggScores,
      total: medianTotal,
      winning_hypothesis: representative.result.winning_hypothesis,
      failure_modes: representative.result.failure_modes,
      suggested_keywords_to_emphasize:
        representative.result.suggested_keywords_to_emphasize,
      suggested_keywords_to_remove:
        representative.result.suggested_keywords_to_remove,
      ip_or_legal_risk: ipUnion,
      verdict: verdictFromTotal(medianTotal),
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify all PASS**

Run:
```bash
cd ~/projects/ad-scorer && npm test
```

Expected: 10 tests PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/ad-scorer && git add src/aggregate.ts tests/aggregate.test.ts && git commit -m "feat: add aggregateBatch — median + std + representative-run + IP union"
```

---

## Task 7: Add `db.getAggregatedRecords(filterPathSubstring?)`

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.ts:270` area (the `rowToRecord` helper)

- [ ] **Step 1: Add a helper to build `RawRunRow` from a SQLite row**

In `src/db.ts`, after the existing `rowToRecord` method, add:

```ts
  private rowToRawRun(row: any): import("./types.js").RawRunRow {
    return {
      id: row.id,
      filename: row.filename,
      filepath: row.filepath,
      scored_at: row.scored_at,
      batch_id: row.batch_id,
      run_index: row.run_index ?? 0,
      result: {
        scores: {
          focal_point: row.focal_point,
          information_density: row.information_density,
          information_hierarchy: row.information_hierarchy,
          brand_consistency: row.brand_consistency,
          differentiation: row.differentiation,
          emotional_tone: row.emotional_tone,
          cta_clarity: row.cta_clarity,
          anti_ai_feel: row.anti_ai_feel,
        },
        total: row.total,
        winning_hypothesis: row.winning_hypothesis ?? "",
        failure_modes: JSON.parse(row.failure_modes_json || "[]"),
        suggested_keywords_to_emphasize: JSON.parse(
          row.keywords_emphasize_json || "[]"
        ),
        suggested_keywords_to_remove: JSON.parse(
          row.keywords_remove_json || "[]"
        ),
        ip_or_legal_risk: row.ip_or_legal_risk,
        verdict: row.verdict,
      },
    };
  }
```

- [ ] **Step 2: Add `getAggregatedRecords` method**

Add this method to the `ScoreDB` class in `src/db.ts` (place it near `getAll`):

```ts
  /**
   * Pull all rows (optionally filtered by filepath substring), group by
   * batch_id, and return one AggregatedRecord per batch.
   */
  getAggregatedRecords(
    filterPathSubstring?: string
  ): import("./types.js").AggregatedRecord[] {
    const sql = filterPathSubstring
      ? `SELECT * FROM scores WHERE filepath LIKE ? ORDER BY batch_id, run_index`
      : `SELECT * FROM scores ORDER BY batch_id, run_index`;
    const stmt = this.db.prepare(sql);
    const rows = (filterPathSubstring
      ? stmt.all(`%${filterPathSubstring}%`)
      : stmt.all()) as any[];

    const byBatch = new Map<string, import("./types.js").RawRunRow[]>();
    for (const row of rows) {
      const raw = this.rowToRawRun(row);
      const arr = byBatch.get(raw.batch_id) || [];
      arr.push(raw);
      byBatch.set(raw.batch_id, arr);
    }

    const out: import("./types.js").AggregatedRecord[] = [];
    for (const runs of byBatch.values()) {
      out.push(aggregateBatch(runs));
    }
    // Sort by total descending — matches existing report sort.
    out.sort((a, b) => b.result.total - a.result.total);
    return out;
  }
```

Add the top-level import at the top of `src/db.ts` (above the existing `import` block):

```ts
import { aggregateBatch } from "./aggregate.js";
```

`aggregate.ts` only imports types from `types.ts`, not from `db.ts`, so there is no circular dependency.

- [ ] **Step 3: Verify compile**

Run:
```bash
cd ~/projects/ad-scorer && npx tsc --noEmit
```

Expected: same single error about `db.insert` in `src/index.ts` (still pending Task 9). No new errors.

- [ ] **Step 4: Quick smoke test against current DB**

Run:
```bash
cd ~/projects/ad-scorer && npx tsx -e "
import { ScoreDB } from './src/db.js';
const db = new ScoreDB('./data/scores.db');
const rs = db.getAggregatedRecords();
console.log('aggregated count:', rs.length);
console.log('first 3:');
for (const r of rs.slice(0,3)) {
  console.log(\`  \${r.filename}  total=\${r.result.total}  std=\${r.std_total}  stability=\${r.stability}  batch_size=\${r.batch_size}\`);
}
db.close();
"
```

Expected: all current rows render as `single-shot` with `std=null` and `batch_size=1` (since all rows are legacy or single-run). Count should match `SELECT COUNT(*)` on scores.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/ad-scorer && git add src/db.ts && git commit -m "db: add getAggregatedRecords — group by batch_id, aggregate via aggregateBatch"
```

---

## Task 8: Add `scoreImageMultiShot` to `src/scorer.ts`

**Files:**
- Modify: `src/scorer.ts`

- [ ] **Step 1: Add the multi-shot method to the `Scorer` class**

In `src/scorer.ts`, add this method to the `Scorer` class (place after `scoreImage`):

```ts
  /**
   * Score one image N times in parallel. Returns the successful runs and any
   * errors. Caller decides whether to write to DB based on success count.
   */
  async scoreImageMultiShot(
    filepath: string,
    adType: AdType,
    n: number
  ): Promise<{
    runs: { result: ScoreResult; raw: string; model: string }[];
    errors: Error[];
  }> {
    const settled = await Promise.allSettled(
      Array.from({ length: n }, () => this.scoreImage(filepath, adType))
    );
    const runs: { result: ScoreResult; raw: string; model: string }[] = [];
    const errors: Error[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") runs.push(s.value);
      else errors.push(s.reason as Error);
    }
    return { runs, errors };
  }
```

- [ ] **Step 2: Verify compile**

Run:
```bash
cd ~/projects/ad-scorer && npx tsc --noEmit
```

Expected: same single `db.insert` error as before; no new errors.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/ad-scorer && git add src/scorer.ts && git commit -m "scorer: add scoreImageMultiShot — N parallel calls via Promise.allSettled"
```

---

## Task 9: Refactor `cmdScore` to use multi-shot + insertRun

**Files:**
- Modify: `src/index.ts:47-108` (the existing `cmdScore` function)

- [ ] **Step 1: Replace `cmdScore` with the multi-shot version**

In `src/index.ts`, replace the entire `cmdScore` function with:

```ts
async function cmdScore(args: string[]) {
  const target = args[0];
  if (!target) {
    console.error(
      "Usage: score <image-or-folder> [--runs N] [--force] [--model <model>] [--ad-type alphawalk|benchmark]"
    );
    process.exit(1);
  }
  const force = args.includes("--force");
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? args[modelIdx + 1] : DEFAULT_MODEL;

  const runsIdx = args.indexOf("--runs");
  const runsArg = runsIdx >= 0 ? parseInt(args[runsIdx + 1], 10) : 3;
  if (!Number.isInteger(runsArg) || runsArg < 1 || runsArg > 10) {
    console.error(`✗ Invalid --runs "${args[runsIdx + 1]}". Use an integer 1-10.`);
    process.exit(1);
  }
  const runs = runsArg;

  const adTypeIdx = args.indexOf("--ad-type");
  const adTypeFlag = adTypeIdx >= 0 ? args[adTypeIdx + 1] : undefined;
  if (adTypeFlag && adTypeFlag !== "alphawalk" && adTypeFlag !== "benchmark") {
    console.error(`✗ Invalid --ad-type "${adTypeFlag}". Use "alphawalk" or "benchmark".`);
    process.exit(1);
  }
  const explicitAdType = adTypeFlag as AdType | undefined;

  const images = collectImages(target);
  if (images.length === 0) {
    console.error(`✗ No supported images found at ${target}`);
    process.exit(1);
  }

  console.log(`Found ${images.length} image(s). Model: ${model}, runs/image: ${runs}\n`);

  const db = new ScoreDB(DEFAULT_DB_PATH);
  const scorer = new Scorer(getApiKey(), model, getBrand());
  const { aggregateBatch } = await import("./aggregate.js");
  const { randomUUID } = await import("crypto");

  let scored = 0;
  let skipped = 0;
  let failed = 0;

  for (const img of images) {
    const filename = path.basename(img);
    const hash = computeContentHash(img);
    if (!force && db.hasBatchByHash(hash, model)) {
      console.log(`⊝ ${filename} (already scored — use --force to rescore)`);
      skipped++;
      continue;
    }
    const adType: AdType =
      explicitAdType ?? (img.includes("/benchmarks/") ? "benchmark" : "alphawalk");

    process.stdout.write(`→ ${filename} [${adType}] runs=${runs} ... `);
    const { runs: results, errors } = await scorer.scoreImageMultiShot(img, adType, runs);

    if (results.length < 2 && runs >= 2) {
      console.log(`FAILED: only ${results.length}/${runs} runs succeeded; need ≥2. First error: ${errors[0]?.message ?? "n/a"}`);
      failed++;
      continue;
    }
    if (results.length === 0) {
      console.log(`FAILED: 0/${runs} runs succeeded. First error: ${errors[0]?.message ?? "n/a"}`);
      failed++;
      continue;
    }

    const batchId = randomUUID();
    const rawRuns = results.map((r, i) => {
      const id = db.insertRun(filename, img, hash, r.model, batchId, i, r.result, r.raw);
      return {
        id,
        filename,
        filepath: img,
        scored_at: "",
        batch_id: batchId,
        run_index: i,
        result: r.result,
      };
    });

    const agg = aggregateBatch(rawRuns);
    const stdStr = agg.std_total !== null ? `±${agg.std_total.toFixed(1)}` : "";
    const stabilityTag =
      agg.stability === "single-shot"
        ? "single-shot"
        : agg.stability === "unstable"
        ? "⚠️unstable"
        : "stable";
    const ipFlag = agg.result.ip_or_legal_risk ? " ⚠️ IP RISK" : "";
    console.log(
      `${agg.result.total}${stdStr}/40 [${agg.result.verdict}, ${stabilityTag}]${ipFlag} (batch ${batchId.slice(0, 6)}, ${results.length} runs)`
    );
    scored++;
  }

  console.log(`\n✓ Done. Scored ${scored}, skipped ${skipped}, failed ${failed}.`);
  db.close();
}
```

- [ ] **Step 2: Verify compile**

Run:
```bash
cd ~/projects/ad-scorer && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Smoke test on a single image with `--runs 1`**

Run (cheap mode — only 1 API call):
```bash
cd ~/projects/ad-scorer && npm run score ./creatives/benchmarks/competitor-monitoring/interactive-brokers/2026-04-30/1.png -- --runs 1 --force 2>&1 | tail -20
```

Expected output line like:
```
→ 1.png [benchmark] runs=1 ... 25.0/40 [candidate, single-shot] (batch abc123, 1 runs)
```

Verify a row was written with the new `batch_id`:
```bash
sqlite3 -column -header data/scores.db "SELECT id, filename, batch_id, run_index FROM scores ORDER BY id DESC LIMIT 3"
```

Expected: top row has a UUID-shaped `batch_id` and `run_index = 0`.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/ad-scorer && git add src/index.ts && git commit -m "feat: cmdScore uses --runs (default 3), batch_id per image, insertRun per surviving run"
```

---

## Task 10: Refactor read commands to use `getAggregatedRecords`

**Files:**
- Modify: `src/index.ts:110-220` (cmdReport, cmdWinners, cmdLosers, cmdStats, cmdKeywords)

- [ ] **Step 1: Update `cmdReport` to consume aggregated records**

In `src/index.ts`, find `cmdReport` and replace the line:
```ts
  const all = db.getAll();
  const records = filterPath ? all.filter((r) => r.filepath.includes(filterPath)) : all;
  const keywords = db.aggregateKeywords(filterPath);
```

with:
```ts
  const records = db.getAggregatedRecords(filterPath);
  const keywords = db.aggregateKeywords(filterPath);
```

(Note: `aggregateKeywords` already filters by path; it pulls raw rows, which means a single keyword appearing in N runs counts N times. We accept that for now — see Task 11 for the report-side dedup if needed. For the spec's "representative run only" behavior, we'd need to add a method `aggregateKeywordsFromBatches`. Defer that polish: in V1, keywords from N=3 runs of the same image just have proportionally higher weight, which roughly washes out across 21 images.)

The `generateHtmlReport(records, ...)` call is unchanged — it now receives `AggregatedRecord[]` which is structurally compatible (extends `ImageRecord` shape). The display additions come in Task 11.

- [ ] **Step 2: Update `cmdWinners` to use aggregated records**

Replace the existing `cmdWinners` body:

```ts
async function cmdWinners(args: string[]) {
  const n = parseInt(args[0] || "10", 10);
  const db = new ScoreDB(DEFAULT_DB_PATH);
  const all = db.getAggregatedRecords();
  const winners = all.slice(0, n); // already sorted by total desc
  console.log(`\nTop ${n} ads by score:\n`);
  for (const r of winners) {
    const stdStr = r.std_total !== null ? `±${r.std_total.toFixed(1)}` : "";
    const stabilityTag =
      r.stability === "single-shot" ? "单次" : r.stability === "unstable" ? "⚠️不稳定" : "稳定";
    console.log(
      `  ${r.result.total}${stdStr}/40 [${r.result.verdict.padEnd(9)}, ${stabilityTag}] ${r.filename}`
    );
    console.log(`    → ${r.result.winning_hypothesis}`);
  }
  db.close();
}
```

- [ ] **Step 3: Update `cmdLosers` similarly**

Replace the existing `cmdLosers` body:

```ts
async function cmdLosers(args: string[]) {
  const n = parseInt(args[0] || "10", 10);
  const db = new ScoreDB(DEFAULT_DB_PATH);
  const all = db.getAggregatedRecords();
  const losers = all.slice(-n).reverse(); // worst first
  console.log(`\nBottom ${n} ads by score:\n`);
  for (const r of losers) {
    const stdStr = r.std_total !== null ? `±${r.std_total.toFixed(1)}` : "";
    const stabilityTag =
      r.stability === "single-shot" ? "单次" : r.stability === "unstable" ? "⚠️不稳定" : "稳定";
    const ipBadge = r.result.ip_or_legal_risk ? " ⚠️" : "";
    console.log(
      `  ${r.result.total}${stdStr}/40 [${r.result.verdict.padEnd(9)}, ${stabilityTag}]${ipBadge} ${r.filename}`
    );
    if (r.result.failure_modes.length) {
      console.log(`    ✗ ${r.result.failure_modes.join("; ")}`);
    }
  }
  db.close();
}
```

- [ ] **Step 4: Update `cmdStats` to count aggregated records, including unstable count**

Replace the existing `cmdStats` body:

```ts
async function cmdStats() {
  const db = new ScoreDB(DEFAULT_DB_PATH);
  const records = db.getAggregatedRecords();
  const verdictCounts = { winner: 0, candidate: 0, reject: 0 };
  const stabilityCounts = { stable: 0, unstable: 0, "single-shot": 0 };
  let ipFlagged = 0;
  let totalSum = 0;
  const dimSums = {
    focal_point: 0,
    information_density: 0,
    information_hierarchy: 0,
    brand_consistency: 0,
    differentiation: 0,
    emotional_tone: 0,
    cta_clarity: 0,
    anti_ai_feel: 0,
  };
  for (const r of records) {
    verdictCounts[r.result.verdict]++;
    stabilityCounts[r.stability]++;
    if (r.result.ip_or_legal_risk) ipFlagged++;
    totalSum += r.result.total;
    for (const k of Object.keys(dimSums) as (keyof typeof dimSums)[]) {
      dimSums[k] += r.result.scores[k];
    }
  }
  const n = records.length || 1;
  console.log(`\nTotal aggregated batches: ${records.length}`);
  console.log(`IP risk flagged: ${ipFlagged}`);
  console.log(`\nVerdict breakdown:`);
  for (const [v, c] of Object.entries(verdictCounts)) console.log(`  ${v.padEnd(10)} ${c}`);
  console.log(`\nStability breakdown:`);
  for (const [s, c] of Object.entries(stabilityCounts)) console.log(`  ${s.padEnd(12)} ${c}`);
  console.log(`\nAverage scores (across batches):`);
  console.log(`  total              ${(totalSum / n).toFixed(2)} / 40`);
  for (const [k, sum] of Object.entries(dimSums)) {
    console.log(`  ${k.padEnd(18)} ${(sum / n).toFixed(2)} / 5`);
  }
  db.close();
}
```

- [ ] **Step 5: Leave `cmdKeywords` as-is for V1**

`aggregateKeywords` already takes a `filterPathSubstring`. Its raw-row source means N=3 runs over-weights phrases by 3×, but uniformly across all multi-shot images so the relative ranking is unchanged. Future polish: add `aggregateKeywordsFromBatches` that pulls only representative-run keyword JSON. For V1, accept current behavior.

- [ ] **Step 6: Verify compile**

```bash
cd ~/projects/ad-scorer && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 7: Smoke test winners + losers + stats**

```bash
cd ~/projects/ad-scorer && npm run winners 5 && echo "---" && npm run losers 5 && echo "---" && npm run stats
```

Expected:
- Winners list shows existing legacy + IB rows with `单次` tag (since all current data is single-shot).
- Stats shows new "Stability breakdown" section with all rows in `single-shot` bucket.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/ad-scorer && git add src/index.ts && git commit -m "feat: winners/losers/stats/report consume aggregated records with stability tags"
```

---

## Task 11: Update `report.ts` to render std + stability badge + 不稳定 stat

**Files:**
- Modify: `src/report.ts`

- [ ] **Step 1: Add Stability label map and update card rendering**

In `src/report.ts`, after the existing `DIMENSION_LABEL` constant, add:

```ts
const STABILITY_LABEL: Record<string, string> = {
  stable: "稳定",
  unstable: "⚠️ 不稳定",
  "single-shot": "单次",
};

const STABILITY_COLOR: Record<string, string> = {
  stable: "#10b981",
  unstable: "#f59e0b",
  "single-shot": "#6b7280",
};
```

- [ ] **Step 2: Update the card header to render `±std` and stability badge**

In `generateHtmlReport`, change the function signature to accept `AggregatedRecord[]`:

```ts
import { AggregatedRecord, KeywordAggregation } from "./types.js";
// ...
export function generateHtmlReport(
  records: AggregatedRecord[],
  keywords: KeywordAggregation[],
  outputPath: string
) {
```

In the card rendering, find:
```ts
              <span class="total" style="background:${verdictColor}">${r.result.total}/40 · ${verdictLabel}</span>
```

Replace with:
```ts
              <span class="total" style="background:${verdictColor}">${r.result.total}${r.std_total !== null ? `±${r.std_total.toFixed(1)}` : ""}/40 · ${verdictLabel}</span>
              <span class="stability" style="background:${STABILITY_COLOR[r.stability]}">${STABILITY_LABEL[r.stability]}</span>
```

In the `<style>` block, add (place near `.total`):
```css
  .stability { color: white; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; margin-left: 4px; }
```

- [ ] **Step 3: Add "不稳定" cell to summary stats**

Find the `<div class="summary">` block. After the IP风险警示 stat, add:

```ts
    <div class="stat"><div class="stat-label">不稳定</div><div class="stat-value" style="color:#f59e0b">${records.filter((r) => r.stability === "unstable").length}</div></div>
```

- [ ] **Step 4: Verify compile**

```bash
cd ~/projects/ad-scorer && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 5: Generate a report and visually inspect**

```bash
cd ~/projects/ad-scorer && npm run report -- --filter-path=competitor-monitoring/interactive-brokers/2026-04-30 && open reports/report-$(date +%Y-%m-%d).html
```

Expected: 21 cards, each card header shows total + 单次 grey badge (no ±std for single-shot data); summary stats grid has new 不稳定 cell showing 0.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/ad-scorer && git add src/report.ts && git commit -m "report: card shows ±std + stability badge; summary adds 不稳定 cell"
```

---

## Task 12: Update CLI usage docs

**Files:**
- Modify: `src/index.ts:225-260` area (the `cmdHelp` template literal)

- [ ] **Step 1: Update the `score` command usage**

In `src/index.ts`, find the help text:

```
  npm run score <image-or-folder> [--force] [--model <model>] [--ad-type alphawalk|benchmark]
```

Replace with:

```
  npm run score <image-or-folder> [--runs N] [--force] [--model <model>] [--ad-type alphawalk|benchmark]
      Score image(s) with N parallel Claude vision calls per image (default N=3).
      Aggregates via median; flags batches with std > 2.0 as "⚠️ unstable".
      --runs N     number of runs per image; 1 = cheap single-shot mode (default 3)
      --force      rescore even if previously scored (creates a new batch)
      --model      override model (default: ${DEFAULT_MODEL})
      --ad-type    "alphawalk" (default for normal paths) treats competitor logos as IP risk;
                   "benchmark" treats them as expected. Auto-set to "benchmark" when the
                   path contains /benchmarks/.
```

(Strip the duplicated `--force`/`--model`/`--ad-type` lines that may now appear below — make sure the final block has each flag once.)

- [ ] **Step 2: Add a multi-shot example**

In the `EXAMPLES:` block, add after the existing examples:

```
  npm run score ./creatives/2026-05-02/                   # default N=3
  npm run score ./creatives/2026-05-02/ -- --runs 1       # cheap probe
  npm run score ./creatives/draft.png -- --runs 5 --force # high-stakes review
```

- [ ] **Step 3: Verify the help renders**

```bash
cd ~/projects/ad-scorer && npx tsx src/index.ts help 2>&1 | head -40
```

Expected: new `--runs` line visible; examples section shows the three new lines.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/ad-scorer && git add src/index.ts && git commit -m "docs: cmdHelp documents --runs flag and adds multi-shot examples"
```

---

## Task 13: End-to-end verification on real IB batch

**Files:** None (verification only)

- [ ] **Step 1: Force-rescore the 21 IB images at default N=3**

This will burn ~63 API calls (~$1 at sonnet-4-6). Confirm before running:

```bash
cd ~/projects/ad-scorer && npm run score -- --force ./creatives/benchmarks/competitor-monitoring/interactive-brokers/2026-04-30/ 2>&1 | tail -30
```

Expected: 21 lines like `→ 1.png [benchmark] runs=3 ... 25.0±0.8/40 [candidate, stable] (batch abc123, 3 runs)`. Total wall time ~2-3 min.

- [ ] **Step 2: Verify DB now has a mix of single-shot legacy + 3-shot batches**

```bash
sqlite3 -column -header data/scores.db "
  SELECT batch_id, COUNT(*) as runs
  FROM scores
  WHERE filepath LIKE '%interactive-brokers/2026-04-30%'
  GROUP BY batch_id
  ORDER BY MIN(scored_at) DESC
  LIMIT 25
"
```

Expected: 21 batches with `runs=3` (the new ones) plus 21 batches with `runs=1` (the prior single-shot batches preserved).

- [ ] **Step 3: Generate report scoped to today's batch**

```bash
cd ~/projects/ad-scorer && npm run report -- --filter-path=competitor-monitoring/interactive-brokers/2026-04-30 && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="./reports/report-$(date +%Y-%m-%d)-zh-CN.pdf" "file://$HOME/projects/ad-scorer/reports/report-$(date +%Y-%m-%d).html" && open reports/report-$(date +%Y-%m-%d)-zh-CN.pdf
```

Expected:
- Report shows 42 cards (21 new 3-shot + 21 legacy single-shot, since both match the filter).
- New 3-shot cards have `25±0.8/40 · 候选 · 稳定` style header (or 不稳定).
- Legacy cards have `25/40 · 候选 · 单次` (no ±std, grey badge).
- Summary stats grid shows non-zero "不稳定" count if any batch had std > 2.0.

If you want only the new batches in the report, add a tighter filter (e.g. by date prefix on `scored_at` — out of scope for this plan, future improvement).

- [ ] **Step 4: Verify stats reflect the new aggregation**

```bash
cd ~/projects/ad-scorer && npm run stats
```

Expected: "Total aggregated batches" ~56 (was ~35 raw rows; now batches: 14 legacy + 21 IB single-shot legacy + 21 new 3-shot = 56). Stability breakdown shows the split.

- [ ] **Step 5: No commit needed** — verification only.

---

## Task 14: Update CLAUDE.md daily workflow section

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the "Daily ad scoring" workflow**

In `CLAUDE.md`, find the "Daily ad scoring" section. It currently shows:

```bash
npm run score ./creatives/$(date +%Y-%m-%d)/
npm run keywords 30
npm run report
open ./reports/report-$(date +%Y-%m-%d).html
```

Replace with:

```bash
# Default: 3 runs per image (more reliable scores, ~3x API cost)
npm run score ./creatives/$(date +%Y-%m-%d)/

# Cheap probe mode (single-shot, useful for early-day iteration)
# npm run score ./creatives/$(date +%Y-%m-%d)/ -- --runs 1

npm run keywords 30
npm run report -- --filter-path=$(date +%Y-%m-%d)
open ./reports/report-$(date +%Y-%m-%d).html
```

- [ ] **Step 2: Add a stability note to the "Failure modes to watch for" section**

Append this bullet to that section:

```markdown
- **Rubric noise** — if a batch comes back `⚠️ unstable` (std > 2.0 across N runs), the rubric is making an unsteady judgment on this image. Don't trust the median; either rescore at `--runs 5` or accept that this image is borderline.
```

- [ ] **Step 3: Commit**

```bash
cd ~/projects/ad-scorer && git add CLAUDE.md && git commit -m "docs: CLAUDE.md daily workflow + rubric noise failure mode"
```

---

## Self-review

**Spec coverage check:**

| Spec section | Implemented in task |
|--------------|---------------------|
| §1 Execution model (N parallel, sequential across images, ≥2 success threshold) | Task 8 (parallel) + Task 9 (sequential loop, ≥2 check) |
| §2 Aggregation rules (median, std, verdict from total, IP union, representative-run, stability=2.0) | Task 6 (TDD'd in `aggregate.ts`) |
| §3 Storage (ALTER TABLE, JS aggregation via `getAggregatedRecords`, `crypto.randomUUID`, batch_id per image) | Task 3 (schema) + Task 7 (read) + Task 9 (write) |
| §4 CLI (`--runs` default 3, `--force` semantics, `hasBatchByHash`, output format) | Task 5 + Task 9 + Task 12 |
| §5 Report integration (card header, stability badge, 不稳定 stat, `--filter-path` works) | Task 11 |
| §6 Migration (auto on next load, legacy backfill, IB rescore optional) | Task 3 (auto-migrate) + Task 13 (verify on IB) |

**Placeholder scan:** No "TBD"/"TODO"/"implement later" found. Each step has concrete code or commands.

**Type consistency:** `AggregatedRecord` defined in Task 2 with the exact shape consumed in Tasks 6, 7, 9, 10, 11. `RawRunRow` defined in Task 2, used in Tasks 6 and 7. Method names consistent: `insertRun` (Task 4 + 9), `hasBatchByHash` (Task 5 + 9), `getAggregatedRecords` (Task 7 + 10), `aggregateBatch` (Task 6 + 7 + 9).

**Known V1 limitations** (intentionally deferred per spec out-of-scope):
- `cmdKeywords` still aggregates over raw rows (3× weight on multi-shot phrases). Polish item.
- No `inspect-batch` CLI for raw-run dump.
- Per-dimension std not shown in report cards.
- Report can't filter by date alone (only by path substring); user can add date to path or use `scored_at` filter via SQL.

These match the spec's "Out of scope (deferred)" list.
