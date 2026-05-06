import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  summarizeBatch,
  formatTextDigest,
  buildLarkTextPayload,
  signLarkPayload,
} from "../src/notify.js";
import type { AggregatedRecord, RubricScores, Stability } from "../src/types.js";

function mkRecord(args: {
  filename: string;
  total: number;
  verdict?: AggregatedRecord["result"]["verdict"];
  stability?: Stability;
  ip?: string | null;
  std?: number | null;
  dims?: Partial<RubricScores>;
}): AggregatedRecord {
  const baseDims: RubricScores = {
    focal_point: 4,
    information_density: 4,
    information_hierarchy: 4,
    brand_consistency: 3,
    differentiation: 3,
    emotional_tone: 3,
    cta_clarity: 3,
    anti_ai_feel: args.total - 24,
  };
  return {
    id: 1,
    filename: args.filename,
    filepath: `/p/${args.filename}`,
    scored_at: "2026-05-06 12:00:00",
    batch_id: `b-${args.filename}`,
    batch_size: 3,
    std_total: args.std ?? 0.8,
    stability: args.stability ?? "stable",
    result: {
      scores: { ...baseDims, ...args.dims },
      total: args.total,
      winning_hypothesis: "h",
      failure_modes: [],
      suggested_keywords_to_emphasize: [],
      suggested_keywords_to_remove: [],
      ip_or_legal_risk: args.ip ?? null,
      verdict: args.verdict ?? (args.total >= 28 ? "winner" : args.total >= 22 ? "candidate" : "reject"),
    },
  };
}

describe("summarizeBatch", () => {
  it("counts verdicts and computes average correctly", () => {
    const records = [
      mkRecord({ filename: "a.jpg", total: 30 }),
      mkRecord({ filename: "b.jpg", total: 25 }),
      mkRecord({ filename: "c.jpg", total: 18 }),
      mkRecord({ filename: "d.jpg", total: 32 }),
    ];
    const s = summarizeBatch(records, "creatives/2026-05-06/", "2026-05-06");
    expect(s.total).toBe(4);
    expect(s.winners).toBe(2);
    expect(s.candidates).toBe(1);
    expect(s.rejects).toBe(1);
    expect(s.averageTotal).toBeCloseTo((30 + 25 + 18 + 32) / 4, 6);
  });

  it("topWinners is sorted by total desc, capped at 3", () => {
    const records = [
      mkRecord({ filename: "low.jpg", total: 22 }),
      mkRecord({ filename: "mid.jpg", total: 28 }),
      mkRecord({ filename: "high.jpg", total: 35 }),
      mkRecord({ filename: "lower.jpg", total: 24 }),
      mkRecord({ filename: "highest.jpg", total: 38 }),
    ];
    const s = summarizeBatch(records, "scope");
    expect(s.topWinners.map((w) => w.filename)).toEqual(["highest.jpg", "high.jpg", "mid.jpg"]);
    expect(s.topWinners[0].total).toBe(38);
  });

  it("ipRisks list is capped at 5; flagged count reflects all", () => {
    const records = Array.from({ length: 8 }, (_, i) =>
      mkRecord({ filename: `r${i}.jpg`, total: 25, ip: `risk ${i}` })
    );
    const s = summarizeBatch(records, "scope");
    expect(s.ipFlagged).toBe(8);
    expect(s.ipRisks).toHaveLength(5);
  });

  it("counts unstable batches", () => {
    const records = [
      mkRecord({ filename: "a.jpg", total: 28, stability: "stable" }),
      mkRecord({ filename: "b.jpg", total: 28, stability: "unstable" }),
      mkRecord({ filename: "c.jpg", total: 28, stability: "single-shot" }),
    ];
    const s = summarizeBatch(records, "scope");
    expect(s.unstable).toBe(1);
  });

  it("empty records → averageTotal=null, lists empty, total=0", () => {
    const s = summarizeBatch([], "scope");
    expect(s.total).toBe(0);
    expect(s.averageTotal).toBeNull();
    expect(s.topWinners).toEqual([]);
    expect(s.ipRisks).toEqual([]);
  });
});

