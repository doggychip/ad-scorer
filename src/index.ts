// CLI entry point
import "dotenv/config";
import fs from "fs";
import path from "path";
import { ScoreDB, computeContentHash } from "./db.js";
import { Scorer } from "./scorer.js";
import { AdType } from "./rubric.js";
import { generateHtmlReport, generateCsv } from "./report.js";

const DEFAULT_DB_PATH = process.env.DB_PATH || "./data/scores.db";
const DEFAULT_MODEL = process.env.SCORER_MODEL || "claude-sonnet-4-6";

function getBrand() {
  return {
    brandName: process.env.BRAND_NAME || "Alphawalk.ai",
    brandTagline: process.env.BRAND_TAGLINE || "Your AI Investment Assistant",
    brandColors: process.env.BRAND_COLORS || "purple,gold",
    brandArchetype:
      process.env.BRAND_ARCHETYPE ||
      "sophisticated, confident, focused — financial product for retail investors",
  };
}

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("✗ ANTHROPIC_API_KEY not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  return key;
}

function collectImages(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return Scorer.isSupportedImage(target) ? [path.resolve(target)] : [];
  }
  if (stat.isDirectory()) {
    return fs
      .readdirSync(target)
      .map((f) => path.resolve(target, f))
      .filter((f) => fs.statSync(f).isFile() && Scorer.isSupportedImage(f));
  }
  return [];
}

async function cmdScore(args: string[]) {
  const target = args[0];
  if (!target) {
    console.error(
      "Usage: score <image-or-folder> [--runs N] [--force] [--model <model>] [--ad-type alphawalk|benchmark]"
    );
    process.exit(1);
  }
  const force = args.includes("--force");
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? args[modelIdx + 1] : DEFAULT_MODEL;

  const runsIdx = args.indexOf("--runs");
  const runsArg = runsIdx >= 0 ? parseInt(args[runsIdx + 1], 10) : 3;
  if (!Number.isInteger(runsArg) || runsArg < 1 || runsArg > 10) {
    console.error(`✗ Invalid --runs "${args[runsIdx + 1]}". Use an integer 1-10.`);
    process.exit(1);
  }
  const runs = runsArg;

  const adTypeIdx = args.indexOf("--ad-type");
  const adTypeFlag = adTypeIdx >= 0 ? args[adTypeIdx + 1] : undefined;
  if (adTypeFlag && adTypeFlag !== "alphawalk" && adTypeFlag !== "benchmark") {
    console.error(`✗ Invalid --ad-type "${adTypeFlag}". Use "alphawalk" or "benchmark".`);
    process.exit(1);
  }
  const explicitAdType = adTypeFlag as AdType | undefined;

  const images = collectImages(target);
  if (images.length === 0) {
    console.error(`✗ No supported images found at ${target}`);
    process.exit(1);
  }

  console.log(`Found ${images.length} image(s). Model: ${model}, runs/image: ${runs}\n`);

  const db = new ScoreDB(DEFAULT_DB_PATH);
  const scorer = new Scorer(getApiKey(), model, getBrand());
  const { aggregateBatch } = await import("./aggregate.js");
  const { randomUUID } = await import("crypto");

  let scored = 0;
  let skipped = 0;
  let failed = 0;

  for (const img of images) {
    const filename = path.basename(img);
    const hash = computeContentHash(img);
    if (!force && db.hasBatchByHash(hash, model)) {
      console.log(`⊝ ${filename} (already scored — use --force to rescore)`);
      skipped++;
      continue;
    }
    const adType: AdType =
      explicitAdType ?? (img.includes("/benchmarks/") ? "benchmark" : "alphawalk");

    process.stdout.write(`→ ${filename} [${adType}] runs=${runs} ... `);
    const { runs: results, errors } = await scorer.scoreImageMultiShot(img, adType, runs);

    if (results.length < 2 && runs >= 2) {
      console.log(`FAILED: only ${results.length}/${runs} runs succeeded; need ≥2. First error: ${errors[0]?.message ?? "n/a"}`);
      failed++;
      continue;
    }
    if (results.length === 0) {
      console.log(`FAILED: 0/${runs} runs succeeded. First error: ${errors[0]?.message ?? "n/a"}`);
      failed++;
      continue;
    }

    const batchId = randomUUID();
    const rawRuns = results.map((r, i) => {
      const id = db.insertRun(filename, img, hash, r.model, batchId, i, r.result, r.raw);
      return {
        id,
        filename,
        filepath: img,
        scored_at: "",
        batch_id: batchId,
        run_index: i,
        result: r.result,
      };
    });

    const agg = aggregateBatch(rawRuns);
    const stdStr = agg.std_total !== null ? `±${agg.std_total.toFixed(1)}` : "";
    const stabilityTag =
      agg.stability === "single-shot"
        ? "single-shot"
        : agg.stability === "unstable"
        ? "⚠️unstable"
        : "stable";
    const ipFlag = agg.result.ip_or_legal_risk ? " ⚠️ IP RISK" : "";
    console.log(
      `${agg.result.total}${stdStr}/40 [${agg.result.verdict}, ${stabilityTag}]${ipFlag} (batch ${batchId.slice(0, 6)}, ${results.length} runs)`
    );
    scored++;
  }

  console.log(`\n✓ Done. Scored ${scored}, skipped ${skipped}, failed ${failed}.`);
  db.close();
}

