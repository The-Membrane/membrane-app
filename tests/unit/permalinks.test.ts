import { describe, expect, it } from 'vitest'

import {
  USD_CAP,
  clampCount,
  clampUsd,
  fmtUsdShort,
  normalizeAddress,
  parseOgKind,
  parseVenueParam,
  radarCardSummary,
  radarOgImagePath,
  radarPermalinkPath,
  radarSeoClass,
  venueCardSummary,
  venueOgImagePath,
} from '@/lib/share/permalink'

const A = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
const a = A.toLowerCase()

describe('permalink building', () => {
  it('one canonical lower-case URL per address', () => {
    expect(radarPermalinkPath('ethereum', A)).toBe(`/ethereum/radar/${a}`)
    expect(radarPermalinkPath('ethereum', a)).toBe(`/ethereum/radar/${a}`)
  })
  it('rejects anything that is not a 0x address', () => {
    expect(radarPermalinkPath('ethereum', '0x123')).toBeNull()
    expect(radarPermalinkPath('ethereum', `${A}00`)).toBeNull()
    expect(normalizeAddress(undefined)).toBeNull()
    expect(normalizeAddress([A, '0x0'])).toBe(a)
    expect(normalizeAddress(`  ${A} `)).toBe(a)
  })
})

describe('OG query params', () => {
  it('encodes radar and venue card paths; numbers never ride in the query', () => {
    expect(radarOgImagePath(A)).toBe(`/api/og/radar?address=${a}`)
    expect(radarOgImagePath('nope')).toBeNull()
    expect(venueOgImagePath('sUSDe')).toBe('/api/og/venue?venue=sUSDe')
    expect(venueOgImagePath('../etc')).toBeNull()
    expect(venueOgImagePath('..')).toBeNull()
  })
  it('decodes kind and venue strictly', () => {
    expect(parseOgKind('radar')).toBe('radar')
    expect(parseOgKind(['finding'])).toBe('finding')
    expect(parseOgKind('evil')).toBeNull()
    expect(parseOgKind(null)).toBeNull()
    expect(parseVenueParam('aave-usde')).toBe('aave-usde')
    expect(parseVenueParam('a/b')).toBeNull()
    expect(parseVenueParam('x'.repeat(41))).toBeNull()
    expect(parseVenueParam('')).toBeNull()
  })
  it('clamps dollar figures and counts; a bad read is null, never a number', () => {
    expect(clampUsd(1234.5)).toBe(1234.5)
    expect(clampUsd('42')).toBe(42)
    expect(clampUsd(0)).toBe(0)
    expect(clampUsd(-1)).toBeNull()
    expect(clampUsd(NaN)).toBeNull()
    expect(clampUsd(Infinity)).toBeNull()
    expect(clampUsd(USD_CAP * 10)).toBeNull()
    expect(clampUsd(null)).toBeNull()
    expect(clampUsd('')).toBeNull()
    expect(clampCount(3)).toBe(3)
    expect(clampCount(1.5)).toBeNull()
    expect(clampCount(-1)).toBeNull()
    expect(clampCount(5000)).toBeNull()
  })
  it('formats card figures', () => {
    expect(fmtUsdShort(1_194_068_013)).toBe('$1.2B')
    expect(fmtUsdShort(67_175_505)).toBe('$67M')
    expect(fmtUsdShort(1_250_000)).toBe('$1.3M')
    expect(fmtUsdShort(940_400)).toBe('$940k')
    expect(fmtUsdShort(12)).toBe('$12')
  })
})

describe('indexability', () => {
  it('indexable only when the address is on the Strats board', () => {
    expect(radarSeoClass('watched')).toBe('indexable')
    expect(radarSeoClass('not-watched')).toBe('app')
    expect(radarSeoClass('error')).toBe('app')
  })
})

describe('card summaries read the API response or give up', () => {
  const radar = {
    address: A,
    total_usd: 250_000,
    held_count: 2,
    positions: [{ verdict: 'clear' }, { verdict: 'exposed' }],
  }
  it('radar: weakest verdict, total, count', () => {
    expect(radarCardSummary(radar)).toEqual({ address: a, totalUsd: 250_000, heldCount: 2, worst: 'exposed' })
  })
  it('radar: nothing held ⇒ no verdict', () => {
    expect(radarCardSummary({ ...radar, held_count: 0, total_usd: 0, positions: [] })?.worst).toBeNull()
  })
  it('radar: malformed ⇒ null (plain card)', () => {
    expect(radarCardSummary(null)).toBeNull()
    expect(radarCardSummary({ error: 'invalid address' })).toBeNull()
    expect(radarCardSummary({ ...radar, total_usd: -5 })).toBeNull()
    expect(radarCardSummary({ ...radar, positions: [{ verdict: 'great' }] })).toBeNull()
  })
  it('venue: TVL from totalAssets, else instant read; outflows and flags', () => {
    const s = venueCardSummary({
      label: 'sUSDe',
      observed: { observedAt: '2026-09-24T10:00:00Z', instantUsd: 5, params: { totalAssets: '3000000000000000000000000' } },
      worstOutflows: { d1: { usd: 1_000_000, date: 'x' }, d7: null },
      alarms: { open: [{}, {}], uncovered: [] },
    })
    expect(s).toEqual({ label: 'sUSDe', tvlUsd: 3_000_000, worst1dUsd: 1_000_000, worst7dUsd: null, openFlags: 2, observedAt: '2026-09-24' })
    expect(venueCardSummary({ label: 'aave', observed: { instantUsd: 9, params: { totalAssets: null } } })?.tvlUsd).toBe(9)
  })
  it('venue: no label ⇒ null', () => {
    expect(venueCardSummary({ error: 'unknown venue' })).toBeNull()
  })
})
