/**
 * Adapter: my AggregatedRecord (8 dims, 0-5 scale, winner/candidate/reject)
 *  → feedback module's ScoredCreative (8 dims, 0-10 scale, approve/review/reject).
 *
 * Path A from the integration plan: my src/types.ts and src/db.ts stay
 * untouched; the feedback module operates on the translated shape.
 *
 * Caveats (review the resulting markdown with these in mind):
 *   - Module's dimension labels (visual_hierarchy, message_clarity, etc.) are
 *     re-mapped from my dimensions but the names don't 1-1 match. The mapping
 *     below is best-effort. `information_density` has no good module analog
 *     and is dropped.
 *   - Module re-classifies keywords as KEEP / AVOID via score-lift, ignoring
 *     my pre-classified suggested_keywords_to_emphasize / _remove. Both
 *     classifications go in as a single `keywords` array.
 *   - `prompt` is synthesized from winning_hypothesis + failure_modes since
 *     my schema doesn't store the actual gen prompt.
 *   - `overallScore` = total * 2.5 (rescale 0-40 → 0-100).
 */
import { ScoreDB } from "../db.js";
import type { AggregatedRecord, RubricScores } from "../types.js";
import {
  DIMENSIONS,
  type Dimension,
  type ScoredCreative,
  type Verdict as ModuleVerdict,
} from "./feedback-types.js";

/** Verdict translation: my 3-bucket → module's 3-bucket. */
function mapVerdict(v: AggregatedRecord["result"]["verdict"]): ModuleVerdict {
  switch (v) {
    case "winner":
      return "approve";
    case "candidate":
      return "review";
    case "reject":
      return "reject";
  }
}

/** My dim (0-5) → module's dim (0-10), best-effort by semantic proximity. */
function mapScores(s: RubricScores): Record<Dimension, number> {
  const ipSafety = 10; // Adjusted at call site if record has ip_or_legal_risk.
  const out: Record<Dimension, number> = {
    visual_hierarchy: s.information_hierarchy * 2,
    brand_consistency: s.brand_consistency * 2,
    message_clarity: s.cta_clarity * 2,
    emotional_resonance: s.emotional_tone * 2,
    production_quality: s.anti_ai_feel * 2,
    originality: s.differentiation * 2,
    platform_fit: s.focal_point * 2,
    ip_safety: ipSafety,
  };
  // Sanity: every dim listed by module is filled.
  for (const d of DIMENSIONS) {
    if (!(d in out)) throw new Error(`adapter: missing dim ${d}`);
  }
  return out;
}

function synthesizePrompt(r: AggregatedRecord): string {
  const wh = r.result.winning_hypothesis?.trim() ?? "";
  const fm = (r.result.failure_modes ?? []).join("; ").trim();
  if (wh && fm) return `${wh} || failures: ${fm}`;
  return wh || fm || "(no prompt text in scorer output)";
}

function ipFlagsFromRecord(r: AggregatedRecord): string[] | undefined {
  const raw = r.result.ip_or_legal_risk;
  if (!raw) return undefined;
  // The aggregator joins multiple flag texts with " | ".
  return raw.split(" | ").map((s) => s.trim()).filter(Boolean);
}

export function adaptAggregatedRecord(r: AggregatedRecord): ScoredCreative {
  const scores = mapScores(r.result.scores);
  const ipFlags = ipFlagsFromRecord(r);
  if (ipFlags && ipFlags.length > 0) {
    scores.ip_safety = 0; // Module's ip_safety = 10 if no risk, 0 if any.
  }
  const keywords = [
    ...(r.result.suggested_keywords_to_emphasize ?? []),
    ...(r.result.suggested_keywords_to_remove ?? []),
  ];
  return {
    id: String(r.id),
    imagePath: r.filepath,
    prompt: synthesizePrompt(r),
    keywords,
    scores,
    overallScore: r.result.total * 2.5, // 0-40 → 0-100
    verdict: mapVerdict(r.result.verdict),
    scoredAt: r.scored_at,
    ipFlags,
  };
}

/** Pull all aggregated records from the DB and translate. Caller filters by
 *  date window in JS (DB stores scored_at as text; window comparisons via
 *  Date are simpler than parameterizing the SQL through the existing
 *  getAggregatedRecords API). */
export function loadCreativesInWindow(
  dbPath: string,
  startInclusive: string,
  endExclusive: string
): ScoredCreative[] {
  const db = new ScoreDB(dbPath);
  try {
    const all = db.getAggregatedRecords();
    const start = new Date(startInclusive).getTime();
    const end = new Date(endExclusive).getTime();
    return all
      .filter((r) => {
        if (!r.scored_at) return false;
        const t = new Date(r.scored_at).getTime();
        return Number.isFinite(t) && t >= start && t < end;
      })
      .map(adaptAggregatedRecord);
  } finally {
    db.close();
  }
}
