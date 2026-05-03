// Claude vision API wrapper for scoring ad images
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { ScoreResult } from "./types.js";
import { buildSystemPrompt, BrandContext, AdType } from "./rubric.js";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

type SupportedMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

const MEDIA_TYPE_MAP: Record<string, SupportedMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Anthropic vision caps at 5MB raw bytes per image. Threshold at 4MB leaves
// headroom — gen pipeline outputs 8-10MB PNGs that would otherwise fail every
// API call. Downscale via macOS `sips` to 1280px JPEG (~300-500KB).
const MAX_IMAGE_BYTES = 4_000_000;

export class Scorer {
  private client: Anthropic;
  private model: string;
  private brand: BrandContext;

  constructor(apiKey: string, model: string, brand: BrandContext) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.brand = brand;
  }

  static isSupportedImage(filepath: string): boolean {
    return SUPPORTED_EXTENSIONS.has(path.extname(filepath).toLowerCase());
  }

  /**
   * If `filepath` exceeds MAX_IMAGE_BYTES, downscale to 1280px JPEG via macOS
   * `sips` and return a temp filepath that the caller MUST clean up via the
   * returned cleanup callback. If `sips` fails or isn't available (non-macOS),
   * returns the original filepath untouched and the API call will surface the
   * documented size error.
   */
  private maybeDownscale(
    filepath: string,
    originalMediaType: SupportedMediaType
  ): { effectivePath: string; mediaType: SupportedMediaType; cleanup?: () => void } {
    let size: number;
    try {
      size = fs.statSync(filepath).size;
    } catch {
      return { effectivePath: filepath, mediaType: originalMediaType };
    }
    if (size <= MAX_IMAGE_BYTES) {
      return { effectivePath: filepath, mediaType: originalMediaType };
    }
    const tmpId = crypto.randomBytes(6).toString("hex");
    const tmpPath = path.join(os.tmpdir(), `ad-scorer-downscaled-${tmpId}.jpg`);
    try {
      execFileSync(
        "sips",
        ["-Z", "1280", "-s", "format", "jpeg", "-s", "formatOptions", "80", filepath, "--out", tmpPath],
        { stdio: "ignore" }
      );
      return {
        effectivePath: tmpPath,
        mediaType: "image/jpeg",
        cleanup: () => {
          try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
        },
      };
    } catch {
      return { effectivePath: filepath, mediaType: originalMediaType };
    }
  }

  async scoreImage(
    filepath: string,
    adType: AdType = "alphawalk"
  ): Promise<{ result: ScoreResult; raw: string; model: string }> {
    const ext = path.extname(filepath).toLowerCase();
    const originalMediaType = MEDIA_TYPE_MAP[ext];
    if (!originalMediaType) {
      throw new Error(`Unsupported image format: ${ext}`);
    }

    const { effectivePath, mediaType, cleanup } = this.maybeDownscale(filepath, originalMediaType);

    try {
      const imageData = fs.readFileSync(effectivePath).toString("base64");
      const systemPrompt = buildSystemPrompt(this.brand, "paid_media", adType);

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: imageData,
                },
              },
              {
                type: "text",
                text: `Score this ad image.

Respond ONLY with valid JSON matching the schema in the system prompt. Do not include any preamble, markdown fences, or explanation. Begin your response with { and end with }.`,
              },
            ],
          },
        ],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text content in Claude response");
      }
      const raw = textBlock.text;

      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      let result: ScoreResult;
      try {
        result = JSON.parse(cleaned) as ScoreResult;
      } catch {
        // Rescue: model wrapped JSON in prose. Extract the first balanced { ... } block.
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
          throw new Error(
            `Failed to parse Claude response as JSON; no JSON block found.\n\nRaw: ${raw.slice(0, 500)}`
          );
        }
        try {
          result = JSON.parse(match[0]) as ScoreResult;
        } catch (err) {
          throw new Error(
            `Failed to parse Claude response as JSON: ${(err as Error).message}\n\nRaw: ${raw.slice(0, 500)}`
          );
        }
      }

      // Validate + auto-correct total
      const computedTotal = Object.values(result.scores).reduce((a, b) => a + b, 0);
      if (result.total !== computedTotal) {
        result.total = computedTotal;
      }

      return { result, raw, model: response.model };
    } finally {
      if (cleanup) cleanup();
    }
  }

  /**
   * Score one image N times in parallel. Returns the successful runs and any
   * errors. Caller decides whether to write to DB based on success count.
   */
  async scoreImageMultiShot(
    filepath: string,
    adType: AdType,
    n: number
  ): Promise<{
    runs: { result: ScoreResult; raw: string; model: string }[];
    errors: Error[];
  }> {
    const settled = await Promise.allSettled(
      Array.from({ length: n }, () => this.scoreImage(filepath, adType))
    );
    const runs: { result: ScoreResult; raw: string; model: string }[] = [];
    const errors: Error[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") runs.push(s.value);
      else errors.push(s.reason as Error);
    }
    return { runs, errors };
  }
}
