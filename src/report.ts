// HTML report + CSV export
import fs from "fs";
import path from "path";
import { AggregatedRecord, ImageRecord, KeywordAggregation } from "./types.js";
import { formatStability } from "./aggregate.js";

const VERDICT_COLOR: Record<string, string> = {
  winner: "#10b981",
  candidate: "#f59e0b",
  reject: "#ef4444",
};

// User-facing verdict labels (Simplified Chinese for shareability with
// non-English colleagues). DB values stay as winner/candidate/reject.
const VERDICT_LABEL: Record<string, string> = {
  winner: "优胜",
  candidate: "候选",
  reject: "不合格",
};

// User-facing dimension labels. Keys must match `result.scores` field names.
const DIMENSION_LABEL: Record<string, string> = {
  focal_point: "焦点",
  information_density: "信息密度",
  information_hierarchy: "信息层级",
  brand_consistency: "品牌一致性",
  differentiation: "差异化",
  emotional_tone: "情绪调性",
  cta_clarity: "CTA清晰度",
  anti_ai_feel: "反AI痕迹",
};

const STABILITY_COLOR: Record<string, string> = {
  stable: "#10b981",
  unstable: "#f59e0b",
  "single-shot": "#6b7280",
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
  records: AggregatedRecord[],
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
      const verdictLabel = VERDICT_LABEL[r.result.verdict] || r.result.verdict;
      const ipBadge = r.result.ip_or_legal_risk
        ? `<div class="ip-risk">⚠️ IP/法律风险:${escapeHtml(r.result.ip_or_legal_risk)}</div>`
        : "";

      const scoreBars = Object.entries(r.result.scores)
        .map(([k, v]) => {
          const pct = (v / 5) * 100;
          const barColor = v >= 4 ? "#10b981" : v >= 3 ? "#f59e0b" : "#ef4444";
          const label = DIMENSION_LABEL[k] || k.replace(/_/g, " ");
          return `<div class="score-row"><span class="score-label">${label}</span><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor}"></div></div><span class="score-num">${v}/5</span></div>`;
        })
        .join("");

      return `
        <div class="card">
          <div class="card-img">${imgHtml}</div>
          <div class="card-body">
            <div class="card-header">
              <span class="filename">${escapeHtml(r.filename)}</span>
              <span class="total" style="background:${verdictColor}">${r.result.total}${r.std_total !== null ? `±${r.std_total.toFixed(1)}` : ""}/40 · ${verdictLabel}</span>
              <span class="stability" style="background:${STABILITY_COLOR[r.stability]}">${formatStability(r.stability)}</span>
            </div>
            ${ipBadge}
            <div class="scores">${scoreBars}</div>
            <div class="hypothesis"><strong>优胜假设:</strong> ${escapeHtml(r.result.winning_hypothesis)}</div>
            ${r.result.failure_modes.length ? `<div class="failures"><strong>失败模式:</strong><ul>${r.result.failure_modes.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>` : ""}
            <div class="keywords">
              <div class="kw-block kw-emp"><strong>✓ 强化:</strong> ${r.result.suggested_keywords_to_emphasize.map(escapeHtml).join(", ") || "—"}</div>
              <div class="kw-block kw-rem"><strong>✗ 移除:</strong> ${r.result.suggested_keywords_to_remove.map(escapeHtml).join(", ") || "—"}</div>
            </div>
            <div class="meta">评分时间 ${r.scored_at} · id ${r.id}</div>
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
      <thead><tr><th>关键词</th><th>${type === "emp" ? "强化次数" : "移除次数"}</th><th>净值</th><th>出现时平均分</th></tr></thead>
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
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>广告评分报告 — ${new Date().toISOString().split("T")[0]}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
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
  .stability { color: white; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; margin-left: 4px; }
  .ip-risk { background: #7f1d1d; color: #fecaca; padding: 8px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
  .scores { margin-bottom: 12px; }
  .score-row { display: grid; grid-template-columns: 110px 1fr 50px; gap: 8px; align-items: center; margin-bottom: 4px; font-size: 12px; }
  .score-label { color: #94a3b8; }
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
  .stat-label { color: #94a3b8; font-size: 12px; margin-bottom: 4px; }
  .stat-value { font-size: 24px; font-weight: 700; }
</style>
</head>
<body>
  <h1>广告评分报告</h1>
  <div class="subtitle">${records.length} 张广告已评分 · 生成于 ${new Date().toISOString()}</div>

  <div class="summary">
    <div class="stat"><div class="stat-label">总评分数</div><div class="stat-value">${records.length}</div></div>
    <div class="stat"><div class="stat-label">优胜</div><div class="stat-value" style="color:#10b981">${records.filter((r) => r.result.verdict === "winner").length}</div></div>
    <div class="stat"><div class="stat-label">候选</div><div class="stat-value" style="color:#f59e0b">${records.filter((r) => r.result.verdict === "candidate").length}</div></div>
    <div class="stat"><div class="stat-label">不合格</div><div class="stat-value" style="color:#ef4444">${records.filter((r) => r.result.verdict === "reject").length}</div></div>
    <div class="stat"><div class="stat-label">IP风险警示</div><div class="stat-value" style="color:#ef4444">${records.filter((r) => r.result.ip_or_legal_risk).length}</div></div>
    <div class="stat"><div class="stat-label">不稳定</div><div class="stat-value" style="color:#f59e0b">${records.filter((r) => r.stability === "unstable").length}</div></div>
    <div class="stat"><div class="stat-label">平均分</div><div class="stat-value">${records.length ? (records.reduce((s, r) => s + r.result.total, 0) / records.length).toFixed(1) : "—"}/40</div></div>
  </div>

  <h2>建议强化的关键词(优胜模式)</h2>
  ${kwTable(topEmphasize, "emp")}

  <h2>建议移除的关键词(反模式 / PPT病信号)</h2>
  ${kwTable(topRemove, "rem")}

  <h2>全部广告(按分数排序)</h2>
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
