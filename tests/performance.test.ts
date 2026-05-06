import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ScoreDB } from "../src/db.js";
import { PerformanceDB, pearson } from "../src/performance.js";
import type { ScoreResult } from "../src/types.js";

function mkResult(total: number, dims?: Partial<ScoreResult["scores"]>): ScoreResult {
  const base = {
    focal_point: 4,
    information_density: 4,
    information_hierarchy: 4,
    brand_consistency: 3,
    differentiation: 3,
    emotional_tone: 3,
    cta_clarity: 3,
    anti_ai_feel: total - 24, // sum to total
  };
  return {
    scores: { ...base, ...dims },
    total,
    winning_hypothesis: `hyp-${total}`,
    failure_modes: [],
    suggested_keywords_to_emphasize: [],
    suggested_keywords_to_remove: [],
    ip_or_legal_risk: null,
    verdict: total >= 28 ? "winner" : total >= 22 ? "candidate" : "reject",
  };
}

/** Insert a multi-shot batch (N runs sharing batch_id) for one image, return
 *  the run_index=0 (canonical) row id — this is what perf-import resolves
 *  filenames to and writes into performance.ad_id. */
function insertBatch(
  scores: ScoreDB,
  filename: string,
  batchId: string,
  totals: number[],
  dimsPerRun?: Partial<ScoreResult["scores"]>[]
): number {
  let canonicalId = 0;
  scores.transaction(() => {
    totals.forEach((t, i) => {
      const id = scores.insertRun(
        filename,
        `/p/${filename}`,
        `hash-${filename}-${i}`,
        "claude-sonnet-4-6",
        batchId,
        i,
        mkResult(t, dimsPerRun?.[i]),
        "{}"
      );
      if (i === 0) canonicalId = id;
    });
  });
  return canonicalId;
}

function insertPerf(
  perf: PerformanceDB,
  adId: number,
  ctr: number,
  cvr = 0,
  cac_usd = 0,
  cpc_usd = 0
) {
  perf.insert({
    ad_id: adId,
    external_ad_id: `ext-${adId}`,
    platform: "meta",
    campaign: "",
    date_range_start: "2026-05-01",
    date_range_end: "2026-05-07",
    impressions: 10000,
    clicks: Math.round(10000 * ctr),
    ctr,
    spend_usd: 100,
    conversions: Math.round(10000 * ctr * cvr),
    cvr,
    cpc_usd,
    cac_usd,
    notes: null,
  });
}

