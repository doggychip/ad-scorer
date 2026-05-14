import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Hoisted shared state — vi.mock factory runs at module-load time, so the mock
// fn has to live in the hoisted scope to be addressable from tests.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// Import AFTER vi.mock so Scorer's `new Anthropic(...)` resolves to the mock.
import { Scorer, SCORE_AD_TOOL } from "../src/scorer.js";
import { ScoreResult } from "../src/types.js";

// 1x1 transparent PNG, base64-decoded. scoreImage calls fs.readFileSync on
// this; the bytes themselves don't matter (we mock the API), only that the
// file exists and has a supported extension.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

const BRAND = {
  brandName: "Alphawalk",
  brandTagline: "AI investment assistant for retail traders",
  brandColors: "navy + warm cream",
  brandArchetype: "the patient analyst",
};

function mkScores(overrides: Partial<ScoreResult["scores"]> = {}) {
  return {
    focal_point: 4,
    information_density: 4,
    information_hierarchy: 4,
    brand_consistency: 4,
    differentiation: 3,
    emotional_tone: 4,
    cta_clarity: 4,
    anti_ai_feel: 4,
    ...overrides,
  };
}

function mkResult(overrides: Partial<ScoreResult> = {}): ScoreResult {
  const scores = mkScores(overrides.scores);
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  return {
    scores,
    total,
    winning_hypothesis: "clear single subject with brand-correct palette",
    failure_modes: ["differentiation could be stronger"],
    suggested_keywords_to_emphasize: ["single character POV", "cinematic lighting"],
    suggested_keywords_to_remove: ["billboard collage"],
    ip_or_legal_risk: null,
    verdict: "winner",
    ...overrides,
  };
}

