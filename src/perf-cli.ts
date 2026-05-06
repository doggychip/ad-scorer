// src/perf-cli.ts
// CLI entry for performance correlation analysis.
// Wired into package.json:
//   "perf:correlate":  "tsx src/perf-cli.ts correlate",
//   "perf:overrated":  "tsx src/perf-cli.ts overrated",
//   "perf:underrated": "tsx src/perf-cli.ts underrated",
//   "perf:import":     "tsx src/perf-import.ts"  (import lives in perf-import.ts)

import "dotenv/config";
import { PerformanceDB, PerformanceMetric } from "./performance.js";

const DB_PATH = process.env.DB_PATH || "./data/scores.db";
const VALID_METRICS: PerformanceMetric[] = ["ctr", "cvr", "cac_usd", "cpc_usd"];

function parseMetric(raw: string | undefined, fallback: PerformanceMetric): PerformanceMetric {
  if (!raw) return fallback;
  if ((VALID_METRICS as string[]).includes(raw)) return raw as PerformanceMetric;
  console.error(`✗ Unknown metric "${raw}". Use one of: ${VALID_METRICS.join(", ")}`);
  process.exit(1);
}

function cmdCorrelate(args: string[]) {
  const metric = parseMetric(args[0], "ctr");
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
  console.log(`- HIGH +correlation predicts ${metric} — keep weighting in rubric`);
  console.log(`- Near 0 = NOT predictive — consider removing or rewriting`);
  console.log(`- NEGATIVE = MISCALIBRATED — rubric punishes what the market rewards\n`);

  db.close();
}

function cmdOverrated(args: string[]) {
  const metricRaw = parseMetric(args[0], "ctr");
  if (metricRaw !== "ctr" && metricRaw !== "cvr") {
    console.error(`✗ overrated/underrated only supports ctr or cvr (got ${metricRaw})`);
    process.exit(1);
  }
  const db = new PerformanceDB(DB_PATH);
  const rows = db.findOverratedAds(metricRaw);
  console.log(`\nAds where scorer rated HIGH but ${metricRaw.toUpperCase()} is LOW (overfit / blind spot):\n`);
  for (const r of rows) {
    console.log(`  ${r.total}/40 [${r.verdict}] ${metricRaw}=${r.metric_value.toFixed(4)}  ${r.filename}`);
  }
  console.log(`\nThese ads suggest the rubric overweights design qualities the market doesn't reward.`);
  db.close();
}

function cmdUnderrated(args: string[]) {
  const metricRaw = parseMetric(args[0], "ctr");
  if (metricRaw !== "ctr" && metricRaw !== "cvr") {
    console.error(`✗ overrated/underrated only supports ctr or cvr (got ${metricRaw})`);
    process.exit(1);
  }
  const db = new PerformanceDB(DB_PATH);
  const rows = db.findUnderratedAds(metricRaw);
  console.log(`\nAds where scorer rated LOW but ${metricRaw.toUpperCase()} is HIGH (rubric blind spot):\n`);
  for (const r of rows) {
    console.log(`  ${r.total}/40 [${r.verdict}] ${metricRaw}=${r.metric_value.toFixed(4)}  ${r.filename}`);
  }
  console.log(`\nThese are the most important rows — review what the rubric missed.`);
  db.close();
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "correlate": cmdCorrelate(args); break;
  case "overrated": cmdOverrated(args); break;
  case "underrated": cmdUnderrated(args); break;
  default:
    console.log(`
Usage:
  npm run perf:import <csv>           Import Meta/TikTok CSV export (see src/perf-import.ts)
  npm run perf:correlate [metric]     Correlate rubric dimensions vs metric (ctr|cvr|cac_usd|cpc_usd)
  npm run perf:overrated [metric]     Show ads scorer overrated relative to performance (ctr|cvr)
  npm run perf:underrated [metric]    Show ads scorer underrated (rubric blind spots) (ctr|cvr)
`);
}
