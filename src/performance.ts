// src/performance.ts
// Performance data join + rubric correlation analysis.
//
// PURPOSE: Connect scorer rubric ratings to actual ad platform performance
// (Meta/TikTok/Google CTR, CVR, CPC, CAC). Validates which rubric dimensions
// actually predict ROI vs which are just design-school taste.
//
// USAGE:
//   1. Score an ad before launch:        npm run score
//   2. Export weekly perf from Meta/TikTok ad manager (CSV)
//   3. Import:                            npm run perf:import <csv>
//   4. Correlate rubric vs performance:   npm run perf:correlate [ctr|cvr|cac_usd|cpc_usd]
//
// MULTI-SHOT NOTE: The scorer runs N=3 shots per image and aggregates via
// median (see aggregate.ts). Performance correlation operates on the
// aggregated batch — NOT a single run — so the rubric values used here match
// what the rest of the pipeline (reports, winners/losers, keywords) sees.
// Joining on raw `scores.id` would silently use only the canonical
// run_index=0 row's per-dimension scores, which is noisier than the median.
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { aggregateBatch } from "./aggregate.js";
import type { AggregatedRecord, RawRunRow } from "./types.js";

export interface PerformanceRecord {
  ad_id: number;                  // foreign key to scores.id
  external_ad_id: string;         // Meta/TikTok ad ID
  platform: "meta" | "tiktok" | "google" | "other";
  campaign: string;
  date_range_start: string;       // ISO date
  date_range_end: string;
  impressions: number;
  clicks: number;
  ctr: number;                    // clicks / impressions
  spend_usd: number;
  conversions: number;            // trial signups
  cvr: number;                    // conversions / clicks
  cpc_usd: number;                // spend / clicks
  cac_usd: number;                // spend / conversions
  notes: string | null;
}

export type PerformanceMetric = "ctr" | "cvr" | "cac_usd" | "cpc_usd";

export interface CorrelationResult {
  dimension: string;
  correlation: number;
  n: number;
}

export interface OverUnderRow {
  id: number;
  filename: string;
  total: number;
  verdict: string;
  metric_value: number;
}

/** Rubric dimensions correlated against performance. `total` is the summed
 *  rubric score; the other 8 are individual dimensions. Order is the same
 *  one the scorer rubric returns. */
const DIMENSIONS = [
  "focal_point",
  "information_density",
  "information_hierarchy",
  "brand_consistency",
  "differentiation",
  "emotional_tone",
  "cta_clarity",
  "anti_ai_feel",
  "total",
] as const;
type DimensionKey = (typeof DIMENSIONS)[number];