describe("pearson", () => {
  it("perfect positive correlation = 1", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
  });

  it("perfect negative correlation = -1", () => {
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it("zero variance in either input → NaN (intentional, signals constant rubric)", () => {
    expect(pearson([3, 3, 3, 3], [1, 2, 3, 4])).toBeNaN();
    expect(pearson([1, 2, 3, 4], [5, 5, 5, 5])).toBeNaN();
  });

  it("n<2 → NaN", () => {
    expect(pearson([1], [2])).toBeNaN();
    expect(pearson([], [])).toBeNaN();
  });

  it("mismatched length → NaN", () => {
    expect(pearson([1, 2, 3], [1, 2])).toBeNaN();
  });

  it("known moderate correlation matches reference", () => {
    // xs=[1,2,3,4,5] mean=3 → dx=[-2,-1,0,1,2]   Σdx² = 10
    // ys=[2,1,4,3,5] mean=3 → dy=[-1,-2,1,0,2]   Σdy² = 10
    // Σdx*dy = 2+2+0+0+4 = 8 → r = 8/sqrt(100) = 0.8
    expect(pearson([1, 2, 3, 4, 5], [2, 1, 4, 3, 5])).toBeCloseTo(0.8, 6);
  });
});

describe("PerformanceDB correlation (multi-shot aware)", () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-scorer-test-"));
    dbPath = path.join(dbDir, "scores.db");
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("uses median across multi-shot batch, not the canonical run_index=0 row", () => {
    const scores = new ScoreDB(dbPath);
    // Image A — totals 30/30/30 (median 30, winner)
    const aId = insertBatch(scores, "a.jpg", "batch-a", [30, 30, 30]);
    // Image B — canonical run was an outlier 30, but the other two runs are 18/18 → median 18 (reject)
    const bId = insertBatch(scores, "b.jpg", "batch-b", [30, 18, 18]);
    scores.close();

    const perf = new PerformanceDB(dbPath);
    insertPerf(perf, aId, 0.05); // strong CTR for the genuine winner
    insertPerf(perf, bId, 0.005); // weak CTR for the actual reject

    const joined = perf.loadJoined("ctr");
    const aPair = joined.find((j) => j.aggregated.filename === "a.jpg")!;
    const bPair = joined.find((j) => j.aggregated.filename === "b.jpg")!;
    expect(aPair.aggregated.result.total).toBe(30); // median
    expect(bPair.aggregated.result.total).toBe(18); // median, NOT 30
    perf.close();
  });

  it("correlation aggregates per batch, returns Pearson per dimension + total", () => {
    const scores = new ScoreDB(dbPath);
    // Six batches with monotonically increasing totals & CTR → strong positive correlation
    const ads: { id: number; ctr: number }[] = [];
    const totals = [16, 20, 24, 28, 32, 36];
    for (let i = 0; i < totals.length; i++) {
      const id = insertBatch(scores, `img-${i}.jpg`, `batch-${i}`, [totals[i], totals[i], totals[i]]);
      ads.push({ id, ctr: 0.01 + i * 0.01 });
    }
    scores.close();

    const perf = new PerformanceDB(dbPath);
    for (const a of ads) insertPerf(perf, a.id, a.ctr);

    const results = perf.correlateRubricWithMetric("ctr");
    const totalRow = results.find((r) => r.dimension === "total")!;
    expect(totalRow.n).toBe(6);
    expect(totalRow.correlation).toBeCloseTo(1, 4);

    // Every expected dimension is present
    const dims = results.map((r) => r.dimension).sort();
    expect(dims).toEqual(
      [
        "anti_ai_feel",
        "brand_consistency",
        "cta_clarity",
        "differentiation",
        "emotional_tone",
        "focal_point",
        "information_density",
        "information_hierarchy",
        "total",
      ].sort()
    );

    perf.close();
  });

  it("findOverratedAds: scorer high, performance low — uses aggregated total", () => {
    const scores = new ScoreDB(dbPath);
    const goodId = insertBatch(scores, "good.jpg", "b1", [32, 32, 32]); // winner, real CTR good
    const overratedId = insertBatch(scores, "over.jpg", "b2", [30, 30, 30]); // winner per rubric, weak CTR
    const lowId = insertBatch(scores, "low.jpg", "b3", [18, 18, 18]); // reject, ignored by overrated query
    scores.close();

    const perf = new PerformanceDB(dbPath);
    insertPerf(perf, goodId, 0.05);
    insertPerf(perf, overratedId, 0.002);
    insertPerf(perf, lowId, 0.04);

    const over = perf.findOverratedAds("ctr", 28);
    expect(over.length).toBe(2);
    // Lowest CTR among the high-rated ads comes first
    expect(over[0].filename).toBe("over.jpg");
    expect(over[0].total).toBe(30);
    expect(over[1].filename).toBe("good.jpg");
    perf.close();
  });

  it("findUnderratedAds: scorer low, performance high — sorted by metric desc", () => {
    const scores = new ScoreDB(dbPath);
    const a = insertBatch(scores, "a.jpg", "b1", [18, 18, 18]); // reject, surprise winner
    const b = insertBatch(scores, "b.jpg", "b2", [16, 16, 16]); // reject, also strong CTR
    const c = insertBatch(scores, "c.jpg", "b3", [30, 30, 30]); // winner, ignored
    scores.close();

    const perf = new PerformanceDB(dbPath);
    insertPerf(perf, a, 0.04);
    insertPerf(perf, b, 0.06);
    insertPerf(perf, c, 0.05);

    const under = perf.findUnderratedAds("ctr", 20);
    expect(under.length).toBe(2);
    expect(under[0].filename).toBe("b.jpg"); // higher CTR first
    expect(under[1].filename).toBe("a.jpg");
    perf.close();
  });

  it("returns empty/NaN-only results when no perf data is joined", () => {
    const scores = new ScoreDB(dbPath);
    insertBatch(scores, "a.jpg", "b1", [30, 30, 30]);
    scores.close();

    const perf = new PerformanceDB(dbPath);
    const results = perf.correlateRubricWithMetric("ctr");
    expect(results.every((r) => r.n === 0 && Number.isNaN(r.correlation))).toBe(true);
    expect(perf.findOverratedAds("ctr")).toEqual([]);
    expect(perf.findUnderratedAds("ctr")).toEqual([]);
    perf.close();
  });

  it("averages multiple performance rows for the same ad_id (weekly imports stack)", () => {
    const scores = new ScoreDB(dbPath);
    const id = insertBatch(scores, "a.jpg", "b1", [28, 28, 28]);
    scores.close();

    const perf = new PerformanceDB(dbPath);
    insertPerf(perf, id, 0.02);
    insertPerf(perf, id, 0.04); // second week's data for same ad → avg 0.03

    const joined = perf.loadJoined("ctr");
    expect(joined.length).toBe(1);
    expect(joined[0].metric_value).toBeCloseTo(0.03, 6);
    perf.close();
  });
});
