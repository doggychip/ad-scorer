// src/perf-import.ts
// Generic CSV importer for the agreed performance schema.
//
// Required CSV columns:
//   ad_filename      — must match scores.filename exactly
//   external_ad_id   — platform's ad ID
//   platform         — meta | tiktok | google | other
//   date_start       — ISO date YYYY-MM-DD
//   date_end         — ISO date YYYY-MM-DD
//   impressions      — integer
//   clicks           — integer
//   spend_usd        — float
//   conversions      — integer
// Optional:
//   notes            — free text

import "dotenv/config";
import fs from "fs";
import { PerformanceDB } from "./performance.js";
import Database from "better-sqlite3";

const DB_PATH = process.env.DB_PATH || "./data/scores.db";

interface CsvRow {
  ad_filename: string;
  external_ad_id: string;
  platform: string;
  date_start: string;
  date_end: string;
  impressions: string;
  clicks: string;
  spend_usd: string;
  conversions: string;
  notes?: string;
}

function normalizePlatform(s: string): "meta" | "tiktok" | "google" | "other" {
  const lower = s.toLowerCase();
  if (lower === "meta" || lower === "tiktok" || lower === "google") return lower;
  return "other";
}

function parseCsv(content: string): CsvRow[] {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSV needs at least a header row + 1 data row");

  // Simple CSV parser — handles quoted fields with commas inside.
  // For production use a real CSV lib, but this works for clean Meta exports.
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (c === "," && !inQuote) {
        out.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const headers = parseLine(lines[0]).map((h) => h.toLowerCase().replace(/[\s_]+/g, "_"));
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseLine(lines[i]);
    const row: any = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ""; });
    rows.push(row as CsvRow);
  }
  return rows;
}

function importCsv(csvPath: string): { inserted: number; skipped: number; errors: string[] } {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  const content = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCsv(content);

  const perfDb = new PerformanceDB(DB_PATH);
  // We need a separate scores DB connection to look up filename → ad_id
  const scoresDb = new Database(DB_PATH, { readonly: true });
  // Use run_index=0 as the canonical representative for the batch when
  // joining performance data (Meta/TikTok CSVs key on filename, not batch_id).
  // With multi-shot scoring (N>=2 default), multiple rows share a filename;
  // without ORDER BY, .get() returned an arbitrary row and performance JOINs
  // silently dropped N-1 rows per batch. ORDER BY run_index ASC LIMIT 1 makes
  // the join deterministic.
  const lookupStmt = scoresDb.prepare(
    `SELECT id FROM scores WHERE filename = ? ORDER BY run_index ASC LIMIT 1`
  );

  const required = [
    "ad_filename", "external_ad_id", "platform",
    "date_start", "date_end",
    "impressions", "clicks", "spend_usd", "conversions",
  ];

  const errors: string[] = [];
  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    // Validate required fields present
    const missing = required.filter((k) => !(row as any)[k]);
    if (missing.length) {
      errors.push(`row "${row.ad_filename || "?"}" missing: ${missing.join(", ")}`);
      skipped++;
      continue;
    }

    // Lookup ad_id by filename
    const match = lookupStmt.get(row.ad_filename) as { id: number } | undefined;
    if (!match) {
      errors.push(
        `row "${row.ad_filename}" — no matching score in DB (was this ad scored before launch?)`
      );
      skipped++;
      continue;
    }

    // Parse numeric fields
    const impressions = parseInt(row.impressions, 10);
    const clicks = parseInt(row.clicks, 10);
    const spend_usd = parseFloat(row.spend_usd);
    const conversions = parseInt(row.conversions, 10);

    if ([impressions, clicks, spend_usd, conversions].some((n) => isNaN(n))) {
      errors.push(`row "${row.ad_filename}" — non-numeric data in metric columns`);
      skipped++;
      continue;
    }

    // Derive metrics — code computes these, never trust manual entry
    const ctr = impressions > 0 ? clicks / impressions : 0;
    const cvr = clicks > 0 ? conversions / clicks : 0;
    const cpc_usd = clicks > 0 ? spend_usd / clicks : 0;
    const cac_usd = conversions > 0 ? spend_usd / conversions : 0;

    perfDb.insert({
      ad_id: match.id,
      external_ad_id: row.external_ad_id,
      platform: normalizePlatform(row.platform),
      campaign: row.notes || "",
      date_range_start: row.date_start,
      date_range_end: row.date_end,
      impressions,
      clicks,
      ctr,
      spend_usd,
      conversions,
      cvr,
      cpc_usd,
      cac_usd,
      notes: row.notes ?? null,
    });
    inserted++;
  }

  scoresDb.close();
  perfDb.close();
  return { inserted, skipped, errors };
}

// CLI
const csvPath = process.argv[2];
if (!csvPath) {
  console.error(`
Usage: npm run perf:import <csv-path>

CSV format (required columns):
  ad_filename, external_ad_id, platform, date_start, date_end,
  impressions, clicks, spend_usd, conversions
Optional: notes

Example row:
  20260429-163034.jpg,123456789,meta,2026-05-01,2026-05-07,15234,287,42.50,9,"Q2 test"
`);
  process.exit(1);
}

console.log(`Importing ${csvPath}...`);
const result = importCsv(csvPath);
console.log(`\n✓ Inserted ${result.inserted}, skipped ${result.skipped}`);
if (result.errors.length) {
  console.log(`\nErrors:`);
  for (const e of result.errors) console.log(`  - ${e}`);
}