function rowToRawRun(row: any): RawRunRow {
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

function dimValue(rec: AggregatedRecord, dim: DimensionKey): number {
  if (dim === "total") return rec.result.total;
  return rec.result.scores[dim];
}

export class PerformanceDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ad_id INTEGER NOT NULL,
        external_ad_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        campaign TEXT,
        date_range_start TEXT NOT NULL,
        date_range_end TEXT NOT NULL,
        impressions INTEGER NOT NULL,
        clicks INTEGER NOT NULL,
        ctr REAL NOT NULL,
        spend_usd REAL NOT NULL,
        conversions INTEGER NOT NULL,
        cvr REAL,
        cpc_usd REAL,
        cac_usd REAL,
        notes TEXT,
        imported_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (ad_id) REFERENCES scores(id)
      );

      CREATE INDEX IF NOT EXISTS idx_perf_ad_id ON performance(ad_id);
      CREATE INDEX IF NOT EXISTS idx_perf_platform ON performance(platform);
      CREATE INDEX IF NOT EXISTS idx_perf_date ON performance(date_range_start);
    `);
  }

  insert(record: Omit<PerformanceRecord, "id">) {
    return this.db
      .prepare(`
        INSERT INTO performance (
          ad_id, external_ad_id, platform, campaign,
          date_range_start, date_range_end,
          impressions, clicks, ctr, spend_usd,
          conversions, cvr, cpc_usd, cac_usd, notes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .run(
        record.ad_id, record.external_ad_id, record.platform, record.campaign,
        record.date_range_start, record.date_range_end,
        record.impressions, record.clicks, record.ctr, record.spend_usd,
        record.conversions, record.cvr, record.cpc_usd, record.cac_usd,
        record.notes
      );
  }

  /**
   * Find ad_id by filename (matches scores.filename). Returns the canonical
   * run_index=0 row id for the most recent batch with that filename — keeps
   * importer behavior deterministic when an image was rescored across
   * multiple batches.
   */
  findAdIdByFilename(filename: string): number | null {
    const row = this.db
      .prepare(
        `SELECT id FROM scores WHERE filename = ? OR filename LIKE ?
         ORDER BY run_index ASC, scored_at DESC LIMIT 1`
      )
      .get(filename, `%${filename}%`) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /**
   * Pull every batch that has at least one matching performance row, return
   * its aggregated (median) rubric values paired with the avg performance
   * metric over the batch's perf rows.
   *
   * Pairing: perf.ad_id was set by perf-import to the canonical row of the
   * batch (run_index=0); we look up that row's batch_id and aggregate the
   * full N-shot batch — so correlation reflects the same median scores the
   * rest of the pipeline (winners/losers/reports) reasons about.
   */
  loadJoined(metric: PerformanceMetric): {
    aggregated: AggregatedRecord;
    metric_value: number;
  }[] {
    // 1. Per-ad_id metric average (perf rows can repeat for one ad across weeks)
    const perfRows = this.db
      .prepare(
        `SELECT ad_id, AVG(${metric}) as metric_value
         FROM performance
         WHERE ${metric} IS NOT NULL
         GROUP BY ad_id`
      )
      .all() as { ad_id: number; metric_value: number }[];
    if (perfRows.length === 0) return [];

    // 2. Resolve ad_id → batch_id
    const adIds = perfRows.map((p) => p.ad_id);
    const placeholders = adIds.map(() => "?").join(",");
    const batchIdRows = this.db
      .prepare(`SELECT id, batch_id FROM scores WHERE id IN (${placeholders})`)
      .all(...adIds) as { id: number; batch_id: string }[];
    const idToBatchId = new Map<number, string>(
      batchIdRows.map((r) => [r.id, r.batch_id])
    );

    const batchIds = Array.from(
      new Set(batchIdRows.map((r) => r.batch_id).filter((b) => b != null))
    );
    if (batchIds.length === 0) return [];

    // 3. Pull every run for those batches and aggregate per batch
    const batchPlaceholders = batchIds.map(() => "?").join(",");
    const runRows = this.db
      .prepare(
        `SELECT * FROM scores WHERE batch_id IN (${batchPlaceholders})
         ORDER BY batch_id, run_index`
      )
      .all(...batchIds) as any[];
    const byBatch = new Map<string, RawRunRow[]>();
    for (const row of runRows) {
      const raw = rowToRawRun(row);
      const arr = byBatch.get(raw.batch_id) || [];
      arr.push(raw);
      byBatch.set(raw.batch_id, arr);
    }
    const batchToAgg = new Map<string, AggregatedRecord>();
    for (const [bid, runs] of byBatch.entries()) {
      batchToAgg.set(bid, aggregateBatch(runs));
    }

    // 4. Pair perf rows to their batch's aggregated record
    const out: { aggregated: AggregatedRecord; metric_value: number }[] = [];
    for (const p of perfRows) {
      const bid = idToBatchId.get(p.ad_id);
      if (!bid) continue;
      const agg = batchToAgg.get(bid);
      if (!agg) continue;
      out.push({ aggregated: agg, metric_value: p.metric_value });
    }
    return out;
  }

  /**
   * Pearson correlation between each rubric dimension and a performance metric.
   * Operates on aggregated (median) batch scores — see loadJoined().
   */
  correlateRubricWithMetric(metric: PerformanceMetric): CorrelationResult[] {
    const joined = this.loadJoined(metric);

    if (joined.length < 5) {
      console.warn(
        `Only ${joined.length} ads with both score and performance data. ` +
          `Need >=5 for any signal, >=30 for stable correlation. Keep importing.`
      );
    }

    return DIMENSIONS.map((dim) => ({
      dimension: dim,
      correlation: pearson(
        joined.map((j) => dimValue(j.aggregated, dim)),
        joined.map((j) => j.metric_value)
      ),
      n: joined.length,
    }));
  }

  /** Ads where scorer rated highly (aggregated total >= threshold) but
   *  performance is poor — overfit / blind-spot signal. */
  findOverratedAds(metric: "ctr" | "cvr" = "ctr", thresholdScore = 28): OverUnderRow[] {
    const joined = this.loadJoined(metric);
    return joined
      .filter((j) => j.aggregated.result.total >= thresholdScore)
      .sort((a, b) => a.metric_value - b.metric_value)
      .slice(0, 10)
      .map((j) => ({
        id: j.aggregated.id,
        filename: j.aggregated.filename,
        total: j.aggregated.result.total,
        verdict: j.aggregated.result.verdict,
        metric_value: j.metric_value,
      }));
  }

  /** Ads where scorer rated poorly (aggregated total <= threshold) but
   *  performance is great — rubric blind spot. The most actionable bucket. */
  findUnderratedAds(metric: "ctr" | "cvr" = "ctr", thresholdScore = 20): OverUnderRow[] {
    const joined = this.loadJoined(metric);
    return joined
      .filter((j) => j.aggregated.result.total <= thresholdScore)
      .sort((a, b) => b.metric_value - a.metric_value)
      .slice(0, 10)
      .map((j) => ({
        id: j.aggregated.id,
        filename: j.aggregated.filename,
        total: j.aggregated.result.total,
        verdict: j.aggregated.result.verdict,
        metric_value: j.metric_value,
      }));
  }

  close() { this.db.close(); }
}

/**
 * Pearson correlation coefficient.
 *
 * Returns NaN when input has zero variance — this is intentional, not a bug.
 * If you see NaN for n>5, the rubric is probably giving constant scores
 * across diverse samples (signals rubric overfitting / lack of discrimination).
 */
export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return NaN;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? NaN : num / den;
}
