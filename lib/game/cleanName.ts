// Display-name sanitizer for anything sourced from a wallet or a player and rendered
// publicly (today: daily_firsts.display_name -> daily_firsts.clean_name, consumed by
// GET /api/game/ticker via components/Ticker/DailyFirstTicker.tsx). Runs entirely
// offline against the `obscenity` wordlist matcher — no network call, no external API,
// so it's safe to run at ingest time inside lib/game/indexerSeam.ts.
//
// Contract: cleanDisplayName NEVER throws and NEVER returns raw profanity. A flagged
// name is replaced outright with a neutral placeholder rather than partially censored,
// because this string goes on a public ticker with no per-viewer moderation step.

import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity'

const MAX_LENGTH = 24
const FALLBACK_NAME = 'a racer'

// Built once per process — RegExpMatcher construction compiles the blacklist into
// regular expressions, so it is not free enough to redo per call.
const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
})

export type CleanNameResult = {
  /** Always safe to render publicly. */
  clean: string
  /** True if the raw input tripped the profanity matcher (or was empty after trimming). */
  flagged: boolean
}

/**
 * Sanitizes a raw, user- or wallet-chosen display name for public rendering.
 *
 * - Trims and collapses internal whitespace to single spaces.
 * - Caps length at 24 characters.
 * - Runs the `obscenity` matcher (covers leetspeak / confusable-character variants via
 *   its built-in transformers) over the trimmed-and-capped string; a match replaces the
 *   whole name with 'a racer' rather than censoring individual words.
 * - An empty string after trimming is itself treated as flagged (nothing to show).
 */
export function cleanDisplayName(raw: string): CleanNameResult {
  const collapsed = (raw ?? '').trim().replace(/\s+/g, ' ')
  if (collapsed.length === 0) {
    return { clean: FALLBACK_NAME, flagged: true }
  }

  const capped = collapsed.slice(0, MAX_LENGTH)

  if (matcher.hasMatch(capped)) {
    return { clean: FALLBACK_NAME, flagged: true }
  }

  return { clean: capped, flagged: false }
}

export default cleanDisplayName
