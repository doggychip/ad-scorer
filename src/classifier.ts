// Cheap pre-scoring brand classifier. Catches the recurring failure mode
// where competitor screenshots get dropped into a folder labelled as
// alphawalk creatives and the full Sonnet rubric scores them all as
// IP-RISK rejects (then user has to delete + re-route to /benchmarks/).
//
// One Haiku 4.5 vision call per image, ~$0.0025 each. Returns the detected
// primary-advertiser brand (or null if none recognized). Caller decides
// what to do with the result.
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";

const MEDIA_TYPE_MAP: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_IMAGE_BYTES = 4_000_000;

const CLASSIFIER_SYSTEM_PROMPT = `You are a brand classifier for ad images. Identify the PRIMARY ADVERTISER — the brand running the ad — not brands mentioned in passing, shown as stock pins, or appearing in screenshots of third-party apps.

Brands to recognize (non-exhaustive):
- Trading/finance: Robinhood, Interactive Brokers, IBKR, eToro, Webull, Charles Schwab, Fidelity, E*TRADE, Vanguard, SoFi, Public, Tastytrade, Wealthfront, Betterment, Marcus by Goldman Sachs
- Crypto: Coinbase, Binance, Kraken, Crypto.com, OKX, Bybit, Gate.io
- Payments/fintech: PayPal, Stripe, Block, Affirm, Klarna, Wise, Revolut, Chime, Plaid
- Big tech / consumer if they're the advertiser: Apple, Google, Microsoft, Meta, Amazon, Tesla, Netflix
- Or any other clearly-recognizable global brand whose logo dominates the ad

Return ONLY valid JSON, no preamble or markdown fences:
{"brand": "Robinhood"}  → primary advertiser is Robinhood
{"brand": "Interactive Brokers"}  → primary advertiser is IBKR
{"brand": null}  → no clear primary advertiser brand visible, OR you're not sure, OR brand is unknown to you

Use canonical brand spelling. Be conservative — return null if uncertain.`;

function maybeDownscale(filepath: string): { effectivePath: string; mediaType: typeof MEDIA_TYPE_MAP[string]; cleanup?: () => void } {
  const ext = path.extname(filepath).toLowerCase();
  const originalMediaType = MEDIA_TYPE_MAP[ext];
  if (!originalMediaType) throw new Error(`Unsupported image format: ${ext}`);
  let size: number;
  try {
    size = fs.statSync(filepath).size;
  } catch {
    return { effectivePath: filepath, mediaType: originalMediaType };
  }
  if (size <= MAX_IMAGE_BYTES) return { effectivePath: filepath, mediaType: originalMediaType };
  const tmpId = crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(os.tmpdir(), `ad-scorer-classifier-${tmpId}.jpg`);
  try {
    execFileSync(
      "sips",
      ["-Z", "1280", "-s", "format", "jpeg", "-s", "formatOptions", "80", filepath, "--out", tmpPath],
      { stdio: "ignore" }
    );
    return {
      effectivePath: tmpPath,
      mediaType: "image/jpeg",
      cleanup: () => { try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ } },
    };
  } catch {
    return { effectivePath: filepath, mediaType: originalMediaType };
  }
}

export async function classifyAdvertiser(
  client: Anthropic,
  filepath: string,
  model = "claude-haiku-4-5-20251001"
): Promise<{ brand: string | null }> {
  const { effectivePath, mediaType, cleanup } = maybeDownscale(filepath);
  try {
    const imageData = fs.readFileSync(effectivePath).toString("base64");
    const response = await client.messages.create({
      model,
      max_tokens: 100,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageData } },
            { type: "text", text: `Classify the primary advertiser. Respond with JSON only.` },
          ],
        },
      ],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return { brand: null };
    const raw = textBlock.text.trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    try {
      const parsed = JSON.parse(cleaned) as { brand: string | null };
      return { brand: parsed.brand ?? null };
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return { brand: null };
      try {
        const parsed = JSON.parse(match[0]) as { brand: string | null };
        return { brand: parsed.brand ?? null };
      } catch {
        return { brand: null };
      }
    }
  } finally {
    if (cleanup) cleanup();
  }
}

/** Run classifier on N images in parallel via Promise.allSettled. Failed
 *  classifications are reported as { brand: null } so the gate doesn't
 *  spuriously block on transient errors. */
export async function classifyAll(
  client: Anthropic,
  filepaths: string[],
  model?: string
): Promise<{ filepath: string; brand: string | null }[]> {
  const settled = await Promise.allSettled(
    filepaths.map((fp) => classifyAdvertiser(client, fp, model))
  );
  return settled.map((s, i) => ({
    filepath: filepaths[i],
    brand: s.status === "fulfilled" ? s.value.brand : null,
  }));
}
