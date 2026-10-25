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

/**
 * OWNER'S W.O.W. HEADLINES (ruling 2026-10-25, replaces the framework drafts). Who:
 * borrowers who don't want to babysit a loan. Outcome: keep more of the position through
 * a crash, with time to repay before anything is sold. Without: no manual action; the
 * 8h window opens on its own. The owner chose these, so the copy-budget 12-word H1 limit
 * gives way to 20 for this set (tests/unit/landing.test.ts).
 */
const OWNER_1 = 'Borrow without babysitting. If price breaks your line, you get 8 hours to repay — automatically.'
const OWNER_2 = 'A crash shouldn’t sell your loan at 2am. Membrane waits 8 hours on its own — nothing to set, nothing to watch.'
const OWNER_3 = 'Keep more of your borrow when the market wicks. An automatic 8-hour window, no monitoring.'

export const HEADLINES: Record<HeadlineKey, HeadlineCopy> = {
  default: { headline: OWNER_1, draft: null },
  a: { headline: OWNER_1, draft: null },
  b: { headline: OWNER_2, draft: null },
  c: { headline: OWNER_3, draft: null },
}

/** The one-line mechanism under the H1. Framework subhead, rewritten to the ruling. */
export const SUBHEAD = 'Paste your wallet to see your own position replayed through October 10th, on your venue and on Membrane.'

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
