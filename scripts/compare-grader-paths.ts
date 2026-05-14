// Grader-path A/B harness. Runs N independent scoreImage calls on one or more
// images and dumps results to /tmp/grader-compare-<tag>.json for offline diff.
// Designed for: re-validating the grader after model upgrades (e.g. swapping
// claude-sonnet-4-6 → 4-7), after rubric.ts changes, or after schema edits to
// SCORE_AD_TOOL. The git-stash flow from the 2026-05-13 tool-use migration
// (see docs/audits/) is the canonical usage pattern.
//
// Usage:
//   tsx scripts/compare-grader-paths.ts <tag> <image1> [image2] [...]
// where <tag> is any short label (e.g. "new", "legacy", "sonnet-4-6",
// "opus-4-7"). Output: { tag, N, images: [{ imagePath, elapsed_s, runs: [...] }] }.
import "dotenv/config";
import fs from "fs";
import path from "path";
import { Scorer } from "../src/scorer.js";

const N = 3;
const tag = process.argv[2];
const imagePaths = process.argv.slice(3);

if (!tag || imagePaths.length === 0) {
  console.error("usage: tsx scripts/compare-grader-paths.ts <new|legacy> <image1> [image2] [...]");
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// Mirrors src/index.ts:16-25 — same defaults the production CLI uses.
const brand = {
  brandName: process.env.BRAND_NAME || "Alphawalk.ai",
  brandTagline: process.env.BRAND_TAGLINE || "Your AI Investment Assistant",
  brandColors: process.env.BRAND_COLORS || "purple,gold",
  brandArchetype:
    process.env.BRAND_ARCHETYPE ||
    "sophisticated, confident, focused — financial product for retail investors",
};

const scorer = new Scorer(apiKey, "claude-sonnet-4-6", brand);

const totalT0 = Date.now();
const images: unknown[] = [];

// Sequential across images (each image already fires N=3 in parallel inside
// scoreImageMultiShot equivalent here). Parallelizing across images would
// risk Tier-2 RPM ceilings on the API.
for (let idx = 0; idx < imagePaths.length; idx++) {
  const imagePath = imagePaths[idx];
  const name = path.basename(imagePath);
  const t0 = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: N }, () => scorer.scoreImage(imagePath, "benchmark"))
  );
  const elapsed_s = ((Date.now() - t0) / 1000).toFixed(1);
  const runs = settled.map((s, i) => ({
    run: i,
    status: s.status,
    result: s.status === "fulfilled" ? s.value.result : null,
    error: s.status === "rejected" ? String(s.reason).slice(0, 300) : null,
  }));
  const ok = runs.filter((r) => r.status === "fulfilled").length;
  console.log(`[${tag}] (${idx + 1}/${imagePaths.length}) ${name}: ${ok}/${N} in ${elapsed_s}s`);
  images.push({ imagePath, elapsed_s, runs });
}

const totalElapsed = ((Date.now() - totalT0) / 1000).toFixed(1);
const outPath = `/tmp/grader-compare-${tag}.json`;
fs.writeFileSync(outPath, JSON.stringify({ tag, N, total_elapsed_s: totalElapsed, images }, null, 2));
console.log(`[${tag}] wrote ${outPath} in ${totalElapsed}s total`);
