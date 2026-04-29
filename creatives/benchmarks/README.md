# Rubric Benchmark Set

This folder is a **validation set for the scorer rubric** — not real campaign creative.
It exists to test whether the rubric (`src/rubric.ts`) actually discriminates between
quality bands. If everything in `high-quality/` scores under 25 and everything in
`low-quality/` scores over 25, the rubric is broken before we even argue about which
ads to ship.

## When to use this

- After any meaningful change to `src/rubric.ts` or `brand-dna.json`.
- When `perf:correlate` returns `insufficient data` for many dimensions on a real
  batch — that usually means the rubric is giving constant scores across diverse
  inputs (zero variance → undefined Pearson r).
- Quarterly, as a regression check.

Run with:

```bash
npm run score ./creatives/benchmarks/high-quality
npm run score ./creatives/benchmarks/medium-quality
npm run score ./creatives/benchmarks/low-quality
```

Then inspect dimension-level distributions per band — they should separate.

## Subdirectories

### `high-quality/` — expected total **30+/40**

Active competitor fintech ads with 30+ days of measurable performance, pulled from:

- [Meta Ad Library](https://www.facebook.com/ads/library/)
- [TikTok Ads Library](https://library.tiktok.com/ads)

Target advertisers: Robinhood, eToro, Webull, TradingView, Public, Moomoo,
Interactive Brokers, etc. Long-running = profitable = the rubric should reward it.

### `medium-quality/` — expected total **20–29/40**

Mediocre-but-functional ads. Either:
- Our own past ads that performed average,
- Competitor ads that ran but didn't dominate,
- Generic stock-feel fintech ads.

### `low-quality/` — expected total **under 20/40**

Currently the 2026-04-29 batch (anime-character, mascot-with-feature-list, and
billboard-collage variants) — all scored 14–15/40 by the rubric. These are the
canonical PPT病 / IP-risk failure cases.

## Naming convention

Encode the expected score band in the filename so reviewers can spot regressions
at a glance:

- `*_expected-30plus.jpg` — high-quality samples
- `*_expected-20-29.jpg`  — medium-quality samples
- `*_expected-under20.jpg` — low-quality samples

Example: `robinhood_2026-q1_expected-30plus.jpg`

## Sourcing rules

1. Only include ads that have been **observably running 30+ days** in the ad
   library — short-lived ads aren't validated by the market and shouldn't be
   used as a quality reference.
2. Annotate each high-quality file with the source advertiser and the date
   first seen, in a sibling `.txt` if the filename gets unwieldy.
3. **Do not commit copyrighted competitor ads to a public repo.** Either keep
   this folder gitignored, or use a private bucket and symlink in.
4. **Never feed these benchmark files into the production gen pipeline** as
   reference images — that is how IP infringement starts.

## Caveats on `perf:correlate`

If `pearson()` returns `insufficient data` for a dimension at small `n`, that
means the dimension produced **constant scores across the sampled images**
(zero variance → division by zero in correlation). At small n that's noise.
At large n on a diverse benchmark set, it's a real signal that the rubric
isn't discriminating on that dimension, and the rubric prompt or weight needs
revisiting.
