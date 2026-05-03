// next-prompts.ts
// Closes the gen → score → feedback loop. Reads recent winners/losers/keywords
// from the scoring DB plus the locked brand-dna.json, asks Claude Sonnet for N
// fresh image-gen prompts that compound the wins and avoid the failures.
//
// Output is natural-language prompts that work for both Gemini Imagen and
// ChatGPT Image 2.0 (similar prompt conventions). Saved to prompts/<date>.md.
//
// User flow:
//   npm run next-prompts --n 5
//   → copy prompts from output → paste into Gemini/ChatGPT → download images
//   → drop into creatives/<date>/ → npm run score
//   → tomorrow's next-prompts learns from today's results
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { ScoreDB } from "./db.js";
import { AggregatedRecord } from "./types.js";

interface NextPromptsOpts {
  n: number;
  days: number;
  brief?: string;
  apiKey: string;
  model: string;
  dbPath: string;
  brandDnaPath: string;
  outputDir: string;
}

interface ContextSummary {
  winnerCount: number;
  loserCount: number;
  positiveKeywords: number;
  negativeKeywords: number;
  totalBatches: number;
}

export async function generateNextPrompts(opts: NextPromptsOpts): Promise<{
  prompts: string[];
  outputPath: string;
  context: ContextSummary;
}> {
  // Load brand DNA
  if (!fs.existsSync(opts.brandDnaPath)) {
    throw new Error(`brand-dna not found at ${opts.brandDnaPath}`);
  }
  const brandDna = fs.readFileSync(opts.brandDnaPath, "utf-8");

  // Pull aggregated records, filter by date
  const db = new ScoreDB(opts.dbPath);
  const allRecords = db.getAggregatedRecords();
  db.close();

  const cutoff = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);
  const recentRecords = allRecords.filter((r) => {
    if (!r.scored_at) return false;
    const t = new Date(r.scored_at);
    return Number.isFinite(t.getTime()) && t >= cutoff;
  });

  const winners = recentRecords.filter((r) => r.result.verdict === "winner");
  const losers = recentRecords.filter((r) => r.result.verdict === "reject");

  // Local per-batch keyword aggregation over the same date window
  const kwMap = new Map<string, { emp: number; rem: number }>();
  for (const r of recentRecords) {
    const emp = r.result.suggested_keywords_to_emphasize;
    const rem = r.result.suggested_keywords_to_remove;
    const all = new Set([...emp, ...rem].map((s) => s.toLowerCase().trim()).filter(Boolean));
    for (const phrase of all) {
      const cur = kwMap.get(phrase) || { emp: 0, rem: 0 };
      if (emp.some((p) => p.toLowerCase().trim() === phrase)) cur.emp++;
      if (rem.some((p) => p.toLowerCase().trim() === phrase)) cur.rem++;
      kwMap.set(phrase, cur);
    }
  }
  const positives = [...kwMap.entries()]
    .map(([k, v]) => ({ keyword: k, net: v.emp - v.rem }))
    .filter((x) => x.net > 0)
    .sort((a, b) => b.net - a.net)
    .slice(0, 10);
  const negatives = [...kwMap.entries()]
    .map(([k, v]) => ({ keyword: k, net: v.emp - v.rem }))
    .filter((x) => x.net < 0)
    .sort((a, b) => a.net - b.net)
    .slice(0, 10);

  const context: ContextSummary = {
    winnerCount: winners.length,
    loserCount: losers.length,
    positiveKeywords: positives.length,
    negativeKeywords: negatives.length,
    totalBatches: recentRecords.length,
  };

  const userMessage = buildUserMessage({
    brandDna,
    winners,
    losers,
    positives,
    negatives,
    days: opts.days,
    n: opts.n,
    brief: opts.brief,
  });

  // Call Claude
  const client = new Anthropic({ apiKey: opts.apiKey });
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Claude response");
  }
  const raw = textBlock.text;
  const prompts = parsePromptsJson(raw);

  if (prompts.length === 0) throw new Error(`Claude returned no prompts. Raw: ${raw.slice(0, 500)}`);

  // Write markdown archive
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const outputPath = path.join(opts.outputDir, `${dateStr}.md`);
  fs.writeFileSync(outputPath, renderMarkdown({ prompts, context, opts, dateStr }), "utf-8");

  return { prompts, outputPath, context };
}

