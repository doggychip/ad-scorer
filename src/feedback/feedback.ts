/**
 * Closes the generation→scoring loop.
 *
 *   aggregateFeedback(creatives, opts)  →  FeedbackInputs       (pure)
 *   renderFeedbackMarkdown(inputs)      →  string                (pure)
 *   writeFeedbackFile(inputs, opts)     →  writes file to disk
 *
 * The pure functions take ScoredCreative[] directly so this module is
 * decoupled from your SQLite schema. Your existing `db.ts` loads the rows
 * and hands them to `aggregateFeedback`. See `db-adapter.ts` for a copy-
 * pasteable better-sqlite3 helper if you want one.
 *
 * IMPORTANT: this file does NOT touch `brand-dna.md`. Brand DNA is locked
 * rules; feedback is learned preferences within those rules. The agent
 * should read both, with brand-dna taking precedence on conflict.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DIMENSIONS,
  type Dimension,
  type FeedbackInputs,
  type KeywordStat,
  type ScoredCreative,
} from "./feedback-types.js";

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

export interface AggregateOptions {
  windowStart: string;
  windowEnd: string;
  /** Min times a keyword must appear in window to be considered. */
  minOccurrences?: number;
  /** How many top/bottom keywords to surface. */
  keywordLimit?: number;
  /** How many top/bottom creatives to highlight. */
  creativeLimit?: number;
  /** If supplied, used to compute trends vs prior window. */
  priorWindowCreatives?: ScoredCreative[];
}

const DEFAULTS = {
  minOccurrences: 3,
  keywordLimit: 12,
  creativeLimit: 3,
};

export function aggregateFeedback(
  creatives: ScoredCreative[],
  opts: AggregateOptions
): FeedbackInputs {
  const o = { ...DEFAULTS, ...opts };
  const total = creatives.length;
  const meanOverall =
    total > 0 ? creatives.reduce((s, c) => s + c.overallScore, 0) / total : 0;

  const approveCount = creatives.filter((c) => c.verdict === "approve").length;
  const rejectCount = creatives.filter((c) => c.verdict === "reject").length;

  const kw = computeKeywordStats(creatives, meanOverall, o.minOccurrences);
  const emphasize = kw
    .filter((k) => k.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, o.keywordLimit);
  const remove = kw
    .filter((k) => k.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, o.keywordLimit);

  const sortedByScore = [...creatives].sort(
    (a, b) => b.overallScore - a.overallScore
  );
  const topCreatives = sortedByScore.slice(0, o.creativeLimit);
  const bottomCreatives = sortedByScore.slice(-o.creativeLimit).reverse();

  let trends: FeedbackInputs["trends"] | undefined;
  if (o.priorWindowCreatives && o.priorWindowCreatives.length > 0 && total > 0) {
    const prior = o.priorWindowCreatives;
    const priorMean =
      prior.reduce((s, c) => s + c.overallScore, 0) / prior.length;
    const priorDimAvg = dimensionAverages(prior);
    const curDimAvg = dimensionAverages(creatives);
    const dimDeltas: Partial<Record<Dimension, number>> = {};
    for (const d of DIMENSIONS) {
      dimDeltas[d] = curDimAvg[d] - priorDimAvg[d];
    }
    trends = {
      overallDelta: meanOverall - priorMean,
      dimensionDeltas: dimDeltas,
    };
  }

  return {
    windowStart: o.windowStart,
    windowEnd: o.windowEnd,
    totalScored: total,
    approvalRate: total > 0 ? approveCount / total : 0,
    rejectionRate: total > 0 ? rejectCount / total : 0,
    meanOverall,
    dimensionAverages: dimensionAverages(creatives),
    emphasize,
    remove,
    topCreatives,
    bottomCreatives,
    trends,
  };
}

function computeKeywordStats(
  creatives: ScoredCreative[],
  meanOverall: number,
  minOccurrences: number
): KeywordStat[] {
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const c of creatives) {
    for (const kw of c.keywords) {
      const key = kw.trim().toLowerCase();
      if (!key) continue;
      const cur = buckets.get(key) ?? { sum: 0, n: 0 };
      cur.sum += c.overallScore;
      cur.n += 1;
      buckets.set(key, cur);
    }
  }

  const stats: KeywordStat[] = [];
  for (const [keyword, { sum, n }] of buckets) {
    if (n < minOccurrences) continue;
    const avgScore = sum / n;
    stats.push({
      keyword,
      avgScore,
      occurrences: n,
      delta: avgScore - meanOverall,
    });
  }
  return stats;
}