function mkToolUseResponse(input: unknown, opts: { model?: string; stop_reason?: string } = {}) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: opts.model ?? "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use" as const,
        id: "toolu_test",
        name: "score_ad",
        input,
      },
    ],
    stop_reason: opts.stop_reason ?? "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe("Scorer.scoreImage — tool-use forced structured output", () => {
  let tmpDir: string;
  let imgPath: string;

  beforeEach(() => {
    mockCreate.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scorer-test-"));
    imgPath = path.join(tmpDir, "test.png");
    fs.writeFileSync(imgPath, TINY_PNG);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("constructs request with tools, tool_choice forcing score_ad, image block, and brand-injected system prompt", async () => {
    mockCreate.mockResolvedValueOnce(mkToolUseResponse(mkResult()));

    const scorer = new Scorer("fake-key", "claude-sonnet-4-6", BRAND);
    await scorer.scoreImage(imgPath, "alphawalk");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const req = mockCreate.mock.calls[0][0];

    expect(req.model).toBe("claude-sonnet-4-6");
    expect(req.max_tokens).toBe(1500);
    expect(typeof req.system).toBe("string");
    expect(req.system).toContain("Alphawalk");
    // The "respond ONLY with valid JSON" prose path is gone — schema enforces shape.
    expect(req.system).not.toContain("Output ONLY valid JSON");
    expect(req.system).not.toContain("no markdown fences");

    expect(req.tools).toEqual([SCORE_AD_TOOL]);
    expect(req.tool_choice).toEqual({ type: "tool", name: "score_ad" });

    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content).toHaveLength(2);
    expect(req.messages[0].content[0].type).toBe("image");
    expect(req.messages[0].content[0].source.type).toBe("base64");
    expect(req.messages[0].content[0].source.media_type).toBe("image/png");
    expect(req.messages[0].content[1].type).toBe("text");
    expect(req.messages[0].content[1].text).toContain("score_ad");
  });

  it("clean pass: extracts ScoreResult from tool_use block, raw is JSON of input, model is echoed", async () => {
    const cleanInput = mkResult({ verdict: "winner" });
    mockCreate.mockResolvedValueOnce(mkToolUseResponse(cleanInput, { model: "claude-sonnet-4-6" }));

    const scorer = new Scorer("k", "claude-sonnet-4-6", BRAND);
    const { result, raw, model } = await scorer.scoreImage(imgPath);

    expect(result.verdict).toBe("winner");
    expect(result.total).toBe(31); // = mkScores() sum
    expect(result.ip_or_legal_risk).toBeNull();
    expect(result.suggested_keywords_to_emphasize).toContain("single character POV");
    expect(result.failure_modes).toEqual(["differentiation could be stronger"]);

    // raw is the JSON-serialized tool input — the new equivalent of the old
    // text-mode raw_response, used by db.ts to persist the model's literal output.
    expect(JSON.parse(raw)).toEqual(cleanInput);
    expect(model).toBe("claude-sonnet-4-6");
  });

  it("auto-corrects total when model arithmetic disagrees with scores sum", async () => {
    // Scores sum to 31, but mock the model returning total=40 (an arithmetic slip).
    const wrongTotal = mkResult();
    wrongTotal.total = 40;
    mockCreate.mockResolvedValueOnce(mkToolUseResponse(wrongTotal));

    const scorer = new Scorer("k", "claude-sonnet-4-6", BRAND);
    const { result } = await scorer.scoreImage(imgPath);

    expect(result.total).toBe(31);
  });

  it("low-score reject: passes verdict=reject and full failure_modes through unchanged", async () => {
    const rejectInput = mkResult({
      scores: {
        focal_point: 1,
        information_density: 1,
        information_hierarchy: 2,
        brand_consistency: 2,
        differentiation: 1,
        emotional_tone: 2,
        cta_clarity: 1,
        anti_ai_feel: 1,
      },
      winning_hypothesis: "none — fundamental rework needed",
      failure_modes: ["feature list overlay", "competing CTAs", "generic AI-stock-photo aesthetic"],
      suggested_keywords_to_emphasize: ["single character POV"],
      suggested_keywords_to_remove: ["feature list overlay", "billboard collage", "split-screen comparison"],
      verdict: "reject",
    });
    mockCreate.mockResolvedValueOnce(mkToolUseResponse(rejectInput));

    const scorer = new Scorer("k", "claude-sonnet-4-6", BRAND);
    const { result } = await scorer.scoreImage(imgPath);

    expect(result.verdict).toBe("reject");
    expect(result.total).toBe(11);
    expect(result.failure_modes).toHaveLength(3);
    expect(result.failure_modes).toContain("feature list overlay");
  });

  it("structurally invalid tool_use input (missing required field): documents current behavior — partial result returned, runtime validation is downstream", async () => {
    // In production the API's input_schema enforcement should prevent this from
    // reaching the SDK. This fixture simulates a payload slipping through (e.g.
    // an API version that doesn't strict-validate, or a future schema drift).
    // scorer.ts does not runtime-validate beyond the total auto-correct, so the
    // partial input arrives in db.ts where the NOT NULL verdict column rejects it.
    // This test documents the failure surface — it does not assert that scoreImage
    // itself catches the missing field.
    const malformed: Partial<ScoreResult> = mkResult();
    delete malformed.verdict;
    mockCreate.mockResolvedValueOnce(mkToolUseResponse(malformed));

    const scorer = new Scorer("k", "claude-sonnet-4-6", BRAND);
    const { result } = await scorer.scoreImage(imgPath);

    expect((result as Partial<ScoreResult>).verdict).toBeUndefined();
    // scores + total are still present, so the total auto-correct still runs.
    expect(result.total).toBe(31);
  });

  it("throws clearly when response contains no tool_use block (e.g. max_tokens before tool serialization, or refusal)", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "I cannot evaluate this image." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const scorer = new Scorer("k", "claude-sonnet-4-6", BRAND);
    // /s flag lets . match newlines; checks both message substrings in one assertion
    // so we only consume the one mocked response.
    await expect(scorer.scoreImage(imgPath)).rejects.toThrow(
      /missing score_ad tool_use block.*stop_reason=end_turn/s
    );
  });

  it("throws when tool_use block uses a different tool name (defense against tool_choice misroute)", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "tool_use",
          id: "toolu_other",
          name: "some_other_tool",
          input: { foo: "bar" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    const scorer = new Scorer("k", "claude-sonnet-4-6", BRAND);
    await expect(scorer.scoreImage(imgPath)).rejects.toThrow(/missing score_ad tool_use block/);
  });
});
