---
name: new-concept
description: Generate brand-DNA-compliant ad concepts from a creative brief. Use when the user provides a creative brief or message angle and wants ready-to-paste image generation prompts (Midjourney, Imagen, Seedance, Hailuo). Auto-injects brand-dna.json constraints and current scorer-derived negative prompts.
---

# Generate ad concepts from a brief

This skill takes a creative brief and outputs N brand-compliant prompts ready for the image/video generation pipeline.

## Inputs to gather from the user (if not provided)

- **Message angle** — what is THIS specific ad communicating? Pick ONE: pain_point | solution_demo | social_proof | offer | lifestyle_aspiration. If user gives more than one, push back — one ad = one message.
- **Format** — 1:1 / 4:5 / 9:16, static or video
- **Platform** — which gen tool will run the prompt (affects syntax)
- **Quantity** — how many concepts to generate (default 3)

## Workflow

1. **Re-read the brand DNA every time:**
   ```bash
   cat brand-dna.json
   ```
   Do not assume from memory.

2. **Pull current negative-prompt keywords from the scoring DB:**
   ```bash
   npm run keywords 30 2>&1 | grep -A 50 "REMOVE"
   ```
   These get added to the negative prompt for every concept you generate.

3. **Delegate to prompt-engineer subagent** if the work is non-trivial (>2 concepts, video shot lists, or platform-specific tuning):
   > Use the prompt-engineer agent to draft <N> concepts for: <brief>

   For simple single-concept drafts, do it directly.

4. **Output format** — for each concept:

   ```
   === Concept N: <Short title> ===
   
   Strategy: <1 sentence — message + audience moment>
   Format: <ratio + static/video>
   
   POSITIVE PROMPT:
   <dense paragraph with brand DNA + concept specifics, ready to paste>
   
   NEGATIVE PROMPT:
   <comma-separated, includes scorer-derived "REMOVE" keywords>
   
   [if video] ANCHOR FRAME: <still-image prompt>
   [if video] SHOT LIST: <3-6 shots>
   
   PREDICTED SCORE: <X/40, with reasoning on weak dimensions>
   ```

5. **End with a one-liner** asking if user wants to:
   - Generate the images now (if they have a connected gen tool)
   - Iterate on a specific concept
   - Save these to `./creatives/drafts/YYYY-MM-DD/` for tracking

## Hard rules (inherited from brand-dna)

- Always include: dark mode, evening/night scene, single character (back/profile/3-quarter), brand colors
- Never include: split-screen comparisons, billboards, jumping people, cartoon mascots (paid media), real public figures, recognizable IP characters, daylight outdoor scenes, "get rich" imagery
- Headlines ≤ 8 words. Subheads ≤ 12 words. ONE CTA.

## What NOT to do

- Don't draft prompts that contradict `brand-dna.json` even if the user asks. Push back: "That violates the brand DNA lock — here's what we can do that hits the same goal."
- Don't lecture the user on brand strategy. Generate the prompts; reasoning belongs in the PREDICTED SCORE field.
- Don't generate more than the requested quantity. If asked for 3, give 3 strong ones, not 5 mediocre ones.
