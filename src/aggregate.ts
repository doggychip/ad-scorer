import { AggregatedRecord, RawRunRow, RubricScores, Stability, Verdict } from "./types.js";

// Threshold above which a multi-shot batch is flagged "⚠️ unstable".
// Empirically calibrated against the 21-image IB benchmark (most stable batches
// σ<1.5; flagged 9.png at σ≈2.2). Override via STABILITY_STD_THRESHOLD env var
// to tune after a few weeks of production data.
const STABILITY_STD_THRESHOLD = (() => {
  const raw = process.env.STABILITY_STD_THRESHOLD;
  if (!raw) return 2.0;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2.0;
})();

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

const STABILITY_LABEL_ZH: Record<Stability, string> = {
  stable: "稳定",
  unstable: "⚠️ 不稳定",
  "single-shot": "单次",
};

const STABILITY_LABEL_EN: Record<Stability, string> = {
  stable: "stable",
  unstable: "⚠️unstable",
  "single-shot": "single-shot",
};

/** Stability badge text. `locale` controls Chinese (default for reports/CLI display) vs English (live-progress in cmdScore). */
export function formatStability(s: Stability, locale: "zh" | "en" = "zh"): string {
  return locale === "en" ? STABILITY_LABEL_EN[s] : STABILITY_LABEL_ZH[s];
}
