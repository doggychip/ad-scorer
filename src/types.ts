// Shared types for the ad scorer pipeline

export interface RubricScores {
  focal_point: number;          // 0-5: ONE clear focal point in 3 seconds?
  information_density: number;   // 0-5: ≤3 competing elements? (PPT病 detector)
  information_hierarchy: number; // 0-5: brand → headline → CTA tiered?
  brand_consistency: number;     // 0-5: distinctively this brand?
  differentiation: number;       // 0-5: cover logo — still recognizable?
  emotional_tone: number;        // 0-5: matches brand archetype?
  cta_clarity: number;           // 0-5: user knows next action?
  anti_ai_feel: number;          // 0-5: avoids generic AI-generated aesthetic?
}

export type Verdict = "winner" | "candidate" | "reject";

export interface ScoreResult {
  scores: RubricScores;
  total: number;                                  // sum 0-40
  winning_hypothesis: string;                     // what makes it work, if anything
  failure_modes: string[];                        // what's wrong
  suggested_keywords_to_emphasize: string[];      // feed back to gen pipeline
  suggested_keywords_to_remove: string[];         // negative prompts
  ip_or_legal_risk: string | null;                // copyright/trademark warnings
  verdict: Verdict;
}

export interface ImageRecord {
  id: number;
  filename: string;
  filepath: string;
  scored_at: string;
  result: ScoreResult;
}

export interface KeywordAggregation {
  keyword: string;
  emphasize_count: number;   // times suggested as winner-pattern
  remove_count: number;      // times suggested as anti-pattern
  net_score: number;         // emphasize - remove
  avg_total_when_present: number; // average rubric score for ads where this appeared
}

export type Stability = "stable" | "unstable" | "single-shot";

/** A representative record summarizing one batch (one image's N runs).
 *  `id` is the representative run's row id (the run whose total is closest
 *  to the median). `result` is the aggregated ScoreResult: per-dimension
 *  median, total = median of run totals, IP risk = union of any flagged texts.
 */
export interface AggregatedRecord extends ImageRecord {
  /** Standard deviation of the N totals. null when batch_size === 1. */
  std_total: number | null;
  batch_id: string;
  batch_size: number;
  stability: Stability;
}

/** Shape of a single raw row used as input to aggregation. */
export interface RawRunRow extends ImageRecord {
  batch_id: string;
  run_index: number;
}
