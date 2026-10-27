/**
 * THE LANDING H1 TEST — assignment, resolved on the server.
 *
 * Owner ruling 2026-09-15: the H1 is the only thing under test. Two variants are
 * assigned, B and C (components/Seniority/facts.ts HERO_VARIANTS). The original
 * seniority-led hero is variant A: it stays in the code and is reachable at ?v=a,
 * and the assignment below never hands it out.
 *
 * WHY SERVER-SIDE. A variant picked in the browser paints A first and swaps it, which
 * is the hydration flash the test is trying to measure away. getServerSideProps calls
 * resolveLandingVariant once, renders the chosen H1 into the HTML, and sets the cookie
 * on the same response, so the reader sees one headline and keeps it.
 *
 * WHY CRAWLERS ARE PINNED. An indexable page whose H1 rotates per fetch gives search
 * and answer engines two different pages at one canonical URL. Every known crawler gets
 * C and no cookie, so the indexed H1 is stable (docs/SEO_RULESET.md R1).
 *
 * This module is PURE: no Next types, no req/res, no randomness of its own. The caller
 * supplies the random id, which is what makes the split testable.
 */

export type LandingVariant = 'a' | 'b' | 'c' | 'd'

/** The two variants the test actually assigns. A is saved, never assigned. */
export type AssignedVariant = 'b' | 'c'

/**
 * THE SUITE HEADLINE (owner direction 2026-10-27, board Q26-S1): the landing now sells the
 * whole borrower tool suite (health bar, alerts, timer, replay, practice, sizing), not only
 * the liquidation delay. B and C both lead with the delay, so the H1 test is paused and every
 * reader and crawler gets D. A, B and C stay in the code and are reachable at ?v=a|b|c.
 */
export const SUITE_VARIANT: LandingVariant = 'd'

/**
 * THE FLIP. `false` serves SUITE_VARIANT to everyone. `true` restores the B/C split exactly as
 * it ran from 2026-09-15 (crawlers pinned to C). One line, nothing else moves.
 */
export const HERO_TEST_RUNNING = false

export const LANDING_VARIANT_COOKIE = 'membrane.landingVariant'

/** 180 days, in seconds. One reader keeps one headline across the whole test. */
export const LANDING_VARIANT_MAX_AGE = 60 * 60 * 24 * 180

/**
 * Known crawlers and link unfurlers. Deliberately broad and deliberately cheap: a
 * false positive costs one reader a C instead of a B, a false negative costs the
 * canonical H1 its stability.
 */
export const CRAWLER_UA = /bot|crawl|spider|slurp|facebookexternalhit|preview/i

export interface LandingVariantInput {
  /** The `v` query value, as Next hands it over (string, array, or absent). */
  query?: string | string[] | null
  /** The `membrane.landingVariant` cookie value, if the reader already has one. */
  cookie?: string | null
  /** The request user agent. */
  userAgent?: string | null
  /** A fresh random id for a first-time reader. Supplied by the caller so the split is testable. */
  randomId?: string | null
  /** Whether the B/C test runs. Defaults to HERO_TEST_RUNNING; passed explicitly in tests. */
  testRunning?: boolean
}

export interface LandingVariantResolution {
  variant: LandingVariant
  /** True when the response has to carry a Set-Cookie for this variant. */
  setCookie: boolean
}

export function isLandingVariant(value: unknown): value is LandingVariant {
  return value === 'a' || value === 'b' || value === 'c' || value === 'd'
}

export function isCrawler(userAgent?: string | null): boolean {
  return typeof userAgent === 'string' && CRAWLER_UA.test(userAgent)
}

/**
 * 50/50 split of a random id across B and C. FNV-1a over the id, low bit picks the
 * side. A hash rather than Math.random() so the same id always lands on the same
 * variant, which is what makes the assignment reproducible in a test.
 */
export function hashToVariant(id: string): AssignedVariant {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h & 1) === 0 ? 'b' : 'c'
}

/**
 * With the test paused (HERO_TEST_RUNNING false): ?v=a|b|c|d pins that variant; everyone
 * else, crawlers included, gets SUITE_VARIANT. With the test running, as before:
 *
 * Resolution order:
 *   0. crawler user agent  -> C, no cookie (the canonical H1 stays one headline)
 *   1. ?v=a|b|c|d          -> that variant, persisted (a link pins what it shows)
 *   2. cookie b|c          -> that variant, already persisted. An 'a' cookie is
 *                             ignored and re-assigned: A is outside the test, so a
 *                             reader who once opened ?v=a rejoins it on their next visit.
 *   3. fresh reader        -> B or C by a 50/50 hash of randomId, persisted
 *
 * A missing randomId at step 3 falls back to C, matching the crawler side, so a caller
 * that forgets to supply one degrades to the stable headline instead of throwing.
 */
export function resolveLandingVariant(input: LandingVariantInput): LandingVariantResolution {
  const running = input.testRunning ?? HERO_TEST_RUNNING
  if (isCrawler(input.userAgent))
    return { variant: running ? 'c' : SUITE_VARIANT, setCookie: false }

  const queried = Array.isArray(input.query) ? input.query[0] : input.query
  if (isLandingVariant(queried)) return { variant: queried, setCookie: false }

  if (!running) return { variant: SUITE_VARIANT, setCookie: false }

  // Owner ruling 2026-09-15: randomise on every load. No cookie is read or written;
  // each request is a fresh 50/50 split and the run event carries the letter it was
  // rendered with, so attribution is per load rather than per browser.
  const randomId = input.randomId
  if (!randomId) return { variant: 'c', setCookie: false }
  return { variant: hashToVariant(randomId), setCookie: false }
}

/**
 * The Set-Cookie value. Hand-rolled for the same reason lib/game/session.ts rolls its
 * own: the `cookie` package is not a direct dependency and these attributes are fixed.
 * Readable by script on purpose (it is an assignment, not a credential) so the client
 * can report the variant it was rendered with.
 */
export function landingVariantCookie(
  variant: LandingVariant,
  opts: { secure?: boolean } = {},
): string {
  const attrs = [
    `${LANDING_VARIANT_COOKIE}=${variant}`,
    'Path=/',
    `Max-Age=${LANDING_VARIANT_MAX_AGE}`,
    'SameSite=Lax',
  ]
  if (opts.secure) attrs.push('Secure')
  return attrs.join('; ')
}