describe("formatTextDigest", () => {
  it("includes title, scope, all verdict counts, and average in zh by default", () => {
    const s = summarizeBatch(
      [mkRecord({ filename: "a.jpg", total: 30 }), mkRecord({ filename: "b.jpg", total: 22 })],
      "creatives/today/",
      "2026-05-06"
    );
    const txt = formatTextDigest(s);
    expect(txt).toContain("广告评分报告");
    expect(txt).toContain("2026-05-06");
    expect(txt).toContain("creatives/today/");
    expect(txt).toContain("优胜: 1");
    expect(txt).toContain("候选: 1");
    expect(txt).toContain("不合格: 0");
    expect(txt).toContain("平均分: 26.0 / 40");
  });

  it("English locale produces English labels", () => {
    const s = summarizeBatch([mkRecord({ filename: "a.jpg", total: 30 })], "scope", "2026-05-06");
    const txt = formatTextDigest(s, "en");
    expect(txt).toContain("Ad scoring digest");
    expect(txt).toContain("Winners: 1");
    expect(txt).toContain("Top winners");
  });

  it("empty records → terse 'nothing to send' line, no winners/risks blocks", () => {
    const s = summarizeBatch([], "scope", "2026-05-06");
    const txt = formatTextDigest(s);
    expect(txt).toContain("本次无可发送的评分结果");
    expect(txt).not.toContain("优胜:");
  });

  it("unstable + IP risk sections appear when counts > 0", () => {
    const records = [
      mkRecord({ filename: "u.jpg", total: 28, stability: "unstable", std: 2.5 }),
      mkRecord({ filename: "ip.jpg", total: 26, ip: "Genshin character spotted" }),
    ];
    const s = summarizeBatch(records, "scope");
    const txt = formatTextDigest(s);
    expect(txt).toMatch(/不稳定: 1/);
    expect(txt).toMatch(/IP\/法律风险: 1/);
    expect(txt).toContain("ip.jpg: Genshin character spotted");
  });

  it("emits std on top winners when present", () => {
    const records = [mkRecord({ filename: "a.jpg", total: 30, std: 1.4 })];
    const txt = formatTextDigest(summarizeBatch(records, "scope"));
    expect(txt).toContain("a.jpg — 30±1.4/40");
  });

  it("truncates long IP risk text to keep payload tight", () => {
    const long = "x".repeat(200);
    const records = [mkRecord({ filename: "a.jpg", total: 25, ip: long })];
    const txt = formatTextDigest(summarizeBatch(records, "scope"));
    // Find the IP-risk line specifically (matches "  a.jpg: <risk>"); the
    // top-winner line uses " — " not ":" so this disambiguates.
    const ipLine = txt.split("\n").find((l) => /a\.jpg:/.test(l)) || "";
    expect(ipLine).not.toBe("");
    // Truncated to 117 + "..." = 120 chars max for the risk portion
    expect(ipLine.length).toBeLessThan(160);
    expect(ipLine).toMatch(/\.\.\.$/);
  });

  it("indicates overflow when ipFlagged > 5", () => {
    const records = Array.from({ length: 7 }, (_, i) =>
      mkRecord({ filename: `r${i}.jpg`, total: 25, ip: "risk" })
    );
    const txt = formatTextDigest(summarizeBatch(records, "scope"));
    expect(txt).toContain("(+2 more)");
  });
});

describe("buildLarkTextPayload", () => {
  it("wraps text in Lark's text msg_type envelope", () => {
    const p = buildLarkTextPayload("hello");
    expect(p).toEqual({ msg_type: "text", content: { text: "hello" } });
  });
});

describe("signLarkPayload", () => {
  it("matches Lark's HMAC-SHA256 spec: HMAC(key='<ts>\\n<secret>', msg='').b64", () => {
    const secret = "test-secret";
    const nowMs = 1_700_000_000_000;
    const expectedTs = "1700000000";
    const expectedSign = crypto
      .createHmac("sha256", `${expectedTs}\n${secret}`)
      .update("")
      .digest("base64");

    const out = signLarkPayload(secret, nowMs);
    expect(out.timestamp).toBe(expectedTs);
    expect(out.sign).toBe(expectedSign);
  });

  it("is deterministic for the same inputs", () => {
    expect(signLarkPayload("s", 1234567890123)).toEqual(
      signLarkPayload("s", 1234567890123)
    );
  });

  it("changes when secret changes", () => {
    const a = signLarkPayload("a", 1700000000000);
    const b = signLarkPayload("b", 1700000000000);
    expect(a.sign).not.toBe(b.sign);
    expect(a.timestamp).toBe(b.timestamp);
  });

  it("changes when timestamp changes", () => {
    const a = signLarkPayload("s", 1700000000000);
    const b = signLarkPayload("s", 1700000001000);
    expect(a.timestamp).not.toBe(b.timestamp);
    expect(a.sign).not.toBe(b.sign);
  });

  it("returns timestamp in unix seconds (not ms)", () => {
    const { timestamp } = signLarkPayload("s", 1700000000999);
    expect(timestamp).toBe("1700000000");
  });
});
