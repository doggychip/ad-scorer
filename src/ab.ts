// src/ab.ts
// A/B prompt testing — generate the same brief twice with different keyword
// emphasis, score both, compare aggregated rubric scores.
//
// USE WHEN: you've changed the keyword feedback (manually, or because
// `npm run feedback` produced a different KEEP/AVOID list) and want to know
// whether the change actually moves rubric scores in your direction. The
// brief is held constant — the only deliberate variation is the keyword set
// the prompt generator sees.
//
// CAVEAT: the LLM has temperature, so even identical inputs would produce
// different prompts run-to-run. With N>=5 prompts per variant the noise
// averages out, but for a small N treat the comparison as directional, not
// statistically significant.

import fs from "fs";
import path from "path";
import { generateNextPrompts } from "./next-prompts.js";
import { ScoreDB } from "./db.js";
import type { AggregatedRecord, RubricScores } from "./types.js";

export interface AbGenOpts {
  brief: string;
  conceptSlug: string;
  n: number;
  days: number;
  /** Variant B's emphasize list. Variant A always uses the DB's current
   *  derived KEEP list — that's the "control" to beat. */
  emphasizeOverrideB: string[];
  /** Optional: also override variant B's remove list. If absent, B keeps
   *  the same negative keywords as A — change is isolated to positives. */
  removeOverrideB?: string[];
  apiKey: string;
  model: string;
  dbPath: string;
  brandDnaPath: string;
  /** Base directory for A/B prompt outputs. Default ./prompts/ab. */
  outputBaseDir: string;
}

export interface AbGenResult {
  conceptSlug: string;
  /** Concrete output dir under outputBaseDir, e.g. ./prompts/ab/<slug>-<date>/ */
  outputDir: string;
  variantA: { prompts: string[]; outputPath: string };
  variantB: { prompts: string[]; outputPath: string };
  manifestPath: string;
}

/**
 * Generate N prompts each for variant A (DB-derived keywords, the control)
 * and variant B (with emphasize/remove overrides). Same brief for both.
 * Writes:
 *   <outputBaseDir>/<conceptSlug>-<date>/A.md
 *   <outputBaseDir>/<conceptSlug>-<date>/B.md
 *   <outputBaseDir>/<conceptSlug>-<date>/MANIFEST.md   — paste-target paths,
 *     keyword-set diff, and the brief, so the test is reproducible.
 */
