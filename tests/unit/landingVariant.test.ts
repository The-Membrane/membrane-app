import { describe, expect, it } from 'vitest'

import {
  CRAWLER_UA,
  LANDING_VARIANT_COOKIE,
  LANDING_VARIANT_MAX_AGE,
  hashToVariant,
  isCrawler,
  isLandingVariant,
  landingVariantCookie,
  resolveLandingVariant,
} from '@/lib/landingVariant'

// THE LANDING H1 TEST's assignment (owner ruling 2026-09-15). The whole point of
// lib/landingVariant.ts being pure is that these five rules are checkable without a
// server: a link pins a variant, a returning reader keeps theirs, an 'a' cookie is
// outside the test, a crawler always sees the same headline, and a stranger is split.

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

describe('resolveLandingVariant', () => {
  it('lets ?v win over a cookie, and persists it', () => {
    for (const v of ['a', 'b', 'c'] as const) {
      expect(
        resolveLandingVariant({
          query: v,
          cookie: v === 'b' ? 'c' : 'b',
          userAgent: BROWSER_UA,
          randomId: 'ignored',
        }),
      ).toEqual({ variant: v, setCookie: false })
    }
  })

  it('takes the first value when ?v arrives repeated', () => {
    expect(
      resolveLandingVariant({ query: ['c', 'b'], userAgent: BROWSER_UA, randomId: 'x' }),
    ).toEqual({ variant: 'c', setCookie: false })
  })

  it('ignores a ?v that names no variant', () => {
    const r = resolveLandingVariant({ query: 'd', cookie: 'b', userAgent: BROWSER_UA })
    expect(r).toEqual({ variant: expect.stringMatching(/^[bc]$/), setCookie: false })
  })

  it('ignores any cookie: each load is a fresh split (owner ruling 2026-09-15)', () => {
    for (const cookie of ['b', 'c', 'a']) {
      const r = resolveLandingVariant({ cookie, randomId: 'seed-1' })
      expect(['b', 'c']).toContain(r.variant)
      expect(r.setCookie).toBe(false)
    }
  })

  it('never asks to set a cookie', () => {
    expect(resolveLandingVariant({ query: 'b', randomId: 'x' }).setCookie).toBe(false)
    expect(resolveLandingVariant({ randomId: 'y' }).setCookie).toBe(false)
  })

  it('gives every known crawler c and no cookie, whatever the query or cookie says', () => {
    const agents = [
      'Googlebot/2.1 (+http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)',
      'facebookexternalhit/1.1',
      'Twitterbot/1.0',
      'Mozilla/5.0 (compatible; AhrefsSiteAudit/6.1; +http://ahrefs.com/robot/)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Discordbot/2.0',
      'WhatsApp/2.19 preview',
      'Mozilla/5.0 (compatible; Spider)',
    ]
    for (const ua of agents) {
      expect(isCrawler(ua)).toBe(true)
      expect(
        resolveLandingVariant({ query: 'b', cookie: 'b', userAgent: ua, randomId: 'x' }),
      ).toEqual({ variant: 'c', setCookie: false })
    }
  })

  it('does not mistake an ordinary browser for a crawler', () => {
    expect(isCrawler(BROWSER_UA)).toBe(false)
    expect(isCrawler(undefined)).toBe(false)
    expect(isCrawler(null)).toBe(false)
  })

  it('assigns a fresh load b or c, deterministically per id, both letters reachable', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 64; i++) seen.add(resolveLandingVariant({ randomId: `id-${i}` }).variant)
    expect(seen).toEqual(new Set(['b', 'c']))
    expect(resolveLandingVariant({ randomId: 'same' })).toEqual(resolveLandingVariant({ randomId: 'same' }))
  })

  it('falls back to c and no cookie when the caller supplies no random id', () => {
    expect(resolveLandingVariant({ userAgent: BROWSER_UA })).toEqual({
      variant: 'c',
      setCookie: false,
    })
  })

  it('never assigns a on its own', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`)
    for (const id of ids) {
      expect(resolveLandingVariant({ userAgent: BROWSER_UA, randomId: id }).variant).not.toBe('a')
    }
  })
})

describe('hashToVariant', () => {
  it('is stable for one id', () => {
    expect(hashToVariant('seed')).toBe(hashToVariant('seed'))
  })

  it('splits close to 50/50 over many ids', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `1a2b3c-${i}-fedc`)
    const b = ids.filter((id) => hashToVariant(id) === 'b').length
    // A fair coin over 4,000 draws sits far inside this band; the assertion is that
    // the split is a split, not that the hash is a CSPRNG.
    expect(b).toBeGreaterThan(1800)
    expect(b).toBeLessThan(2200)
  })
})

describe('landingVariantCookie', () => {
  it('writes a 180-day, path-wide, lax cookie', () => {
    const value = landingVariantCookie('b')
    expect(value).toContain(`${LANDING_VARIANT_COOKIE}=b`)
    expect(value).toContain('Path=/')
    expect(value).toContain(`Max-Age=${LANDING_VARIANT_MAX_AGE}`)
    expect(LANDING_VARIANT_MAX_AGE).toBe(60 * 60 * 24 * 180)
    expect(value).toContain('SameSite=Lax')
    expect(value).not.toContain('Secure')
  })

  it('adds Secure only when asked', () => {
    expect(landingVariantCookie('c', { secure: true })).toContain('Secure')
  })
})

describe('isLandingVariant', () => {
  it('accepts a, b and c and nothing else', () => {
    expect(['a', 'b', 'c'].every(isLandingVariant)).toBe(true)
    for (const v of ['', 'd', 'A', 'bc', null, undefined, 1, {}]) {
      expect(isLandingVariant(v)).toBe(false)
    }
  })
})

describe('CRAWLER_UA', () => {
  it('is case-insensitive and not sticky between tests', () => {
    expect(CRAWLER_UA.flags).toContain('i')
    expect(CRAWLER_UA.flags).not.toContain('g')
  })
})
