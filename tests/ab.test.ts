import { describe, it, expect } from "vitest";
import { compareAbBatches, formatComparison, meanAndSE } from "../src/ab.js";
import type { AggregatedRecord, RubricScores } from "../src/types.js";

function mkRecord(
  total: number,
  opts: {
    label?: string;
    stability?: AggregatedRecord["stability"];
    ip?: string | null;
    dims?: Partial<RubricScores>;
  } = {}
): AggregatedRecord {
  const baseDims: RubricScores = {
    focal_point: 4,
    information_density: 4,
    information_hierarchy: 4,
    brand_consistency: 3,
    differentiation: 3,
    emotional_tone: 3,
    cta_clarity: 3,
    anti_ai_feel: total - 24,
  };
  const scores = { ...baseDims, ...opts.dims };
  return {
    id: 1,
    filename: opts.label || `f-${total}.jpg`,
    filepath: `/p/${opts.label || `f-${total}.jpg`}`,
    scored_at: "2026-05-06 12:00:00",
    batch_id: `b-${opts.label || total}`,
    batch_size: 3,
    std_total: 0.8,
    stability: opts.stability ?? "stable",
    result: {
      scores,
      total,
      winning_hypothesis: "h",
      failure_modes: [],
      suggested_keywords_to_emphasize: [],
      suggested_keywords_to_remove: [],
      ip_or_legal_risk: opts.ip ?? null,
      verdict: total >= 28 ? "winner" : total >= 22 ? "candidate" : "reject",
    },
  };
}

describe("meanAndSE", () => {
  it("empty input → mean 0, se 0", () => {
    expect(meanAndSE([])).toEqual({ mean: 0, se: 0 });
  });

  it("single value → mean = value, se 0 (no variance estimable)", () => {
    expect(meanAndSE([7])).toEqual({ mean: 7, se: 0 });
  });

  it("two equal values → se 0", () => {
    expect(meanAndSE([3, 3])).toEqual({ mean: 3, se: 0 });
  });

  it("known sample → mean and se via (n-1) variance", () => {
    // xs=[10,20] mean=15, deviations ±5 → Σ²=50, sample variance=50/(n-1)=50,
    // sd=√50≈7.071, se=sd/√n=7.071/√2 = 5.
    const { mean, se } = meanAndSE([10, 20]);
    expect(mean).toBeCloseTo(15, 6);
    expect(se).toBeCloseTo(5, 6);
  });
});

