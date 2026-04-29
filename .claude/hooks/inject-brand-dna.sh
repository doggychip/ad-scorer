#!/usr/bin/env bash
# UserPromptSubmit hook — runs before Claude sees the user's prompt.
# 
# Purpose: when the user asks to generate an ad image, automatically inject
# a reminder to use brand-dna.json. This is the deterministic enforcement
# layer — model interpretation can drift, but a hook always fires.
#
# Install: chmod +x .claude/hooks/inject-brand-dna.sh
# Then add to .claude/settings.json:
#   "hooks": {
#     "UserPromptSubmit": [
#       { "command": ".claude/hooks/inject-brand-dna.sh" }
#     ]
#   }
#
# This hook reads the user's prompt from stdin, and if it matches ad-generation
# intent keywords, it appends a brand-dna reminder. Otherwise it passes through
# unchanged.

set -e

# Read the user's prompt from stdin (Claude Code passes it as JSON)
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')

# Check for ad-generation intent
if echo "$PROMPT" | grep -iqE '(generate|create|draft|design|write).*(ad|prompt|concept|image|creative|midjourney|imagen|seedance|hailuo)'; then
  REMINDER="

[BRAND DNA REMINDER — auto-injected by hook]
Before drafting any image generation prompt, you MUST:
1. Read brand-dna.json (do not assume from memory)
2. Inject ALL fields from must_include_in_every_ad
3. Inject ALL fields from must_exclude_from_every_ad as negative prompt
4. Pull current 'REMOVE' keywords via: npm run keywords 20
5. Delegate to the prompt-engineer subagent if generating >2 concepts

Do NOT proceed without these steps."

  # Append reminder to the prompt
  echo "$INPUT" | jq --arg reminder "$REMINDER" '.prompt += $reminder'
else
  # Pass through unchanged
  echo "$INPUT"
fi