function dimensionAverages(
  creatives: ScoredCreative[]
): Record<Dimension, number> {
  const out = Object.fromEntries(
    DIMENSIONS.map((d) => [d, 0])
  ) as Record<Dimension, number>;
  if (creatives.length === 0) return out;
  for (const c of creatives) {
    for (const d of DIMENSIONS) {
      out[d] += c.scores[d] ?? 0;
    }
  }
  for (const d of DIMENSIONS) out[d] /= creatives.length;
  return out;
}

// ---------------------------------------------------------------------------
// Pure renderer
// ---------------------------------------------------------------------------

const DIM_LABEL: Record<Dimension, string> = {
  visual_hierarchy: "Visual hierarchy",
  brand_consistency: "Brand consistency",
  message_clarity: "Message clarity",
  emotional_resonance: "Emotional resonance",
  production_quality: "Production quality",
  originality: "Originality",
  platform_fit: "Platform fit",
  ip_safety: "IP safety",
};

function fmtDelta(n: number, digits = 1): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function quoteCreative(c: ScoredCreative): string {
  const promptPreview = c.prompt.replace(/\s+/g, " ").trim().slice(0, 140);
  const ip =
    c.ipFlags && c.ipFlags.length > 0
      ? ` ⚠️ IP: ${c.ipFlags.join(", ")}`
      : "";
  const cont = c.prompt.length > 140 ? "…" : "";
  return `**${c.imagePath}** — score ${c.overallScore.toFixed(0)} (${c.verdict})${ip}\n  Prompt: _${promptPreview}${cont}_`;
}

