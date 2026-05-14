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

// Forced-structured-output contract. tool_choice pins this tool, so the model
// cannot reply with prose. input_schema is the wire-level enforcement of the
// ScoreResult shape declared in types.ts — drift between the two will surface
// as an API-level tool_use_input validation error rather than a silent cast.
export const SCORE_AD_TOOL: Anthropic.Tool = {
  name: "score_ad",
  description:
    "Record your structured evaluation of this ad image against the 8-dimension rubric defined in the system prompt. You MUST use this tool — do not respond with prose. The system prompt's DO NOT DOUBLE-PENALIZE rule and IP/legal rules still apply.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "scores",
      "total",
      "winning_hypothesis",
      "failure_modes",
      "suggested_keywords_to_emphasize",
      "suggested_keywords_to_remove",
      "ip_or_legal_risk",
      "verdict",
    ],
    properties: {
      scores: {
        type: "object",
        description:
          "Per-dimension scores. Each dimension is 0-5. Match the closest anchor description in the system-prompt rubric — don't average.",
        additionalProperties: false,
        required: [
          "focal_point",
          "information_density",
          "information_hierarchy",
          "brand_consistency",
          "differentiation",
          "emotional_tone",
          "cta_clarity",
          "anti_ai_feel",
        ],
        properties: {
          focal_point: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            description:
              "Does the eye find ONE clear subject in <3 seconds? 5: single dominant subject, instant attraction. 0: pure collage with no intentional focal point.",
          },
          information_density: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            description:
              "PPT病 detector — how many distinct visual elements compete for attention? 5: ≤3 distinct elements, deliberate negative space. 0: total visual stuffing, 10+ elements, no negative space.",
          },
          information_hierarchy: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            description:
              "Brand → headline → subhead → CTA clearly tiered? 5: crystal clear reading order. 0: no hierarchy, everything fights.",
          },
          brand_consistency: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            description:
              "Does it look like THIS brand specifically? 5: distinctly on-brand — could ONLY be this brand. 0: generic / off-brand / clashing.",
          },
          differentiation: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            description:
              "Cover the logo — still recognizable as this product? 5: unique visual identity. 0: swap logo and it's any product.",
          },
          emotional_tone: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            description:
              "Matches brand archetype AND placement context (paid_media vs organic_social etc.)? 5: perfect emotional resonance. 0: actively damaging to brand.",
          },
          cta_clarity: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            description:
              "Does the user know exactly what to do next? 5: single, prominent, unambiguous CTA. 0: no CTA at all.",
          },
          anti_ai_feel: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            description:
              "Avoids the 'obviously AI-generated' look? 5: crafted, intentional, human-feeling — no AI tells. 0: pure AI sludge, multiple severe artifacts.",
          },
        },
      },
      total: {
        type: "integer",
        minimum: 0,
        maximum: 40,
        description:
          "Sum of the 8 dimension scores (0-40). Caller auto-corrects if it doesn't match — but you should compute it yourself.",
      },
      winning_hypothesis: {
        type: "string",
        description:
          "1-2 sentence diagnosis of why this ad works, or 'none — fundamental rework needed' if it doesn't.",
      },
      failure_modes: {
        type: "array",
        items: { type: "string" },
        description:
          "Specific issues with the ad. Each item is one issue (e.g. 'feature list overlay', 'competing CTAs'). DO NOT DOUBLE-PENALIZE — a single failure should appear in 1-2 dimensions max.",
      },
      suggested_keywords_to_emphasize: {
        type: "array",
        items: { type: "string" },
        description:
          "2-5 SHORT atomic phrases (3-6 words each) for positive prompt seeds. Each item is ONE concept, not a compound list. Examples: 'single character POV', 'cinematic night lighting', 'dual monitor setup'.",
      },
      suggested_keywords_to_remove: {
        type: "array",
        items: { type: "string" },
        description:
          "2-5 SHORT atomic phrases (3-6 words each) for negative prompts. Each item is ONE concept. Examples: 'split-screen comparison', 'billboard collage', 'feature list overlay'.",
      },
      ip_or_legal_risk: {
        type: ["string", "null"],
        description:
          "null if no IP/legal risk. Otherwise a specific description (e.g. 'resembles Chihaya Anon from BanG Dream!', 'unauthorized use of Robinhood logo'). Follow the ALWAYS-IP and mode-specific rules in the system prompt.",
      },
      verdict: {
        type: "string",
        enum: ["winner", "candidate", "reject"],
        description:
          "winner: total ≥ 30 AND no IP risk AND no dimension below 3. candidate: total 20-29 OR one weakness fixable via prompt iteration. reject: total < 20 OR ANY IP risk OR information_density ≤ 1 (PPT病).",
      },
    },
  },
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
        tools: [SCORE_AD_TOOL],
        tool_choice: { type: "tool", name: "score_ad" },
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
                text: "Score this ad image. Call the score_ad tool with your evaluation.",
              },
            ],
          },
        ],
      });

      const toolUseBlock = response.content.find(
        (b) => b.type === "tool_use" && b.name === "score_ad"
      );
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        const blockTypes = response.content.map((b) => b.type).join(",");
        throw new Error(
          `Claude response missing score_ad tool_use block. stop_reason=${response.stop_reason}, content=[${blockTypes}]`
        );
      }

      // toolUseBlock.input is typed as `unknown` because tool input schemas are
      // user-defined. The API has already validated it against SCORE_AD_TOOL's
      // input_schema (required fields, types, enum, min/max) — so the cast is
      // schema-checked at the wire layer, unlike the old JSON.parse-and-cast.
      const result = toolUseBlock.input as ScoreResult;
      const raw = JSON.stringify(toolUseBlock.input);

      // Validate + auto-correct total. Schema enforces sum range 0-40 but the
      // model can still return a `total` that disagrees with the dimension sum
      // (e.g. arithmetic slip). Keep the canonical-from-scores rule.
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
