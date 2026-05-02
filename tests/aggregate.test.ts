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
