// src/notify.ts
// Lark (Feishu) digest notifier. After `npm run score`, post a one-screen
// summary to a team channel: counts by verdict, top 3 winners, IP risks,
// unstable batches. Designed so adding Slack later is a sibling formatter,
// not a rewrite.
//
// USAGE:
//   1. Create a custom bot in your Lark group → "Add Bot" → "Custom Bot".
//   2. Copy the webhook URL into .env as LARK_WEBHOOK_URL.
//   3. Optional but recommended: enable "signature verification" and copy
//      the secret into LARK_SIGN_SECRET. We HMAC each request with it.
//   4. After scoring:  npm run notify creatives/2026-05-06/
//      Or rehearse:    npm run notify creatives/2026-05-06/ --dry-run
//
// PRIVACY: We send only counts, filenames, totals, and brief failure text.
// We never send the image bytes themselves (Lark URL-fetches don't apply
// to local files anyway). If you score competitor benchmarks under
// /benchmarks/, scope the notify call with --filter-path so it doesn't
// surface those rows in your team channel.

import crypto from "crypto";
import { ScoreDB } from "./db.js";
import type { AggregatedRecord } from "./types.js";

export type Locale = "zh" | "en";

export interface DigestSummary {
  date: string;                         // YYYY-MM-DD generation date
  scope: string;                        // human label, e.g. folder path
  total: number;
  winners: number;
  candidates: number;
  rejects: number;
  unstable: number;
  ipFlagged: number;
  averageTotal: number | null;          // null when total === 0
  topWinners: { filename: string; total: number; std: number | null }[];
  ipRisks: { filename: string; risk: string }[];
}

const LABELS: Record<Locale, Record<string, string>> = {
  zh: {
    title: "广告评分报告",
    scope: "范围",
    scoredBatches: "已评批次",
    winner: "优胜",
    candidate: "候选",
    reject: "不合格",
    unstable: "不稳定",
    ipRisk: "IP/法律风险",
    average: "平均分",
    topWinners: "评分最高",
    ipRisksHeader: "⚠️ 风险标记",
    none: "无",
    noScored: "本次无可发送的评分结果",
  },
  en: {
    title: "Ad scoring digest",
    scope: "Scope",
    scoredBatches: "Batches scored",
    winner: "Winners",
    candidate: "Candidates",
    reject: "Rejects",
    unstable: "Unstable",
    ipRisk: "IP/legal risks",
    average: "Average total",
    topWinners: "Top winners",
    ipRisksHeader: "⚠️ IP/legal flags",
    none: "none",
    noScored: "Nothing to send (no scored records).",
  },
};

/** Pure: collapse a set of aggregated records into a digest-ready summary. */
export function summarizeBatch(
  records: AggregatedRecord[],
  scope: string,
  date: string = new Date().toISOString().slice(0, 10)
): DigestSummary {
  const total = records.length;
  const winners = records.filter((r) => r.result.verdict === "winner").length;
  const candidates = records.filter((r) => r.result.verdict === "candidate").length;
  const rejects = records.filter((r) => r.result.verdict === "reject").length;
  const unstable = records.filter((r) => r.stability === "unstable").length;
  const ipFlagged = records.filter((r) => r.result.ip_or_legal_risk).length;
  const averageTotal =
    total === 0 ? null : records.reduce((s, r) => s + r.result.total, 0) / total;

  const topWinners = [...records]
    .sort((a, b) => b.result.total - a.result.total)
    .slice(0, 3)
    .map((r) => ({
      filename: r.filename,
      total: r.result.total,
      std: r.std_total,
    }));

  const ipRisks = records
    .filter((r) => r.result.ip_or_legal_risk)
    .slice(0, 5)
    .map((r) => ({
      filename: r.filename,
      risk: r.result.ip_or_legal_risk as string,
    }));

  return {
    date,
    scope,
    total,
    winners,
    candidates,
    rejects,
    unstable,
    ipFlagged,
    averageTotal,
    topWinners,
    ipRisks,
  };
}

/** Pure: render a DigestSummary as a plain-text block. Used directly as
 *  the body of a Lark text message; reusable for Slack/email later. */
