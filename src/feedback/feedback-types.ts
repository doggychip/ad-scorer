/**
 * Type definitions for the feedback module.
 *
 * These mirror what your existing `src/types.ts` and `src/db.ts` already
 * produce. If your column or property names differ slightly, only the
 * `loadCreativesInWindow` query in feedback.ts needs adjustment.
 */

export type Verdict = "approve" | "reject" | "review";

/**
 * The 8 dimensions ad-scorer's rubric scores against. If your rubric.ts
 * uses different names, edit this list — feedback.ts reads from it.
 */
export const DIMENSIONS = [
  "visual_hierarchy",
  "brand_consistency",
  "message_clarity",
  "emotional_resonance",
  "production_quality",
  "originality",
  "platform_fit",
  "ip_safety",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface ScoredCreative {
  id: string;
  imagePath: string;
  /** Free-text prompt used to generate this image. */
  prompt: string;
  /** Keywords parsed from the prompt (or stored separately). */
  keywords: string[];
  /** 0–10 per dimension. */
  scores: Record<Dimension, number>;
  /** 0–100 composite. */
  overallScore: number;
  verdict: Verdict;
  /** ISO timestamp. */
  scoredAt: string;
  /** Optional scorer notes/critique text. */
  notes?: string;
  /** Optional flagged IP risks. */
  ipFlags?: string[];
}

export interface KeywordStat {
  keyword: string;
  /** How much above (positive) or below (negative) the batch mean a creative
   *  using this keyword scored, on average. */
  delta: number;
  avgScore: number;
  occurrences: number;
}

export interface FeedbackInputs {
  windowStart: string;
  windowEnd: string;
  totalScored: number;
  approvalRate: number;
  rejectionRate: number;
  meanOverall: number;
  /** Mean per-dimension score across the window. */
  dimensionAverages: Record<Dimension, number>;
  /** Best-performing keywords (positive delta, sorted desc). */
  emphasize: KeywordStat[];
  /** Worst-performing keywords (negative delta, sorted asc). */
  remove: KeywordStat[];
  /** Top creatives in the window (highest overallScore). */
  topCreatives: ScoredCreative[];
  /** Bottom creatives in the window (lowest overallScore). */
  bottomCreatives: ScoredCreative[];
  /** Trend deltas vs prior comparable window, if available. */
  trends?: {
    overallDelta: number;
    dimensionDeltas: Partial<Record<Dimension, number>>;
  };
}
