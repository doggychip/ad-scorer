# Using This Project in Claude Code

This project ships with Claude Code configuration so you can run the entire ad-review loop conversationally instead of as a sequence of CLI commands.

## One-time setup

```bash
# In your terminal, from the project root
cd ad-scorer
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY
chmod +x .claude/hooks/inject-brand-dna.sh

# Open in Claude Code
claude
```

That's it. Claude Code will auto-load `CLAUDE.md`, register the two subagents from `.claude/agents/`, and load the skills from `.claude/skills/`.

## Daily workflow examples

### Morning ad review

You: 
> /score-today

Claude:
- Runs the `score-today` skill
- Scores today's `./creatives/2026-04-29/` folder
- Returns the standard daily summary (winners, rejects, IP risks, keyword feedback)
- Generates HTML report

Or in natural language:
> Score today's creative batch and tell me what's worth keeping.

### Generating new concepts

> Use the prompt-engineer agent to draft 3 ad concepts for the message angle "Tired of trading on noise?" — format 1:1 for Instagram feed, target East Asian retail traders.

Claude delegates to the prompt-engineer subagent, which:
- Reads `brand-dna.json` fresh
- Pulls current "REMOVE" keywords from the scoring DB
- Outputs 3 ready-to-paste prompts with positive + negative + predicted score

### Investigating a pattern

> The last 3 batches have all scored low on differentiation. Why? What changed?

Claude (using the ad-scorer subagent):
- Queries the SQLite DB for recent low-differentiation cases
- Reads the failure_modes for those rows
- Cross-references with keyword aggregation
- Returns a diagnosis

### Updating brand-dna (only when lock period ends)

> brand-dna lock period ends today. Pull all the data we have on what worked and what didn't, and propose specific revisions to brand-dna.json. Reference brand-dna.md for the rationale of each existing decision before suggesting changes.

Claude:
- Reads `brand-dna.md` for current rationale
- Queries DB for performance patterns over the lock period
- Reads MEMORY.md from both subagents for accumulated learnings
- Proposes a diff of `brand-dna.json` with rationale per change

## What the subagents do

### `ad-scorer`
Scopes: scoring, results analysis, IP-risk detection, keyword aggregation.
Memory: project-scoped — accumulates patterns across batches.
Model: Sonnet (cheap enough for routine, smart enough for aesthetic judgment).
Use proactively — don't wait for explicit invocation. Whenever new images appear, score them.

### `prompt-engineer`
Scopes: drafting image generation prompts, video shot lists, brand-DNA injection.
Memory: project-scoped — learns which phrasings the user accepts vs rejects.
Model: Sonnet.
Always reads `brand-dna.json` fresh — never assumes from memory.

## What the hook does

`.claude/hooks/inject-brand-dna.sh` runs on every prompt you submit. If your prompt mentions generating ads/prompts/concepts, it auto-appends a reminder to read `brand-dna.json` and pull current scorer feedback before drafting.

This is **deterministic enforcement** — the model can drift in interpretation, but a shell hook always fires. It's the safety net that keeps your gen pipeline aligned even on bad days.

To disable temporarily: comment out the hook in `.claude/settings.json`.

## What this gives you over running CLI scripts manually

- **Persistent context** — Claude already knows the project structure, brand DNA rationale, and recent scoring history at the start of every session
- **Conversational iteration** — "score today's, then draft 3 concepts that fix the failure modes I just saw" runs as one fluid request, not 5 terminal commands
- **Memory accumulation** — subagents update `MEMORY.md` after each session, so patterns surface ("we've seen this PPT-病 failure 12 times in last 2 weeks") that you'd miss reading individual reports
- **Right model for the job** — Sonnet for daily, you can request Opus for high-stakes review without changing infrastructure
- **Hook enforcement** — the most important rule (always inject brand-dna) is enforced at the shell level, not relying on you to remember

## Troubleshooting

**Hook not firing?** 
- Check `chmod +x .claude/hooks/inject-brand-dna.sh`
- Check `.claude/settings.json` is valid JSON
- Run `claude --debug` to see hook execution logs

**Subagent not loading?** 
- Run `/agents` in Claude Code to list available subagents
- Check the YAML frontmatter is valid in `.claude/agents/*.md`

**Skills not invoked?**
- Skills auto-trigger based on the description field. If yours isn't triggering, the description needs to be more specific about when to use it.
- You can always invoke explicitly: `Use the score-today skill`

## Migrating to a team setup

If Michael or your finance team also uses Claude Code on this project:

1. **Commit `.claude/` to git** — subagents, skills, hooks, and `CLAUDE.md` are all team-shared
2. **Don't commit** `data/scores.db` — each team member runs their own scoring (or share via a hosted SQLite if you want central aggregation)
3. **Don't commit** `.env` — already in `.gitignore`
4. The two subagents' `MEMORY.md` files (`.claude/agent-memory/`) — your call. Per Claude Code defaults, they're project-scoped and committable. Sharing them = team learns together; not sharing = each person has personal style notes.