export function formatTextDigest(s: DigestSummary, locale: Locale = "zh"): string {
  const L = LABELS[locale];
  if (s.total === 0) return `${L.title} — ${s.date}\n${L.scope}: ${s.scope}\n\n${L.noScored}`;

  const lines: string[] = [];
  lines.push(`${L.title} — ${s.date}`);
  lines.push(`${L.scope}: ${s.scope}`);
  lines.push("");
  lines.push(`${L.scoredBatches}: ${s.total}`);
  lines.push(`  ${L.winner}: ${s.winners}    ${L.candidate}: ${s.candidates}    ${L.reject}: ${s.rejects}`);
  if (s.averageTotal !== null) {
    lines.push(`  ${L.average}: ${s.averageTotal.toFixed(1)} / 40`);
  }
  if (s.unstable > 0) lines.push(`  ${L.unstable}: ${s.unstable}`);
  if (s.ipFlagged > 0) lines.push(`  ${L.ipRisk}: ${s.ipFlagged}`);

  if (s.topWinners.length > 0) {
    lines.push("");
    lines.push(`${L.topWinners}:`);
    for (const w of s.topWinners) {
      const stdStr = w.std !== null ? `±${w.std.toFixed(1)}` : "";
      lines.push(`  ${w.filename} — ${w.total}${stdStr}/40`);
    }
  }

  if (s.ipRisks.length > 0) {
    lines.push("");
    lines.push(`${L.ipRisksHeader}:`);
    for (const r of s.ipRisks) {
      // Truncate risk text so a flood of long warnings doesn't blow past
      // Lark's per-message size limit.
      const risk = r.risk.length > 120 ? r.risk.slice(0, 117) + "..." : r.risk;
      lines.push(`  ${r.filename}: ${risk}`);
    }
    if (s.ipFlagged > s.ipRisks.length) {
      lines.push(`  (+${s.ipFlagged - s.ipRisks.length} more)`);
    }
  }

  return lines.join("\n");
}

/** Lark "text" message envelope. Stable across webhook versions; richer
 *  formats (post / interactive card) can be added once we have a real bot
 *  to test against. Also accepts an optional sign + timestamp pair so
 *  signature-protected webhooks don't reject the message. */
export interface LarkTextPayload {
  msg_type: "text";
  content: { text: string };
  timestamp?: string;
  sign?: string;
}

export function buildLarkTextPayload(text: string): LarkTextPayload {
  return { msg_type: "text", content: { text } };
}

/**
 * Lark webhook signature: HMAC-SHA256 with the key being the literal
 * string "<timestamp>\n<secret>" and the data being empty bytes; result
 * base64-encoded. This matches Lark's official spec — verified against
 * https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/bot-v2/use-custom-bots-in-the-group
 * Returned `timestamp` is unix seconds as a string (also Lark's spec).
 */
export function signLarkPayload(
  secret: string,
  nowMs: number = Date.now()
): { timestamp: string; sign: string } {
  const timestamp = Math.floor(nowMs / 1000).toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto
    .createHmac("sha256", stringToSign)
    .update("")
    .digest("base64");
  return { timestamp, sign };
}

export interface PostResult {
  ok: boolean;
  status: number;
  body: string;
}

/** Network wrapper. Kept thin so the test surface stays in pure helpers.
 *  Does not throw on non-2xx — returns ok=false so the caller can decide.
 *  Surfaces Lark's own error code (StatusCode/code in the body) by passing
 *  the raw body back; the CLI prints it on failure. */
export async function postToLark(
  webhookUrl: string,
  payload: LarkTextPayload,
  secret?: string
): Promise<PostResult> {
  const body = secret
    ? { ...payload, ...signLarkPayload(secret) }
    : payload;
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

export interface SendDigestOpts {
  webhookUrl: string;
  secret?: string;
  locale?: Locale;
  /** When true, format and return the payload but skip the network call. */
  dryRun?: boolean;
}

export interface SendDigestResult {
  summary: DigestSummary;
  text: string;
  payload: LarkTextPayload;
  posted: boolean;
  postResult?: PostResult;
}

/**
 * High-level convenience for the CLI: summarize → format → optionally post.
 * Returns the rendered text and post result so the CLI can show what it did.
 */
export async function sendDigest(
  records: AggregatedRecord[],
  scope: string,
  opts: SendDigestOpts
): Promise<SendDigestResult> {
  const locale = opts.locale ?? "zh";
  const summary = summarizeBatch(records, scope);
  const text = formatTextDigest(summary, locale);
  const payload = buildLarkTextPayload(text);

  if (opts.dryRun) {
    return { summary, text, payload, posted: false };
  }
  const postResult = await postToLark(opts.webhookUrl, payload, opts.secret);
  return { summary, text, payload, posted: postResult.ok, postResult };
}

/** Convenience for the CLI: load aggregated records from the scoredb,
 *  optionally filtered by a path substring (same behavior as cmdReport). */
export function loadRecordsForNotify(
  dbPath: string,
  filterPath?: string
): AggregatedRecord[] {
  const db = new ScoreDB(dbPath);
  try {
    return db.getAggregatedRecords(filterPath);
  } finally {
    db.close();
  }
}