async function cmdReport(args: string[]) {
  const outArg = args.find((a) => a.startsWith("--out="));
  const outPath = outArg
    ? outArg.replace("--out=", "")
    : `./reports/report-${new Date().toISOString().split("T")[0]}.html`;

  const filterArg = args.find((a) => a.startsWith("--filter-path="));
  const filterPath = filterArg ? filterArg.replace("--filter-path=", "") : undefined;

  const db = new ScoreDB(DEFAULT_DB_PATH);
  const all = db.getAll();
  const records = filterPath ? all.filter((r) => r.filepath.includes(filterPath)) : all;
  const keywords = db.aggregateKeywords(filterPath);
  if (records.length === 0) {
    console.error(
      filterPath
        ? `✗ No scored images match --filter-path=${filterPath}.`
        : "✗ No scored images. Run `score` first."
    );
    process.exit(1);
  }
  generateHtmlReport(records, keywords, outPath);
  console.log(
    `✓ Report written to ${outPath} (${records.length} rows${filterPath ? `, filter: ${filterPath}` : ""})`
  );
  console.log(`  Open with: open ${outPath}`);
  db.close();
}

async function cmdWinners(args: string[]) {
  const n = parseInt(args[0] || "10", 10);
  const db = new ScoreDB(DEFAULT_DB_PATH);
  const winners = db.getTopN(n);
  console.log(`\nTop ${n} ads by score:\n`);
  for (const r of winners) {
    console.log(
      `  ${r.result.total}/40 [${r.result.verdict.padEnd(9)}] ${r.filename}`
    );
    console.log(`    → ${r.result.winning_hypothesis}`);
  }
  db.close();
}

async function cmdLosers(args: string[]) {
  const n = parseInt(args[0] || "10", 10);
  const db = new ScoreDB(DEFAULT_DB_PATH);
  const losers = db.getBottomN(n);
  console.log(`\nBottom ${n} ads by score:\n`);
  for (const r of losers) {
    const ip = r.result.ip_or_legal_risk ? " ⚠️" : "";
    console.log(
      `  ${r.result.total}/40 [${r.result.verdict.padEnd(9)}]${ip} ${r.filename}`
    );
    if (r.result.failure_modes.length) {
      console.log(`    ✗ ${r.result.failure_modes.join("; ")}`);
    }
  }
  db.close();
}

