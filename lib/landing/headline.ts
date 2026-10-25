/**
 * THE LANDING HEADLINE TEST (lane Q41, owner framework 2026-10-24).
 *
 * The framework gives three headline drafts. The owner's copy ruling (2026-10-25) wins
 * over their wording: a replay is labelled a replay, comparisons say "would have", and
 * the words "survives", "safe", "odds", "protected", "kept", "held" and "guaranteed"
 * never appear. Each draft below is the framework line rewritten to that ruling; the
 * framework original is kept in `draft` so the rewrite can be checked.
 *
 * ASSIGNMENT reuses the existing mechanism (lib/landingVariant.ts): resolved on the
 * server in getServerSideProps, `?v=` pins a variant for that request, a known crawler
 * always gets the DEFAULT so the indexed H1 is one stable headline (SEO R1), and no
 * cookie is read or written (owner ruling 2026-09-15: randomise per load).
 *
 * Pure: no Next types, no randomness of its own. The caller passes the random id.
 */

import { isCrawler } from '@/lib/landingVariant'

export type HeadlineKey = 'default' | 'a' | 'b' | 'c'

/** The three drafts the test assigns. `default` is never assigned; crawlers get it. */
export const ASSIGNED_HEADLINES: readonly Exclude<HeadlineKey, 'default'>[] = ['a', 'b', 'c']

export interface HeadlineCopy {
  /** The H1. Tells the story on its own. */
  headline: string
  /** The framework draft this was rewritten from, verbatim. Never rendered. */
  draft: string | null
}

export const HEADLINES: Record<HeadlineKey, HeadlineCopy> = {
  default: {
    headline: 'Your borrow, replayed through 10 Oct 2025 on your venue and on Membrane.',
    draft: null,
  },
  a: {
    headline: 'Paste your wallet. Replay your loop through the next October 10th.',
    draft: 'Paste your wallet. See if your loop survives the next October 10th.',
  },
  b: {
    headline: 'Your position, replayed through the 10 Oct 2025 crash. Free, no deposit.',
    draft: 'Your position, replayed through the worst day in DeFi lending. Free, no deposit.',
  },
  c: {
    headline: 'See what a 2am wick would have done to your borrow, before the next one.',
    draft: 'Find out what your borrow does at 2am — before 2am finds out for you.',
  },
}

/** The one-line mechanism under the H1. Framework subhead, rewritten to the ruling. */
export const SUBHEAD =
  'We run your exact position through measured 10 Oct 2025 prices, on your current venue and on Membrane, side by side.'

/** The one button. Framework: "Run my forecast". This runs a replay, so it says so. */
export const RUN_LABEL = 'Run my replay'

export interface HeadlineInput {
  query?: string | string[] | null
  userAgent?: string | null
  randomId?: string | null
}

export function isHeadlineKey(v: unknown): v is HeadlineKey {
  return v === 'default' || v === 'a' || v === 'b' || v === 'c'
}

/** FNV-1a over the id, three ways. Same id, same draft: reproducible in a test. */
export function hashToHeadline(id: string): Exclude<HeadlineKey, 'default'> {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ASSIGNED_HEADLINES[h % ASSIGNED_HEADLINES.length]
}

/**
 * Resolution order:
 *   0. crawler user agent -> default
 *   1. ?v=default|a|b|c   -> that one, for this request only
 *   2. fresh reader       -> a, b or c by a 3-way hash of randomId
 *   3. no randomId        -> default (degrades to the stable headline, never throws)
 */
export function resolveHeadline(input: HeadlineInput): HeadlineKey {
  if (isCrawler(input.userAgent)) return 'default'
  const q = Array.isArray(input.query) ? input.query[0] : input.query
  if (isHeadlineKey(q)) return q
  if (!input.randomId) return 'default'
  return hashToHeadline(input.randomId)
}