describe("compareAbBatches", () => {
  it("identical batches → zero deltas, n equal", () => {
    const a = [mkRecord(28), mkRecord(28), mkRecord(28)];
    const b = [mkRecord(28), mkRecord(28), mkRecord(28)];
    const cmp = compareAbBatches(a, b);
    expect(cmp.delta.total).toBeCloseTo(0, 6);
    expect(cmp.a.totalMean).toBeCloseTo(28, 6);
    expect(cmp.b.totalMean).toBeCloseTo(28, 6);
    for (const d of Object.values(cmp.delta.perDim)) expect(d).toBeCloseTo(0, 6);
  });

  it("Δ_total reflects mean difference (B − A)", () => {
    const a = [mkRecord(20), mkRecord(22), mkRecord(24)]; // mean 22
    const b = [mkRecord(28), mkRecord(30), mkRecord(32)]; // mean 30
    const cmp = compareAbBatches(a, b);
    expect(cmp.a.totalMean).toBeCloseTo(22, 6);
    expect(cmp.b.totalMean).toBeCloseTo(30, 6);
    expect(cmp.delta.total).toBeCloseTo(8, 6);
  });

  it("per-dim deltas pick up dimension-specific moves", () => {
    const a = [mkRecord(28, { dims: { differentiation: 2 } })];
    const b = [mkRecord(28, { dims: { differentiation: 5 } })];
    const cmp = compareAbBatches(a, b);
    expect(cmp.delta.perDim.differentiation).toBeCloseTo(3, 6);
    expect(cmp.delta.perDim.focal_point).toBeCloseTo(0, 6);
  });

  it("underpowered=true when either side has n<10", () => {
    const a = Array.from({ length: 5 }, () => mkRecord(28));
    const b = Array.from({ length: 12 }, () => mkRecord(28));
    expect(compareAbBatches(a, b).underpowered).toBe(true);
    const a2 = Array.from({ length: 12 }, () => mkRecord(28));
    expect(compareAbBatches(a2, b).underpowered).toBe(false);
  });

  it("SE of difference combines variants quadratically", () => {
    // Construct synthetic: A has SE 0.5, B has SE 1.0 → SE_delta = sqrt(0.25 + 1.0) = sqrt(1.25)
    const seA = 0.5;
    const seB = 1.0;
    // We can't construct exact SE without solving for the sample; instead
    // verify the math via the public path: feed records, compute, check SE
    // satisfies the quadratic-sum relation.
    const a = Array.from({ length: 9 }, (_, i) => mkRecord(20 + (i % 3)));
    const b = Array.from({ length: 9 }, (_, i) => mkRecord(30 + (i % 3)));
    const cmp = compareAbBatches(a, b);
    const expectedSe = Math.sqrt(cmp.a.totalSE ** 2 + cmp.b.totalSE ** 2);
    expect(cmp.delta.totalSE).toBeCloseTo(expectedSe, 8);
    void seA;
    void seB;
  });

  it("counts winners, unstable, IP-flagged per variant", () => {
    const a = [
      mkRecord(30, { stability: "stable" }),
      mkRecord(20, { stability: "unstable" }),
      mkRecord(25, { ip: "Genshin character" }),
    ];
    const b = [mkRecord(32), mkRecord(34)];
    const cmp = compareAbBatches(a, b);
    expect(cmp.a.winnerCount).toBe(1);
    expect(cmp.a.unstableCount).toBe(1);
    expect(cmp.a.ipFlagged).toBe(1);
    expect(cmp.b.winnerCount).toBe(2);
    expect(cmp.b.unstableCount).toBe(0);
    expect(cmp.b.ipFlagged).toBe(0);
  });

  it("empty variant: n=0, totalMean=0, doesn't crash", () => {
    const cmp = compareAbBatches([], [mkRecord(28)]);
    expect(cmp.a.n).toBe(0);
    expect(cmp.a.totalMean).toBe(0);
    expect(cmp.b.totalMean).toBeCloseTo(28, 6);
    expect(cmp.underpowered).toBe(true);
  });
});

describe("formatComparison", () => {
  it("prints Δ row with sign and includes underpowered warning when n<10", () => {
    const a = [mkRecord(24), mkRecord(26)];
    const b = [mkRecord(28), mkRecord(30)];
    const cmp = compareAbBatches(a, b);
    const out = formatComparison(cmp, "test-concept");
    expect(out).toContain("test-concept");
    expect(out).toContain("Variant A (n=2)");
    expect(out).toContain("Variant B (n=2)");
    expect(out).toContain("Δ (B − A):");
    expect(out).toContain("+4.00"); // total delta = (29-25) = 4
    expect(out).toContain("n<10");
  });

  it("emits the noise-floor note when |Δ_total| < SE", () => {
    // A and B both varied → SE > 0; means very close → |Δ| < SE
    const a = [mkRecord(26), mkRecord(28), mkRecord(30)];
    const b = [mkRecord(26), mkRecord(28), mkRecord(30)];
    const cmp = compareAbBatches(a, b);
    const out = formatComparison(cmp);
    expect(out).toMatch(/within run-to-run noise/);
  });

  it("handles an empty variant gracefully", () => {
    const out = formatComparison(compareAbBatches([], [mkRecord(30)]));
    expect(out).toContain("Variant A (n=0)");
    expect(out).toContain("(no scored images found for this variant)");
  });
});