async function cmdStats() {
  const db = new ScoreDB(DEFAULT_DB_PATH);
  const stats = db.getStats();
  console.log(`\nTotal scored: ${stats.total}`);
  if (stats.total === 0) {
    db.close();
    return;
  }
  console.log(`IP risk flagged: ${stats.ipRiskCount}`);
  console.log(`\nVerdict breakdown:`);
  for (const v of stats.verdictCounts) {
    console.log(`  ${v.verdict.padEnd(10)} ${v.n}`);
  }
  console.log(`\nAverage scores:`);
  const a = stats.averages;
  console.log(`  total              ${a.avg_total.toFixed(2)} / 40`);
  console.log(`  focal_point        ${a.avg_focal.toFixed(2)} / 5`);
  console.log(`  info_density       ${a.avg_density.toFixed(2)} / 5`);
  console.log(`  info_hierarchy     ${a.avg_hierarchy.toFixed(2)} / 5`);
  console.log(`  brand_consistency  ${a.avg_brand.toFixed(2)} / 5`);
  console.log(`  differentiation    ${a.avg_diff.toFixed(2)} / 5`);
  console.log(`  emotional_tone     ${a.avg_emotion.toFixed(2)} / 5`);
  console.log(`  cta_clarity        ${a.avg_cta.toFixed(2)} / 5`);
  console.log(`  anti_ai_feel       ${a.avg_antiai.toFixed(2)} / 5`);
  db.close();
}

async function cmdKeywords(args: string[]) {
  const n = parseInt(args[0] || "20", 10);
  const db = new ScoreDB(DEFAULT_DB_PATH);
  const all = db.aggregateKeywords();
  console.log(`\n=== Top ${n} keywords to EMPHASIZE (positive prompts) ===\n`);
  const positives = all.filter((k) => k.emphasize_count > 0).slice(0, n);
  for (const k of positives) {
    console.log(
      `  +${k.emphasize_count.toString().padStart(2)} (avg ${k.avg_total_when_present.toFixed(1)})  ${k.keyword}`
    );
  }
  console.log(`\n=== Top ${n} keywords to REMOVE (negative prompts) ===\n`);
  const negatives = [...all]
    .filter((k) => k.remove_count > 0)
    .sort((a, b) => b.remove_count - a.remove_count)
    .slice(0, n);
  for (const k of negatives) {
    console.log(
      `  -${k.remove_count.toString().padStart(2)} (avg ${k.avg_total_when_present.toFixed(1)})  ${k.keyword}`
    );
  }
  console.log("\nFeed positives into your auto-generation pipeline. Use negatives in negative_prompt.\n");
  db.close();
}

async function cmdExport(args: string[]) {
  const outArg = args.find((a) => a.startsWith("--out="));
  const outPath = outArg ? outArg.replace("--out=", "") : `./reports/scores.csv`;
  const db = new ScoreDB(DEFAULT_DB_PATH);
  const records = db.getAll();
  generateCsv(records, outPath);
  console.log(`✓ Exported ${records.length} records to ${outPath}`);
  db.close();
}

function printHelp() {
  console.log(`
Ad Scorer — automated rubric-based evaluation of ad images

USAGE:
  npm run score <image-or-folder> [--force] [--model <model>] [--ad-type alphawalk|benchmark]
      Score one image or all images in a folder.
      --force      rescore even if previously scored
      --model      override model (default: ${DEFAULT_MODEL})
      --ad-type    "alphawalk" (default for normal paths) treats competitor logos as IP risk;
                   "benchmark" treats them as expected. Auto-set to "benchmark" when the
                   path contains /benchmarks/.

  npm run report [--out=<path>] [--filter-path=<substring>]
      Generate HTML report. Default: ./reports/report-YYYY-MM-DD.html
      --filter-path  scope report to records whose filepath contains the substring
                     (e.g. --filter-path=competitor-monitoring/interactive-brokers/2026-04-30)

  npm run winners [N]            Top N ads (default 10)
  npm run losers [N]             Bottom N ads (default 10)
  npm run stats                  Aggregate statistics
  npm run keywords [N]           Top N keyword feedback (default 20)
  npm run export [--out=<path>]  Export all scores to CSV

EXAMPLES:
  npm run score ./creatives/2026-04-29/
  npm run score ./creatives/draft-v3.png --force
  npm run report
  npm run keywords 30
`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "score":
      await cmdScore(args);
      break;
    case "report":
      await cmdReport(args);
      break;
    case "winners":
      await cmdWinners(args);
      break;
    case "losers":
      await cmdLosers(args);
      break;
    case "stats":
      await cmdStats();
      break;
    case "keywords":
      await cmdKeywords(args);
      break;
    case "export":
      await cmdExport(args);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("✗ Fatal:", err);
  process.exit(1);
});