const SYSTEM_PROMPT = `You are an ad image prompt generator for Alphawalk.ai — an AI investment assistant SaaS for retail traders in East Asia (Japan, Korea, Hong Kong, Taiwan, Singapore).

Your job: produce N image-generation prompts that:
1. STRICTLY comply with the locked brand DNA provided in the user message
2. Compound learnings from recent winning ads (positive patterns to emphasize)
3. Avoid patterns observed in recent losing ads (negative patterns to remove)
4. Satisfy any creative brief as a HARD requirement (every prompt must address it)

Each prompt should be:
- Natural language, 60-150 words, suitable for both Google Gemini Imagen and OpenAI ChatGPT Image 2.0
- Self-contained — no references to other prompts or "as before"
- Concrete on scene anchors: lighting, character pose/wardrobe, composition, foreground/background, headline text candidate (≤8 words), single CTA
- Distinct from sibling prompts — vary scene specifics, message angle, character demographic (within East Asian rotation), mood

Output ONLY valid JSON, no preamble or markdown fences:
{"prompts": ["prompt 1 text...", "prompt 2 text...", ...]}

The array length must equal N exactly. No more, no less.`;

function buildUserMessage(args: {
  brandDna: string;
  winners: AggregatedRecord[];
  losers: AggregatedRecord[];
  positives: { keyword: string; net: number }[];
  negatives: { keyword: string; net: number }[];
  days: number;
  n: number;
  brief?: string;
}): string {
  const winnersBlock = args.winners.length
    ? args.winners
        .slice(0, 10)
        .map((r) => `- [${r.filename}] (${r.result.total}/40): ${r.result.winning_hypothesis}`)
        .join("\n")
    : "(no winners in the window)";
  const losersBlock = args.losers.length
    ? args.losers
        .slice(0, 10)
        .map(
          (r) =>
            `- [${r.filename}] (${r.result.total}/40): ${r.result.failure_modes.join("; ")}`
        )
        .join("\n")
    : "(no losers in the window)";
  const positivesBlock = args.positives.length
    ? args.positives.map((p) => `- ${p.keyword} (net +${p.net})`).join("\n")
    : "(no positive signal yet)";
  const negativesBlock = args.negatives.length
    ? args.negatives.map((p) => `- ${p.keyword} (net ${p.net})`).join("\n")
    : "(no negative signal yet)";

  const briefBlock = args.brief
    ? `\nCREATIVE BRIEF (HARD requirement — every prompt MUST address this):\n${args.brief}\n`
    : `\nCREATIVE BRIEF: (none specified — generate variety within brand DNA)\n`;

  return `BRAND DNA (locked):
\`\`\`json
${args.brandDna}
\`\`\`

RECENT WINNERS (verdict=winner, last ${args.days} days):
${winnersBlock}

RECENT LOSERS (verdict=reject, last ${args.days} days):
${losersBlock}

KEYWORDS TO EMPHASIZE (top by positive net score):
${positivesBlock}

KEYWORDS TO REMOVE (top by negative net score):
${negativesBlock}
${briefBlock}
Generate exactly ${args.n} prompts. Return ONLY the JSON object.`;
}

function parsePromptsJson(raw: string): string[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "prompts" in parsed &&
    Array.isArray((parsed as any).prompts)
  ) {
    return (parsed as { prompts: unknown[] }).prompts.filter((p): p is string => typeof p === "string");
  }
  return [];
}

function renderMarkdown(args: {
  prompts: string[];
  context: ContextSummary;
  opts: NextPromptsOpts;
  dateStr: string;
}): string {
  const briefLine = args.opts.brief ? `**Brief**: ${args.opts.brief}` : `**Brief**: (none)`;
  const head = `# Ad prompts for ${args.dateStr}

${briefLine}
**Source**: ${args.context.totalBatches} batches from last ${args.opts.days} days (${args.context.winnerCount} winners, ${args.context.loserCount} losers, ${args.context.positiveKeywords} positive keywords, ${args.context.negativeKeywords} negative keywords)
**Targets**: Gemini Imagen, ChatGPT Image 2.0 (paste prompt as-is into either)

---

`;
  const body = args.prompts
    .map((p, i) => `## Prompt ${i + 1}\n\n${p}\n`)
    .join("\n---\n\n");
  return head + body + "\n";
}
