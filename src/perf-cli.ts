// src/perf-cli.ts
// CLI entry for performance correlation analysis.
// Wire into package.json:
//   "perf:correlate": "tsx src/perf-cli.ts correlate",
//   "perf:overrated": "tsx src/perf-cli.ts overrated",
//   "perf:underrated": "tsx src/perf-cli.ts underrated",
//   "perf:import": "tsx src/perf-cli.ts import"

import "dotenv/config";
import { PerformanceDB, importMetaCsv } from "./performance.js";

const DB_PATH = process.env.DB_PATH || "./data/scores.db";

function cmdCorrelate(args: string[]) {
  const metric = (args[0] || "ctr") as "ctr" | "cvr" | "cac_usd" | "cpc_usd";
  const db = new PerformanceDB(DB_PATH);
  const results = db.correlateRubricWithMetric(metric);

  console.log(`\nRubric dimension correlation with ${metric.toUpperCase()}\n`);
  console.log("Pearson r ranges from -1 (inverse) to +1 (perfect predictor).");
  console.log("|r| > 0.5 = strong, 0.3-0.5 = moderate, < 0.3 = weak/noise.\n");

  // Sort by absolute correlation
  results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  for (const { dimension, correlation, n } of results) {
    if (isNaN(correlation)) {
      console.log(`  ${dimension.padEnd(22)} insufficient data (n=${n})`);
      continue;
    }
    const r = correlation;
    const bar = "█".repeat(Math.round(Math.abs(r) * 20));
    const sign = r >= 0 ? "+" : "-";
    const strength = Math.abs(r) > 0.5 ? "STRONG" : Math.abs(r) > 0.3 ? "moderate" : "weak";
    console.log(
      `  ${dimension.padEnd(22)} ${sign}${Math.abs(r).toFixed(3)} ${bar.padEnd(20)} ${strength} (n=${n})`
    );
  }

  console.log(`\nInterpretation:`);
  console.log(`- Dimensions with HIGH +correlation predict ${metric} — keep weighting them in rubric`);
  console.log(`- Dimensions near 0 are NOT predictive — consider removing or rewriting`);
  console.log(`- Dimensions with NEGATIVE correlation are MISCALIBRATED — your rubric punishes things the market rewards\n`);

  db.close();
}

function cmdOverrated(args: string[]) {
  const metric = (args[0] || "ctr") as "ctr" | "cvr";
  const db = new PerformanceDB(DB_PATH);
  const rows = db.findOverratedAds(metric);
  console.log(`\nAds where scorer rated HIGH but ${metric.toUpperCase()} is LOW (overfit / blind spot):\n`);
  for (const r of rows) {
    console.log(`  ${r.total}/40 [${r.verdict}] ${metric}=${r.metric_value.toFixed(4)}  ${r.filename}`);
  }
  console.log(`\nThese ads suggest the rubric overweights design qualities the market doesn't reward.`);
  db.close();
}

function cmdUnderrated(args: string[]) {
  const metric = (args[0] || "ctr") as "ctr" | "cvr";
  const db = new PerformanceDB(DB_PATH);
  const rows = db.findUnderratedAds(metric);
  console.log(`\nAds where scorer rated LOW but ${metric.toUpperCase()} is HIGH (rubric blind spot):\n`);
  for (const r of rows) {
    console.log(`  ${r.total}/40 [${r.verdict}] ${metric}=${r.metric_value.toFixed(4)}  ${r.filename}`);
  }
  console.log(`\nThese are the most important rows — review what the rubric missed.`);
  db.close();
}

function cmdImport(args: string[]) {
  const csvPath = args[0];
  if (!csvPath) {
    console.error("Usage: perf:import <csv-path>");
    process.exit(1);
  }
  const db = new PerformanceDB(DB_PATH);
  const result = importMetaCsv(csvPath, db);
  console.log(`Imported ${result.inserted}, skipped ${result.skipped}`);
  db.close();
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "correlate": cmdCorrelate(args); break;
  case "overrated": cmdOverrated(args); break;
  case "underrated": cmdUnderrated(args); break;
  case "import": cmdImport(args); break;
  default:
    console.log(`
Usage:
  perf:import <csv>           Import Meta/TikTok CSV export
  perf:correlate [metric]     Correlate rubric dimensions vs metric (ctr|cvr|cac_usd|cpc_usd)
  perf:overrated [metric]     Show ads scorer overrated relative to performance
  perf:underrated [metric]    Show ads scorer underrated (rubric blind spots)
`);
}