export function renderFeedbackMarkdown(inputs: FeedbackInputs): string {
  const lines: string[] = [];

  lines.push(
    `# Creative feedback — ${inputs.windowStart} → ${inputs.windowEnd}`
  );
  lines.push("");
  lines.push(
    "_Read this BEFORE generating new creatives._ " +
      "Brand DNA (locked) takes precedence — this file is **learned preferences within those rules**. " +
      "Auto-generated by ad-scorer; review the diff before each batch."
  );
  lines.push("");

  // ---- snapshot ----
  lines.push("## Snapshot");
  lines.push("");
  if (inputs.totalScored === 0) {
    lines.push(
      "_No creatives scored in this window._ Generate normally and re-run feedback after the next scoring batch."
    );
    return lines.join("\n");
  }
  const trendStr = inputs.trends
    ? ` (${fmtDelta(inputs.trends.overallDelta)} vs prior window)`
    : "";
  lines.push(
    `- **${inputs.totalScored}** scored | ${fmtPct(inputs.approvalRate)} approved | ${fmtPct(inputs.rejectionRate)} rejected`
  );
  lines.push(
    `- Mean overall: **${inputs.meanOverall.toFixed(1)}**${trendStr}`
  );

  const dimEntries = (Object.entries(inputs.dimensionAverages) as [
    Dimension,
    number,
  ][]).sort((a, b) => a[1] - b[1]);
  const weakest = dimEntries[0];
  const strongest = dimEntries[dimEntries.length - 1];
  lines.push(
    `- Weakest dimension: **${DIM_LABEL[weakest[0]]}** (${weakest[1].toFixed(1)}/10)`
  );
  lines.push(
    `- Strongest dimension: **${DIM_LABEL[strongest[0]]}** (${strongest[1].toFixed(1)}/10)`
  );
  lines.push("");

  // ---- emphasize ----
  lines.push("## Patterns to KEEP USING");
  lines.push("");
  if (inputs.emphasize.length === 0) {
    lines.push(
      "_No keywords with statistically meaningful positive lift in this window._"
    );
  } else {
    lines.push(
      "Keywords whose creatives outscored the batch mean (sorted by lift):"
    );
    lines.push("");
    lines.push("| Keyword | Lift | Avg score | Used N times |");
    lines.push("|---|---|---|---|");
    for (const k of inputs.emphasize) {
      lines.push(
        `| ${k.keyword} | ${fmtDelta(k.delta)} | ${k.avgScore.toFixed(1)} | ${k.occurrences} |`
      );
    }
  }
  lines.push("");

  if (inputs.topCreatives.length > 0) {
    lines.push("### Top creatives this window");
    lines.push("");
    inputs.topCreatives.forEach((c, i) => {
      lines.push(`${i + 1}. ${quoteCreative(c)}`);
    });
    lines.push("");
  }

  // ---- remove ----
  lines.push("## Patterns to AVOID");
  lines.push("");
  if (inputs.remove.length === 0) {
    lines.push(
      "_No keywords with statistically meaningful negative drag in this window._"
    );
  } else {
    lines.push(
      "Keywords whose creatives underscored the batch mean (sorted by drag):"
    );
    lines.push("");
    lines.push("| Keyword | Drag | Avg score | Used N times |");
    lines.push("|---|---|---|---|");
    for (const k of inputs.remove) {
      lines.push(
        `| ${k.keyword} | ${fmtDelta(k.delta)} | ${k.avgScore.toFixed(1)} | ${k.occurrences} |`
      );
    }
  }
  lines.push("");

  if (inputs.bottomCreatives.length > 0) {
    lines.push("### Bottom creatives this window");
    lines.push("");
    inputs.bottomCreatives.forEach((c, i) => {
      lines.push(`${i + 1}. ${quoteCreative(c)}`);
    });
    lines.push("");
  }

  // ---- trends ----
  if (inputs.trends) {
    lines.push("## Dimension trends vs prior window");
    lines.push("");
    const trendRows = (Object.entries(inputs.trends.dimensionDeltas) as [
      Dimension,
      number,
    ][])
      .filter(([, v]) => Math.abs(v) >= 0.2)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (trendRows.length === 0) {
      lines.push("_No meaningful dimension shifts (all within ±0.2)._");
    } else {
      for (const [d, delta] of trendRows) {
        const arrow = delta > 0 ? "↑" : "↓";
        lines.push(`- ${arrow} **${DIM_LABEL[d]}**: ${fmtDelta(delta)}`);
      }
    }
    lines.push("");
  }

  // ---- guidance ----
  lines.push("## Suggested directions for the next batch");
  lines.push("");
  lines.push(
    "When generating prompts, weight your keyword choice toward the KEEP list and away from the AVOID list."
  );
  lines.push(
    "If a brief asks for something on the AVOID list, generate it but include 1-2 alternative compositions for comparison."
  );
  lines.push(
    "When two top creatives share a structural pattern (e.g. single-subject framing), default to that pattern unless the brief contradicts it."
  );
  lines.push("");
  lines.push(
    "_Always defer to `brand-dna.md` for any conflict; this file is preferences, not rules._"
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

export interface WriteOptions {
  outputPath?: string;
  archive?: boolean;
}

export function writeFeedbackFile(
  inputs: FeedbackInputs,
  opts: WriteOptions = {}
): { outputPath: string; archivePath?: string } {
  const md = renderFeedbackMarkdown(inputs);
  const outputPath = path.resolve(opts.outputPath ?? "creative-feedback.md");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, md, "utf8");

  let archivePath: string | undefined;
  if (opts.archive) {
    const archiveDir = path.resolve("feedback-archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    archivePath = path.join(archiveDir, `feedback-${stamp}.md`);
    fs.writeFileSync(archivePath, md, "utf8");
  }
  return { outputPath, archivePath };
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function defaultWindow(end?: Date): { start: string; end: string } {
  const e = end ?? new Date();
  const s = new Date(e);
  s.setUTCDate(s.getUTCDate() - 7);
  return { start: ymd(s), end: ymd(e) };
}

export function priorWindow(start: string, end: string): {
  start: string;
  end: string;
} {
  const s = new Date(start);
  const e = new Date(end);
  const lengthMs = e.getTime() - s.getTime();
  return {
    start: new Date(s.getTime() - lengthMs).toISOString().slice(0, 10),
    end: start,
  };
}
