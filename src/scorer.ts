// Claude vision API wrapper for scoring ad images
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { ScoreResult } from "./types.js";
import { buildSystemPrompt, BrandContext } from "./rubric.js";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const MEDIA_TYPE_MAP: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

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

  async scoreImage(filepath: string): Promise<{ result: ScoreResult; raw: string }> {
    const ext = path.extname(filepath).toLowerCase();
    const mediaType = MEDIA_TYPE_MAP[ext];
    if (!mediaType) {
      throw new Error(`Unsupported image format: ${ext}`);
    }

    const imageData = fs.readFileSync(filepath).toString("base64");
    const systemPrompt = buildSystemPrompt(this.brand);

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
              text: `Score this ad image. Output JSON only — start your response with { and end with }.`,
            },
          ],
        },
        // Prefill the assistant turn with `{` to lock in JSON output
        {
          role: "assistant",
          content: "{",
        },
      ],
    });

    // Extract text from response
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text content in Claude response");
    }
    // Reattach the prefilled `{`
    const raw = "{" + textBlock.text;

    // Parse, with cleanup for any stray markdown
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    let result: ScoreResult;
    try {
      result = JSON.parse(cleaned) as ScoreResult;
    } catch (err) {
      throw new Error(
        `Failed to parse Claude response as JSON: ${(err as Error).message}\n\nRaw: ${raw.slice(0, 500)}`
      );
    }

    // Validate + auto-correct total
    const computedTotal = Object.values(result.scores).reduce((a, b) => a + b, 0);
    if (result.total !== computedTotal) {
      result.total = computedTotal;
    }

    return { result, raw };
  }
}