export async function generateAbPrompts(opts: AbGenOpts): Promise<AbGenResult> {
  if (!opts.conceptSlug || /[^a-z0-9-]/.test(opts.conceptSlug)) {
    throw new Error(
      `concept slug must be lowercase a-z0-9- only (got "${opts.conceptSlug}")`
    );
  }
  if (opts.emphasizeOverrideB.length === 0) {
    throw new Error(
      "ab:gen needs --keywords-b: variant B is the override; without it there's nothing to test"
    );
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(opts.outputBaseDir, `${opts.conceptSlug}-${dateStr}`);
  fs.mkdirSync(outputDir, { recursive: true });

  // Variant A — DB-derived keywords, the control
  const a = await generateNextPrompts({
    n: opts.n,
    days: opts.days,
    brief: opts.brief,
    apiKey: opts.apiKey,
    model: opts.model,
    dbPath: opts.dbPath,
    brandDnaPath: opts.brandDnaPath,
    outputDir,
    outputFilename: "A.md",
  });

  // Variant B — explicit override list. Synthesize "net scores" so the
  // generator's prompt format keeps working: descending integer net so
  // earlier items in the override list weigh more, matching how
  // loadRecentContext builds positives.
  const positivesOverride = opts.emphasizeOverrideB.map((k, i) => ({
    keyword: k.toLowerCase().trim(),
    net: opts.emphasizeOverrideB.length - i,
  }));
  const negativesOverride = opts.removeOverrideB?.map((k, i) => ({
    keyword: k.toLowerCase().trim(),
    net: -(opts.removeOverrideB!.length - i),
  }));

  const b = await generateNextPrompts({
    n: opts.n,
    days: opts.days,
    brief: opts.brief,
    apiKey: opts.apiKey,
    model: opts.model,
    dbPath: opts.dbPath,
    brandDnaPath: opts.brandDnaPath,
    outputDir,
    outputFilename: "B.md",
    positivesOverride,
    negativesOverride,
  });

  const manifestPath = path.join(outputDir, "MANIFEST.md");
  fs.writeFileSync(
    manifestPath,
    renderManifest({
      conceptSlug: opts.conceptSlug,
      dateStr,
      brief: opts.brief,
      n: opts.n,
      emphasizeOverrideB: opts.emphasizeOverrideB,
      removeOverrideB: opts.removeOverrideB,
    }),
    "utf-8"
  );

  return {
    conceptSlug: opts.conceptSlug,
    outputDir,
    variantA: { prompts: a.prompts, outputPath: a.outputPath },
    variantB: { prompts: b.prompts, outputPath: b.outputPath },
    manifestPath,
  };
}

function renderManifest(args: {
  conceptSlug: string;
  dateStr: string;
  brief: string;
  n: number;
  emphasizeOverrideB: string[];
  removeOverrideB?: string[];
}): string {
  const removeBlock = args.removeOverrideB?.length
    ? args.removeOverrideB.map((k) => `- ${k}`).join("\n")
    : "_(unchanged from variant A)_";
  return `# A/B prompt test — ${args.conceptSlug}

**Date**: ${args.dateStr}
**N per variant**: ${args.n}

## Brief (held constant)

${args.brief}

## Variant A (control)

Uses the current DB-derived KEEP/AVOID keyword digest from \`creative-feedback.md\`.
See \`A.md\` for prompts.

## Variant B (override)

Emphasize keywords (in priority order):
${args.emphasizeOverrideB.map((k) => `- ${k}`).join("\n")}

Remove keywords:
${removeBlock}

See \`B.md\` for prompts.

## Workflow

1. Paste each variant's prompts into Gemini Imagen / ChatGPT Image 2.0.
2. Drop generated images into:
   - \`creatives/ab/${args.conceptSlug}/${args.dateStr}/A/\`
   - \`creatives/ab/${args.conceptSlug}/${args.dateStr}/B/\`
3. Score both folders:
   \`\`\`
   npm run score creatives/ab/${args.conceptSlug}/${args.dateStr}/A/
   npm run score creatives/ab/${args.conceptSlug}/${args.dateStr}/B/
   \`\`\`
4. Compare:
   \`\`\`
   npm run ab:compare creatives/ab/${args.conceptSlug}/${args.dateStr}/
   \`\`\`
`;
}

// ============================================================================
// Comparison — pure functions, easy to test.
// ============================================================================

const DIM_KEYS: (keyof RubricScores)[] = [
  "focal_point",
  "information_density",
  "information_hierarchy",
  "brand_consistency",
  "differentiation",
  "emotional_tone",
  "cta_clarity",
  "anti_ai_feel",
];

export interface VariantStats {
  label: "A" | "B";
  n: number;
  totalMean: number;
  totalSE: number;
  perDimMean: Record<keyof RubricScores, number>;
  winnerCount: number;
  unstableCount: number;
  ipFlagged: number;
}

export interface AbDelta {
  total: number;
  totalSE: number; // SE of the difference: sqrt(seA² + seB²)
  perDim: Record<keyof RubricScores, number>;
}

export interface AbComparison {
  a: VariantStats;
  b: VariantStats;
  delta: AbDelta;
  /** True when n on either side is below the meaningful-signal threshold. */
  underpowered: boolean;
}

/** Mean and standard-error-of-the-mean using the sample (n-1) variance.
 *  Returns mean=0, se=0 on empty input; se=0 on single-sample input. */
export function meanAndSE(xs: number[]): { mean: number; se: number } {
  if (xs.length === 0) return { mean: 0, se: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length < 2) return { mean, se: 0 };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return { mean, se: Math.sqrt(variance) / Math.sqrt(xs.length) };
}

function summarizeVariant(label: "A" | "B", records: AggregatedRecord[]): VariantStats {
  const totals = records.map((r) => r.result.total);
  const { mean: totalMean, se: totalSE } = meanAndSE(totals);
  const perDimMean = {} as Record<keyof RubricScores, number>;
  for (const k of DIM_KEYS) {
    const xs = records.map((r) => r.result.scores[k]);
    perDimMean[k] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  }
  return {
    label,
    n: records.length,
    totalMean,
    totalSE,
    perDimMean,
    winnerCount: records.filter((r) => r.result.verdict === "winner").length,
    unstableCount: records.filter((r) => r.stability === "unstable").length,
    ipFlagged: records.filter((r) => r.result.ip_or_legal_risk).length,
  };
}

/**
 * Pure comparison of two batches' aggregated records. Caller is responsible
 * for loading records (typically via ScoreDB.getAggregatedRecords with a
 * filter-path scoping each variant's directory).
 */
export function compareAbBatches(
  recordsA: AggregatedRecord[],
  recordsB: AggregatedRecord[]
): AbComparison {
  const a = summarizeVariant("A", recordsA);
  const b = summarizeVariant("B", recordsB);
  const perDim = {} as Record<keyof RubricScores, number>;
  for (const k of DIM_KEYS) perDim[k] = b.perDimMean[k] - a.perDimMean[k];
  return {
    a,
    b,
    delta: {
      total: b.totalMean - a.totalMean,
      totalSE: Math.sqrt(a.totalSE ** 2 + b.totalSE ** 2),
      perDim,
    },
    // <10/variant: 95% CI on the mean total is roughly ±2 points even with
    // tight per-image variance; treat any delta as directional only.
    underpowered: a.n < 10 || b.n < 10,
  };
}

/** Load aggregated records under a folder via filter-path. Each variant
 *  lives in `<parent>/A/` and `<parent>/B/`; we filter records whose
 *  filepath contains those substrings. */
export function loadAbVariants(
  dbPath: string,
  parentFolder: string
): { recordsA: AggregatedRecord[]; recordsB: AggregatedRecord[] } {
  // Normalize: strip trailing slash; substring-match the variant subdir
  // including trailing slash so that "/A/" doesn't false-match "/AB/" etc.
  const norm = parentFolder.replace(/\/+$/, "");
  const filterA = path.join(norm, "A") + "/";
  const filterB = path.join(norm, "B") + "/";
  const db = new ScoreDB(dbPath);
  try {
    return {
      recordsA: db.getAggregatedRecords(filterA),
      recordsB: db.getAggregatedRecords(filterB),
    };
  } finally {
    db.close();
  }
}

/** Format an AbComparison for the terminal. Pure (no I/O), so testable. */
export function formatComparison(cmp: AbComparison, conceptHint?: string): string {
  const lines: string[] = [];
  lines.push("");
  if (conceptHint) lines.push(`A/B comparison: ${conceptHint}`);
  lines.push("");
  lines.push(formatVariantBlock(cmp.a));
  lines.push("");
  lines.push(formatVariantBlock(cmp.b));
  lines.push("");
  lines.push("Δ (B − A):");
  lines.push(
    `  total              ${signed(cmp.delta.total)}   (SE of difference: ${cmp.delta.totalSE.toFixed(2)}; |Δ|/SE=${
      cmp.delta.totalSE > 0 ? (Math.abs(cmp.delta.total) / cmp.delta.totalSE).toFixed(2) : "—"
    })`
  );
  // Sort dims by absolute delta to surface the strongest signal first
  const sortedDims = [...DIM_KEYS].sort(
    (a, b) => Math.abs(cmp.delta.perDim[b]) - Math.abs(cmp.delta.perDim[a])
  );
  for (const k of sortedDims) {
    lines.push(`  ${k.padEnd(18)} ${signed(cmp.delta.perDim[k])}`);
  }
  if (cmp.underpowered) {
    lines.push("");
    lines.push(
      `⚠️  n<10 on at least one side (A=${cmp.a.n}, B=${cmp.b.n}). Treat the delta as directional, not significant. Aim for ≥10/variant for stable signal.`
    );
  }
  if (cmp.delta.totalSE > 0 && Math.abs(cmp.delta.total) < cmp.delta.totalSE) {
    lines.push("");
    lines.push(
      `Note: |Δ_total| < SE — the variants overlap within run-to-run noise. The keyword change has not measurably moved the rubric.`
    );
  }
  return lines.join("\n");
}

function formatVariantBlock(v: VariantStats): string {
  const lines: string[] = [];
  lines.push(`Variant ${v.label} (n=${v.n})`);
  if (v.n === 0) {
    lines.push(`  (no scored images found for this variant)`);
    return lines.join("\n");
  }
  lines.push(`  total mean         ${v.totalMean.toFixed(2)} ± ${v.totalSE.toFixed(2)} / 40`);
  lines.push(
    `  winners            ${v.winnerCount}/${v.n} (${((v.winnerCount / v.n) * 100).toFixed(0)}%)`
  );
  if (v.unstableCount > 0) {
    lines.push(`  unstable batches   ${v.unstableCount} (rescore at --runs 5 if material)`);
  }
  if (v.ipFlagged > 0) {
    lines.push(`  IP risk flagged    ${v.ipFlagged}`);
  }
  for (const k of DIM_KEYS) {
    lines.push(`  ${k.padEnd(18)} ${v.perDimMean[k].toFixed(2)} / 5`);
  }
  return lines.join("\n");
}

function signed(n: number): string {
  const s = n.toFixed(2);
  return n >= 0 ? `+${s}` : s;
}
