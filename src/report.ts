// HTML report + CSV export
import fs from "fs";
import path from "path";
import { ImageRecord, KeywordAggregation } from "./types.js";

const VERDICT_COLOR: Record<string, string> = {
  winner: "#10b981",
  candidate: "#f59e0b",
  reject: "#ef4444",
};

function imageToDataUri(filepath: string): string | null {
  try {
    if (!fs.existsSync(filepath)) return null;
    const ext = path.extname(filepath).toLowerCase().slice(1);
    const mime = ext === "jpg" ? "jpeg" : ext;
    const data = fs.readFileSync(filepath).toString("base64");
    return `data:image/${mime};base64,${data}`;
  } catch {
    return null;
  }
}

export function generateHtmlReport(
  records: ImageRecord[],
  keywords: KeywordAggregation[],
  outputPath: string
) {
  const cards = records
    .sort((a, b) => b.result.total - a.result.total)
    .map((r) => {
      const dataUri = imageToDataUri(r.filepath);
      const imgHtml = dataUri
        ? `<img src="${dataUri}" alt="${r.filename}" />`
        : `<div class="no-img">image missing</div>`;
      const verdictColor = VERDICT_COLOR[r.result.verdict] || "#6b7280";
      const ipBadge = r.result.ip_or_legal_risk
        ? `<div class="ip-risk">⚠️ IP/Legal: ${escapeHtml(r.result.ip_or_legal_risk)}</div>`
        : "";

      const scoreBars = Object.entries(r.result.scores)
        .map(([k, v]) => {
          const pct = (v / 5) * 100;
          const barColor = v >= 4 ? "#10b981" : v >= 3 ? "#f59e0b" : "#ef4444";
          return `<div class="score-row"><span class="score-label">${k.replace(/_/g, " ")}</span><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor}"></div></div><span class="score-num">${v}/5</span></div>`;
        })
        .join("");

      return `
        <div class="card">
          <div class="card-img">${imgHtml}</div>
          <div class="card-body">
            <div class="card-header">
              <span class="filename">${escapeHtml(r.filename)}</span>
              <span class="total" style="background:${verdictColor}">${r.result.total}/40 · ${r.result.verdict}</span>
            </div>
            ${ipBadge}
            <div class="scores">${scoreBars}</div>
            <div class="hypothesis"><strong>Winning hypothesis:</strong> ${escapeHtml(r.result.winning_hypothesis)}</div>
            ${r.result.failure_modes.length ? `<div class="failures"><strong>Failure modes:</strong><ul>${r.result.failure_modes.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>` : ""}
            <div class="keywords">
              <div class="kw-block kw-emp"><strong>✓ Emphasize:</strong> ${r.result.suggested_keywords_to_emphasize.map(escapeHtml).join(", ") || "—"}</div>
              <div class="kw-block kw-rem"><strong>✗ Remove:</strong> ${r.result.suggested_keywords_to_remove.map(escapeHtml).join(", ") || "—"}</div>
            </div>
            <div class="meta">scored ${r.scored_at} · id ${r.id}</div>
          </div>
        </div>
      `;
    })
    .join("\n");

  const topEmphasize = keywords.filter((k) => k.emphasize_count > 0).slice(0, 20);
  const topRemove = [...keywords]
    .filter((k) => k.remove_count > 0)
    .sort((a, b) => b.remove_count - a.remove_count)
    .slice(0, 20);

  const kwTable = (rows: KeywordAggregation[], type: "emp" | "rem") => `
    <table class="kw-table">
      <thead><tr><th>keyword</th><th>${type === "emp" ? "emphasize" : "remove"} count</th><th>net</th><th>avg total when present</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (k) =>
              `<tr><td>${escapeHtml(k.keyword)}</td><td>${type === "emp" ? k.emphasize_count : k.remove_count}</td><td>${k.net_score >= 0 ? "+" : ""}${k.net_score}</td><td>${k.avg_total_when_present.toFixed(1)}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Ad Scorer Report — ${new Date().toISOString().split("T")[0]}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
  h1 { margin: 0 0 8px; font-size: 28px; }
  .subtitle { color: #94a3b8; margin-bottom: 32px; }
  h2 { margin: 32px 0 16px; font-size: 20px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 20px; }
  .card { background: #1e293b; border-radius: 12px; overflow: hidden; border: 1px solid #334155; }
  .card-img { background: #0f172a; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .card-img img { width: 100%; height: 100%; object-fit: contain; }
  .no-img { color: #64748b; font-size: 14px; }
  .card-body { padding: 16px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px; }
  .filename { font-weight: 600; font-size: 14px; word-break: break-all; }
  .total { color: white; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; white-space: nowrap; }
  .ip-risk { background: #7f1d1d; color: #fecaca; padding: 8px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
  .scores { margin-bottom: 12px; }
  .score-row { display: grid; grid-template-columns: 160px 1fr 50px; gap: 8px; align-items: center; margin-bottom: 4px; font-size: 12px; }
  .score-label { color: #94a3b8; text-transform: capitalize; }
  .bar-bg { background: #0f172a; height: 8px; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; transition: width 0.3s; }
  .score-num { text-align: right; font-weight: 600; font-size: 12px; }
  .hypothesis, .failures, .keywords { font-size: 13px; margin-bottom: 8px; line-height: 1.5; }
  .failures ul { margin: 4px 0 0 16px; padding: 0; }
  .kw-block { margin-bottom: 4px; }
  .kw-emp { color: #6ee7b7; }
  .kw-rem { color: #fca5a5; }
  .meta { font-size: 11px; color: #64748b; margin-top: 8px; }
  .kw-table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
  .kw-table th, .kw-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #334155; font-size: 13px; }
  .kw-table th { background: #0f172a; color: #94a3b8; font-weight: 600; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat { background: #1e293b; padding: 16px; border-radius: 8px; border: 1px solid #334155; }
  .stat-label { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .stat-value { font-size: 24px; font-weight: 700; }
</style>
</head>
<body>
  <h1>Ad Scorer Report</h1>
  <div class="subtitle">${records.length} ad${records.length === 1 ? "" : "s"} scored · generated ${new Date().toISOString()}</div>

  <div class="summary">
    <div class="stat"><div class="stat-label">Total scored</div><div class="stat-value">${records.length}</div></div>
    <div class="stat"><div class="stat-label">Winners</div><div class="stat-value" style="color:#10b981">${records.filter((r) => r.result.verdict === "winner").length}</div></div>
    <div class="stat"><div class="stat-label">Candidates</div><div class="stat-value" style="color:#f59e0b">${records.filter((r) => r.result.verdict === "candidate").length}</div></div>
    <div class="stat"><div class="stat-label">Rejects</div><div class="stat-value" style="color:#ef4444">${records.filter((r) => r.result.verdict === "reject").length}</div></div>
    <div class="stat"><div class="stat-label">IP risks flagged</div><div class="stat-value" style="color:#ef4444">${records.filter((r) => r.result.ip_or_legal_risk).length}</div></div>
    <div class="stat"><div class="stat-label">Avg score</div><div class="stat-value">${records.length ? (records.reduce((s, r) => s + r.result.total, 0) / records.length).toFixed(1) : "—"}/40</div></div>
  </div>

  <h2>Top keywords to emphasize (winning patterns)</h2>
  ${kwTable(topEmphasize, "emp")}

  <h2>Top keywords to remove (anti-patterns / PPT病 signals)</h2>
  ${kwTable(topRemove, "rem")}

  <h2>All ads (ranked by score)</h2>
  <div class="grid">${cards}</div>
</body>
</html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf-8");
}

export function generateCsv(records: ImageRecord[], outputPath: string) {
  const headers = [
    "id",
    "filename",
    "scored_at",
    "verdict",
    "total",
    "focal_point",
    "information_density",
    "information_hierarchy",
    "brand_consistency",
    "differentiation",
    "emotional_tone",
    "cta_clarity",
    "anti_ai_feel",
    "winning_hypothesis",
    "failure_modes",
    "keywords_emphasize",
    "keywords_remove",
    "ip_or_legal_risk",
  ];

  const rows = records.map((r) => [
    r.id,
    r.filename,
    r.scored_at,
    r.result.verdict,
    r.result.total,
    r.result.scores.focal_point,
    r.result.scores.information_density,
    r.result.scores.information_hierarchy,
    r.result.scores.brand_consistency,
    r.result.scores.differentiation,
    r.result.scores.emotional_tone,
    r.result.scores.cta_clarity,
    r.result.scores.anti_ai_feel,
    r.result.winning_hypothesis,
    r.result.failure_modes.join("; "),
    r.result.suggested_keywords_to_emphasize.join("; "),
    r.result.suggested_keywords_to_remove.join("; "),
    r.result.ip_or_legal_risk || "",
  ]);

  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, csv, "utf-8");
}

function csvEscape(v: any): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
