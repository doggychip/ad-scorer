// src/performance.ts
// Performance data join + rubric correlation analysis.
//
// PURPOSE: Connect scorer rubric ratings to actual ad platform performance
// (Meta/TikTok/Google CTR, CVR, CPC, CAC). Validates which rubric dimensions
// actually predict ROI vs which are just design-school taste.
//
// USAGE: This is the SKELETON — schema + queries are real, but data ingestion
// from ad platforms is stubbed. When you have CSV exports from Meta/TikTok,
// drop them in ./data/performance/ and run `npm run perf:import <csv>`.
//
// The 3-4 week plan:
// 1. Run scorer on every ad before it goes live (already working)
// 2. Each week, export performance from Meta/TikTok ad manager (CSV)
// 3. Import via `npm run perf:import` — joins to scores by ad name/filename
// 4. Run `npm run perf:correlate` weekly — see which rubric dimensions
//    correlate with CTR / CVR / CAC
// 5. Use that signal to rebalance rubric weights or rewrite prompts

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

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
   * Find ad_id by filename (matches scores.filename).
   * When importing from Meta/TikTok, you'll usually have ad_name that you
   * can map to filename. Adjust the matching logic here as needed.
   */
  findAdIdByFilename(filename: string): number | null {
    // ORDER BY run_index ASC LIMIT 1: with multi-shot scoring, multiple rows
    // share the same filename. Always return the canonical run_index=0 row so
    // callers get a deterministic id rather than an arbitrary batch member.
    const row = this.db
      .prepare(
        `SELECT id FROM scores WHERE filename = ? OR filename LIKE ?
         ORDER BY run_index ASC LIMIT 1`
      )
      .get(filename, `%${filename}%`) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /**
   * Compute Pearson correlation between each rubric dimension and a performance metric.
   * This is the core "is the rubric scientific" question.
   */
  correlateRubricWithMetric(
    metric: "ctr" | "cvr" | "cac_usd" | "cpc_usd"
  ): { dimension: string; correlation: number; n: number }[] {
    // Pull joined data
    const rows = this.db
      .prepare(`
        SELECT
          s.focal_point, s.information_density, s.information_hierarchy,
          s.brand_consistency, s.differentiation, s.emotional_tone,
          s.cta_clarity, s.anti_ai_feel, s.total,
          AVG(p.${metric}) as metric_value
        FROM scores s
        INNER JOIN performance p ON p.ad_id = s.id
        WHERE p.${metric} IS NOT NULL
        GROUP BY s.id
      `)
      .all() as any[];

    if (rows.length < 5) {
      console.warn(
        `Only ${rows.length} ads with both score and performance data. ` +
          `Need ≥5 for any signal, ≥30 for stable correlation. Keep importing.`
      );
    }

    const dimensions = [
      "focal_point", "information_density", "information_hierarchy",
      "brand_consistency", "differentiation", "emotional_tone",
      "cta_clarity", "anti_ai_feel", "total",
    ];

    return dimensions.map((dim) => ({
      dimension: dim,
      correlation: pearson(
        rows.map((r) => r[dim]),
        rows.map((r) => r.metric_value)
      ),
      n: rows.length,
    }));
  }

  /** Show ads where scorer rated highly but performance is poor (overfit signal) */
  findOverratedAds(metric: "ctr" | "cvr" = "ctr", threshold_score = 28) {
    return this.db
      .prepare(`
        SELECT
          s.id, s.filename, s.total, s.verdict,
          AVG(p.${metric}) as metric_value
        FROM scores s
        INNER JOIN performance p ON p.ad_id = s.id
        WHERE s.total >= ?
        GROUP BY s.id
        ORDER BY metric_value ASC
        LIMIT 10
      `)
      .all(threshold_score) as any[];
  }

  /** Show ads where scorer rated poorly but performance is great (rubric blind spot) */
  findUnderratedAds(metric: "ctr" | "cvr" = "ctr", threshold_score = 20) {
    return this.db
      .prepare(`
        SELECT
          s.id, s.filename, s.total, s.verdict,
          AVG(p.${metric}) as metric_value
        FROM scores s
        INNER JOIN performance p ON p.ad_id = s.id
        WHERE s.total <= ?
        GROUP BY s.id
        ORDER BY metric_value DESC
        LIMIT 10
      `)
      .all(threshold_score) as any[];
  }

  close() { this.db.close(); }
}

/**
 * Pearson correlation coefficient.
 *
 * Returns NaN when input has zero variance — this is intentional, not a bug.
 * If you see "insufficient data" for n>5, check if the rubric is giving
 * constant scores across diverse samples (signals rubric overfitting / lack
 * of discrimination).
 */
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
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

// ============================================================
// CSV import — stub. Adapt to actual Meta/TikTok export schema.
// ============================================================

export interface MetaCsvRow {
  "Ad Name": string;
  "Ad ID": string;
  "Campaign Name": string;
  "Reporting Starts": string;
  "Reporting Ends": string;
  Impressions: string;
  "Link Clicks": string;
  CTR: string;
  "Amount Spent (USD)": string;
  "Results": string;
}

/**
 * Parse a Meta Ads Manager CSV export and insert rows.
 * Adjust column mapping when you see the actual export.
 */
export function importMetaCsv(csvPath: string, db: PerformanceDB): { inserted: number; skipped: number } {
  // Stub — implement when you have a real Meta export sample.
  // The flow: parse CSV → for each row, find ad_id by filename match → insert.
  console.warn(`importMetaCsv: stub. Implement after first Meta export.`);
  return { inserted: 0, skipped: 0 };
}
