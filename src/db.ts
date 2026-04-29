// SQLite persistence for score history + keyword aggregation
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { ScoreResult, ImageRecord, KeywordAggregation } from "./types.js";

export class ScoreDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        scored_at TEXT NOT NULL DEFAULT (datetime('now')),
        focal_point INTEGER NOT NULL,
        information_density INTEGER NOT NULL,
        information_hierarchy INTEGER NOT NULL,
        brand_consistency INTEGER NOT NULL,
        differentiation INTEGER NOT NULL,
        emotional_tone INTEGER NOT NULL,
        cta_clarity INTEGER NOT NULL,
        anti_ai_feel INTEGER NOT NULL,
        total INTEGER NOT NULL,
        winning_hypothesis TEXT,
        failure_modes_json TEXT,
        keywords_emphasize_json TEXT,
        keywords_remove_json TEXT,
        ip_or_legal_risk TEXT,
        verdict TEXT NOT NULL,
        raw_response TEXT,
        notes TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_total ON scores(total DESC);
      CREATE INDEX IF NOT EXISTS idx_scored_at ON scores(scored_at DESC);
      CREATE INDEX IF NOT EXISTS idx_verdict ON scores(verdict);
      CREATE INDEX IF NOT EXISTS idx_filename ON scores(filename);
    `);
  }

  insert(filename: string, filepath: string, result: ScoreResult, raw: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO scores (
        filename, filepath,
        focal_point, information_density, information_hierarchy,
        brand_consistency, differentiation, emotional_tone,
        cta_clarity, anti_ai_feel, total,
        winning_hypothesis, failure_modes_json,
        keywords_emphasize_json, keywords_remove_json,
        ip_or_legal_risk, verdict, raw_response
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const info = stmt.run(
      filename,
      filepath,
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

  /** Check if a file at this path has been scored (by filepath) */
  hasScored(filepath: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM scores WHERE filepath = ? LIMIT 1`).get(filepath);
    return !!row;
  }

  getById(id: number): ImageRecord | null {
    const row = this.db.prepare(`SELECT * FROM scores WHERE id = ?`).get(id) as any;
    return row ? this.rowToRecord(row) : null;
  }

  getTopN(n: number, verdict?: string): ImageRecord[] {
    const sql = verdict
      ? `SELECT * FROM scores WHERE verdict = ? ORDER BY total DESC LIMIT ?`
      : `SELECT * FROM scores ORDER BY total DESC LIMIT ?`;
    const rows = verdict
      ? (this.db.prepare(sql).all(verdict, n) as any[])
      : (this.db.prepare(sql).all(n) as any[]);
    return rows.map((r) => this.rowToRecord(r));
  }

  getBottomN(n: number): ImageRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM scores ORDER BY total ASC LIMIT ?`)
      .all(n) as any[];
    return rows.map((r) => this.rowToRecord(r));
  }

  getAll(): ImageRecord[] {
    const rows = this.db.prepare(`SELECT * FROM scores ORDER BY scored_at DESC`).all() as any[];
    return rows.map((r) => this.rowToRecord(r));
  }

  getStats() {
    const total = (this.db.prepare(`SELECT COUNT(*) as n FROM scores`).get() as any).n;
    const verdictCounts = this.db
      .prepare(`SELECT verdict, COUNT(*) as n FROM scores GROUP BY verdict`)
      .all() as { verdict: string; n: number }[];
    const avgRow = this.db
      .prepare(`SELECT
        AVG(total) as avg_total,
        AVG(focal_point) as avg_focal,
        AVG(information_density) as avg_density,
        AVG(information_hierarchy) as avg_hierarchy,
        AVG(brand_consistency) as avg_brand,
        AVG(differentiation) as avg_diff,
        AVG(emotional_tone) as avg_emotion,
        AVG(cta_clarity) as avg_cta,
        AVG(anti_ai_feel) as avg_antiai
        FROM scores`)
      .get() as any;
    const ipRiskCount = (this.db
      .prepare(`SELECT COUNT(*) as n FROM scores WHERE ip_or_legal_risk IS NOT NULL`)
      .get() as any).n;
    return { total, verdictCounts, averages: avgRow, ipRiskCount };
  }

  /** Aggregate keyword feedback across all scored ads — the core feedback loop */
  aggregateKeywords(): KeywordAggregation[] {
    const rows = this.db
      .prepare(`SELECT keywords_emphasize_json, keywords_remove_json, total FROM scores`)
      .all() as { keywords_emphasize_json: string; keywords_remove_json: string; total: number }[];

    const map = new Map<
      string,
      { emphasize: number; remove: number; totalSum: number; totalCount: number }
    >();

    for (const row of rows) {
      const empPhrases: string[] = JSON.parse(row.keywords_emphasize_json || "[]");
      const remPhrases: string[] = JSON.parse(row.keywords_remove_json || "[]");
      const all = new Set([...empPhrases, ...remPhrases].map((s) => s.toLowerCase().trim()));

      for (const phrase of all) {
        if (!phrase) continue;
        const cur = map.get(phrase) || { emphasize: 0, remove: 0, totalSum: 0, totalCount: 0 };
        if (empPhrases.some((p) => p.toLowerCase().trim() === phrase)) cur.emphasize++;
        if (remPhrases.some((p) => p.toLowerCase().trim() === phrase)) cur.remove++;
        cur.totalSum += row.total;
        cur.totalCount += 1;
        map.set(phrase, cur);
      }
    }

    const result: KeywordAggregation[] = [];
    for (const [keyword, v] of map.entries()) {
      result.push({
        keyword,
        emphasize_count: v.emphasize,
        remove_count: v.remove,
        net_score: v.emphasize - v.remove,
        avg_total_when_present: v.totalCount > 0 ? v.totalSum / v.totalCount : 0,
      });
    }
    result.sort((a, b) => b.net_score - a.net_score);
    return result;
  }

  private rowToRecord(row: any): ImageRecord {
    return {
      id: row.id,
      filename: row.filename,
      filepath: row.filepath,
      scored_at: row.scored_at,
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
        winning_hypothesis: row.winning_hypothesis || "",
        failure_modes: JSON.parse(row.failure_modes_json || "[]"),
        suggested_keywords_to_emphasize: JSON.parse(row.keywords_emphasize_json || "[]"),
        suggested_keywords_to_remove: JSON.parse(row.keywords_remove_json || "[]"),
        ip_or_legal_risk: row.ip_or_legal_risk,
        verdict: row.verdict,
      },
    };
  }

  close() {
    this.db.close();
  }
}
