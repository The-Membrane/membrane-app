import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  aprMix,
  borrowPct,
  demandView,
  DEFAULT_SIZE,
  exitCapacity,
  exitsView,
  leadView,
  MERKL_MAX_AGE_MS,
  NET_APY_MAX_AGE_MS,
  OPP_COPY,
  rankRates,
  RATES_SHOWN,
  ratesView,
  RECORDER_MAX_AGE_MS,
  RECORDER_VENUES,
  REWARDS_MARK,
  sizeLabel,
  supplyPct,
  usdShort,
  usdWhole,
  type Load,
  type NetApyList,
  type StratsDemand,
} from '@/components/Today/opportunitiesView'
import { HOUR_MS } from '@/lib/regime/m0'
import type { VenueSummary } from '@/pages/api/venues/[venue]/summary'

// The Opportunities body's view model: the rate headline and its $ figure, the ranked
// table (on the total APR, rewards included) and each rewarded APR's composition, the
// exits against the reader's size and the demand line, in every state (ready, loading,
// error, stale, empty), from fixed responses shaped like the routes'.

const NOW = Date.UTC(2026, 9, 14, 12, 30)
const ok = <T>(data: T): Load<T> => ({ status: 'success', data })
const PENDING = { status: 'pending', data: undefined } as const
const FAILED = { status: 'error', data: undefined } as const

type Venue = NetApyList['venues'][number]
const venue = (key: string, label: string, apr: number, over: Partial<Venue> = {}): Venue => ({
  venueKey: key,
  label,
  protocol: 'aave-v3',
  net: { apr, apy: apr, bound: 'upper', withIncentives: false },
  netIncentiveFree: { apr, apy: apr, bound: 'upper' },
  supplyAprNow: apr + 0.0004,
  borrowAprNow: apr + 0.0061,
  borrowAprAtKink: 0.09,
  firstIncentiveEndTs: null,
  incentives: [],
  reverts: null,
  ...over,
})

/** Aave v3 USDS as the owner was shown it: 0.19% on-chain, 3.51% with its Merkl reward. */
const USDS_START = Date.UTC(2026, 9, 8, 13) / 1000
const USDS_END = Date.UTC(2026, 9, 18) / 1000
const USDS_REWARD = {
  source: 'merkl' as const,
  campaignId: '0x1374',
  name: 'Lend USDS on Aave',
  rewardSymbol: 'aEthUSDS',
  aprAtSize: 0.0331895,
  aprReported: 0.0336553,
  dilution: 'fixed-budget' as const,
  startTs: USDS_START,
  endTs: USDS_END,
}
const usds = (over: Partial<Venue> = {}): Venue =>
  venue('aave-v3-usds', 'Aave v3 USDS', 0.0019192, {
    net: { apr: 0.0351087, apy: 0.0357, bound: 'upper', withIncentives: true },
    firstIncentiveEndTs: USDS_END,
    incentives: [USDS_REWARD],
    ...over,
  })

const list = (over: Partial<NetApyList> = {}, sizeUsd = DEFAULT_SIZE): NetApyList => ({
  anchor: {
    chainId: 1,
    blockNumber: '26187572',
    blockTimestamp: String(Math.floor((NOW - 15 * 60_000) / 1000)),
    blockHash: '0xfb',
  },
  rpc: 'env:host',
  side: 'supply',
  sizeUsd,
  venues: [
    venue('aave-v3-usdc', 'Aave v3 USDC', 0.03696),
    venue('morpho-blue-cbbtc-usdc-86', 'Morpho cbBTC/USDC 86%', 0.0436462),
    venue('euler-v2-eusdc-2', 'Euler eUSDC-2', 0.0431712),
    usds(),
    venue('aave-v3-usde', 'Aave v3 USDe', 0.0030431),
    venue('spark-usdc', 'SparkLend USDC', 0.0354529),
    venue('euler-v2-eusdt-2', 'Euler eUSDT-2', 0.05, { reverts: 'over the supply cap' }),
  ],
  errors: [],
  incentivesStatus: { ok: true, fetchedAt: NOW / 1000 },
  ...over,
})

describe('formats, rounded toward risk', () => {
  it('earnings and supply rates round down; borrow rates round up', () => {
    expect(supplyPct(0.0436462)).toBe('4.36%')
    expect(supplyPct(0.04369)).toBe('4.36%')
    expect(borrowPct(0.04361)).toBe('4.37%')
    expect(borrowPct(0.0437)).toBe('4.37%')
    expect(usdWhole(4364.62)).toBe('$4,364')
  })

  it('sizes and capacities', () => {
    expect(SIZE_LABELS).toEqual(['$10k', '$100k', '$1M', '$10M'])
    expect(usdShort(4_391_893_463)).toBe('$4.39B')
    expect(usdShort(502_842_570)).toBe('$502.8M')
    expect(usdShort(21_692_821)).toBe('$21.6M')
    expect(usdShort(950_400)).toBe('$950k')
    expect(usdShort(420.9)).toBe('$420')
  })
})
const SIZE_LABELS = [10_000, 100_000, 1_000_000, 10_000_000].map(sizeLabel)

describe('the recorder venues', () => {
  it('match the enabled entries of tools/venue-recorder.config.json', () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), 'tools/venue-recorder.config.json'), 'utf8'))
    const enabled = (cfg.venues as { name: string; enabled: boolean }[]).filter((v) => v.enabled).map((v) => v.name)
    expect([...RECORDER_VENUES].sort()).toEqual(enabled.sort())
  })
})

describe('leadView (the rate headline)', () => {
  const lead = (l: Load<NetApyList>, sizeUsd = DEFAULT_SIZE, nowMs = NOW) =>
    leadView({ netApy: l, sizeUsd, chain: 'ethereum', nowMs })

  it('names the highest total venue rate at the size, with its block and age', () => {
    const v = lead(ok(list()))
    expect(v.state).toBe('ready')
    expect(v.hatched).toBe(false)
    expect(v.headline).toEqual({ lead: 'Morpho cbBTC/USDC 86% pays', figure: '4.36%', tail: 'APR†' })
    // No rewards in it: plain, no mark, no composition.
    expect(v.mix).toBeNull()
    expect(v.ends).toBeNull()
    // $100k × 4.36462% a year, rounded down: the $ the reader would earn (moss).
    expect(v.hero).toEqual({ figure: '$4,364', unit: 'a year†' })
    // Six ranked: the reverting venue is out.
    expect(v.credit).toBe('Highest of 6 · block 26,187,572 · 15m ago')
    expect(v.href).toBeNull()
  })

  it('a lead with rewards in it: the same total in the headline and the $, and says so', () => {
    const l = list({ venues: [usds({ net: { apr: 0.0451087, apy: 0.046, bound: 'upper', withIncentives: true } }), venue('x', 'X', 0.04)] })
    const v = lead(ok(l))
    expect(v.headline).toEqual({ lead: 'Aave v3 USDS pays', figure: '4.51%', tail: 'APR†' })
    expect(v.mix?.total).toBe('4.51%')
    // $100k × 4.51087%: the ranking's total, rewards included, never the 0.19% alone.
    expect(v.hero).toEqual({ figure: '$4,510', unit: 'a year† incl. rewards' })
    expect(v.ends).toBe(`${REWARDS_MARK} ends 18 Oct`)
  })

  it('rewards that cannot be counted: the lead ranks on the venue rate, unmarked', () => {
    const l = list({ venues: [usds({ net: { apr: 0.0451087, apy: 0.046, bound: 'upper', withIncentives: true } }), venue('x', 'X', 0.04)] })
    for (const status of [
      { ok: false, fetchedAt: null, error: 'down' },
      { ok: true, fetchedAt: (NOW - MERKL_MAX_AGE_MS - 60_000) / 1000 },
    ]) {
      const v = lead(ok({ ...l, incentivesStatus: status }))
      expect(v.headline).toEqual({ lead: 'X pays', figure: '4.00%', tail: 'APR†' })
      expect(v).toMatchObject({ mix: null, ends: null, hero: { figure: '$4,000', unit: 'a year†' } })
    }
  })

  it('links the headline venue when it has a venue page', () => {
    const l = list({ venues: [venue('aave-v3-usde', 'Aave v3 USDe', 0.05), venue('spark-usdc', 'SparkLend USDC', 0.03)] })
    expect(lead(ok(l)).href).toBe('/ethereum/venue/aave-v3-usde')
  })

  it('loading, and a size whose response has not arrived, print dashes (never numbers)', () => {
    for (const v of [lead(PENDING), lead(ok(list()), 1_000_000)]) {
      expect(v.state).toBe('loading')
      expect(v.headline).toBeNull()
      expect(v.hero).toBeNull()
      expect(v.credit).toBeNull()
    }
  })

  it('error: hatched and unavailable, no figures', () => {
    const v = lead(FAILED)
    expect(v).toMatchObject({ state: 'error', hatched: true, withheld: OPP_COPY.ratesUnavailable, hero: null })
  })

  it('stale: the headline and the $ are withheld, the age is shown', () => {
    const v = lead(ok(list()), DEFAULT_SIZE, NOW + NET_APY_MAX_AGE_MS)
    expect(v.state).toBe('stale')
    expect(v.hatched).toBe(true)
    expect(v.withheld).toBe('Rates withheld · read 45m ago')
    expect(v.headline).toBeNull()
    expect(v.hero).toBeNull()
  })

  it('empty: every venue reverts at this size', () => {
    const l = list({ venues: [venue('a', 'A', 0.04, { reverts: 'over the supply cap' })] }, 10_000_000)
    expect(lead(ok(l), 10_000_000)).toMatchObject({ state: 'empty', withheld: 'No venue takes $10M now.', hero: null })
  })
})

describe('ratesView (the ranked table)', () => {
  const rates = (l: Load<NetApyList>, nowMs = NOW) =>
    ratesView({ netApy: l, sizeUsd: DEFAULT_SIZE, chain: 'ethereum', nowMs })

  it('lists the next venues, not the headline one again, and folds the rest', () => {
    const v = rates(ok(list()))
    expect(v.state).toBe('ready')
    expect(v.aprHead).toBe('APR at $100k†')
    expect(v.rows).toHaveLength(RATES_SHOWN)
    expect(v.rows.map((r) => r.label)).toEqual(['Euler eUSDC-2', 'Aave v3 USDC', 'SparkLend USDC'])
    expect(v.rows[0]).toMatchObject({ apr: '4.31%', borrow: '4.93%', mix: null, ends: null, href: null })
    expect(v.excluded).toBe('1 venue reverts at $100k (over the supply cap)')
    // What ‡ marks, and when it was read.
    expect(v.credit).toBe(`After venue fees · ${REWARDS_MARK} Merkl, fetched 12:30 UTC`)
  })

  it('Aave v3 USDS ranks on 3.51% (0.19% on-chain + 3.31% Merkl), not on 0.19%', () => {
    const at = (rewards: boolean) => rankRates(list(), rewards).ranked.map((r) => r.label).indexOf('Aave v3 USDS')
    // Before: on the venue rate alone it was last of six, under Aave v3 USDe's 0.30%.
    expect(at(false)).toBe(5)
    // After: fifth, above Aave v3 USDe.
    expect(at(true)).toBe(4)
    // Into the runners-up when its total outranks theirs, marked, with its end date.
    const l = list({ venues: [venue('a', 'A', 0.05), venue('b', 'B', 0.04), usds(), venue('c', 'C', 0.03), venue('d', 'D', 0.005)] })
    expect(rates(ok(l)).rows.map((r) => [r.label, r.apr, r.ends, r.mix !== null])).toEqual([
      ['B', '4.00%', null, false],
      ['Aave v3 USDS', '3.51%', `${REWARDS_MARK} ends 18 Oct`, true],
      ['C', '3.00%', null, false],
    ])
    // With rewards unavailable it drops out under D's 0.50%, plain.
    const down = rates(ok({ ...l, incentivesStatus: { ok: false, fetchedAt: null } }))
    expect(down.rows.map((r) => [r.label, r.apr, r.mix])).toEqual([
      ['B', '4.00%', null],
      ['C', '3.00%', null],
      ['D', '0.50%', null],
    ])
    expect(down.credit).toBe('After venue fees · rewards unavailable')
  })

  it('rewards older than an hour are not used to rank', () => {
    const l = list({
      venues: [venue('a', 'A', 0.05), usds(), venue('c', 'C', 0.03)],
      incentivesStatus: { ok: true, fetchedAt: (NOW - 2 * HOUR_MS) / 1000 },
    })
    const v = rates(ok(l))
    expect(v.credit).toBe('After venue fees · rewards withheld, read 2h ago')
    expect(v.rows.map((r) => [r.label, r.apr, r.mix, r.ends])).toEqual([
      ['C', '3.00%', null, null],
      ['Aave v3 USDS', '0.19%', null, null],
    ])
  })

  it('a row links its venue page where one exists', () => {
    const l = list({ venues: [venue('x', 'X', 0.05), venue('aave-v3-usde', 'Aave v3 USDe', 0.04)] })
    expect(rates(ok(l)).rows[0]).toMatchObject({ label: 'Aave v3 USDe', href: '/ethereum/venue/aave-v3-usde' })
  })


  it('loading, error and stale', () => {
    expect(rates(PENDING)).toMatchObject({ state: 'loading', hatched: false, rows: [] })
    expect(rates(FAILED)).toMatchObject({ state: 'error', hatched: true, rows: [] })
    expect(rates(ok(list()), NOW + NET_APY_MAX_AGE_MS)).toMatchObject({ state: 'stale', hatched: true })
  })
})

describe('aprMix (the composition behind a ‡ APR)', () => {
  const mix = (r: Venue, l = list(), nowMs = NOW) => aprMix(r, l, nowMs)

  it('venue rate + each reward = the total, with the source, the dilution and the dates', () => {
    expect(mix(usds())).toEqual({
      title: 'Aave v3 USDS · APR at $100k',
      base: '0.19%',
      parts: [{ token: 'aEthUSDS', source: 'Merkl', apr: '3.31%', note: '3.36% reported, diluted by your $100k' }],
      total: '3.51%',
      timeline: [
        {
          token: 'aEthUSDS',
          start: '8 Oct',
          end: '18 Oct',
          // 8 Oct 13:00 → 18 Oct 00:00, read at 14 Oct 12:30: 143.5h of 227h gone.
          elapsed: 143.5 / 227,
          left: '3d left',
        },
      ],
      unknown: 'Not published: renewal, APR history',
      credit: 'Rounded down · venue rate at block 26,187,572 · Merkl, fetched 12:30 UTC, not verified on-chain',
      spoken: '3.51% APR including rewards: venue rate 0.19%, aEthUSDS 3.31%',
    })
  })

  it('a base-only APR has no composition', () => {
    expect(mix(venue('x', 'X', 0.04))).toBeNull()
  })

  it('labels what the source does not give: a missing start, a campaign type that does not dilute', () => {
    const m = mix(usds({ incentives: [{ ...USDS_REWARD, startTs: 0, dilution: 'rate-fixed', rewardSymbol: null }] }))
    expect(m?.parts[0]).toEqual({ token: 'Rewards', source: 'Merkl', apr: '3.31%', note: 'set rate; the budget can run out early' })
    expect(m?.timeline[0]).toMatchObject({ start: 'start not published', end: '18 Oct', elapsed: null })
  })

  it('a reward at its reported rate prints no dilution note; one per campaign, soonest first', () => {
    const second = { ...USDS_REWARD, campaignId: '0x2', rewardSymbol: 'SPK', aprAtSize: 0.01, aprReported: 0.01, endTs: Date.UTC(2026, 9, 30) / 1000 }
    const m = mix(usds({ incentives: [USDS_REWARD, second] }))
    expect(m?.parts.map((p) => [p.token, p.apr, p.note])).toEqual([
      ['aEthUSDS', '3.31%', '3.36% reported, diluted by your $100k'],
      ['SPK', '1.00%', null],
    ])
    expect(m?.timeline.map((t) => t.end)).toEqual(['18 Oct', '30 Oct'])
  })

  it('a response from before the route listed campaigns: one reward line, the difference', () => {
    const m = mix(usds({ incentives: undefined as unknown as Venue['incentives'] }))
    expect(m?.parts).toEqual([{ token: 'Rewards', source: 'Merkl', apr: '3.31%', note: null }])
    expect(m?.timeline).toEqual([{ token: 'Rewards', start: 'start not published', end: '18 Oct', elapsed: null, left: '3d left' }])
  })
})

const summary = (venueName: string, observedAt: string | null, instantUsd: number | null, depthUsd: number | null): VenueSummary =>
  ({
    venue: venueName,
    label: venueName === 'aave-v3-usde' ? 'Aave' : venueName,
    kind: 'x',
    observed: observedAt
      ? {
          block: 1,
          observedAt,
          instantUsd,
          params: { totalAssets: null, cooldownDuration: null, utilizationPct: null, depthUsd, depthSkewPct: null, depthMarkets: null },
        }
      : null,
  }) as VenueSummary

const CAPS: Record<string, [number | null, number | null]> = {
  sUSDe: [null, 48_062_708],
  'aave-v3-usde': [502_842_570, null],
  sUSDS: [null, 4_391_893_463],
  scrvUSD: [null, 21_692_821],
}
const summaries = (at: string, over: Record<string, Load<VenueSummary>> = {}) =>
  RECORDER_VENUES.map((v) => ({ venue: v, load: over[v] ?? ok(summary(v, at, ...CAPS[v])) }))
const FRESH = new Date(NOW - 22 * 60_000).toISOString()
const WEEK_OLD = new Date(NOW - 7 * 24 * HOUR_MS).toISOString()

describe('exitsView (exits against the size)', () => {
  const exits = (s: ReturnType<typeof summaries>, sizeUsd = DEFAULT_SIZE) =>
    exitsView({ summaries: s, sizeUsd, chain: 'ethereum', nowMs: NOW })

  it('capacity is the venue cash where it is read, else the exit pool reserve', () => {
    expect(exitCapacity(summary('a', FRESH, 5, 9))).toEqual({ usd: 5, how: 'held' })
    expect(exitCapacity(summary('a', FRESH, null, 9))).toEqual({ usd: 9, how: 'pool' })
    expect(exitCapacity(summary('a', FRESH, null, null))).toBeNull()
    expect(exitCapacity(summary('a', null, null, null))).toBeNull()
  })

  it('fresh: every exit holds more than the size, and the thinnest is named', () => {
    const v = exits(summaries(FRESH))
    expect(v.state).toBe('ready')
    expect(v.headline).toBe('All 4 exits hold over $100k.')
    expect(v.deck).toBe('Thinnest: scrvUSD, $21.6M.')
    expect(v.rows.map((r) => [r.label, r.figure, r.how, r.age, r.href])).toEqual([
      ['sUSDe', '$48.0M', 'swap pool', '22m', '/ethereum/venue/sUSDe'],
      ['Aave v3 USDe', '$502.8M', 'venue cash', '22m', '/ethereum/venue/aave-v3-usde'],
      ['sUSDS', '$4.39B', 'swap pool', '22m', '/ethereum/venue/sUSDS'],
      ['scrvUSD', '$21.6M', 'swap pool', '22m', '/ethereum/venue/scrvUSD'],
    ])
  })

  it('a size above some exits counts them', () => {
    expect(exits(summaries(FRESH), 50_000_000).headline).toBe('2 of 4 exits hold under $50M.')
  })

  it('stale (the recorder stopped): headline withheld, rows hatched with their ages', () => {
    const v = exits(summaries(WEEK_OLD))
    expect(v.state).toBe('stale')
    expect(v.hatched).toBe(true)
    expect(v.headline).toBeNull()
    expect(v.withheld).toBe('Withheld · exit data 7d old')
    expect(v.rows.every((r) => r.stale && r.age === '7d')).toBe(true)
    // Two hourly ticks is the line.
    const edge = new Date(NOW - RECORDER_MAX_AGE_MS).toISOString()
    expect(exits(summaries(edge)).state).toBe('ready')
  })

  it('loading and unavailable venues withhold the finding', () => {
    expect(exits(summaries(FRESH, { sUSDe: PENDING })).state).toBe('loading')
    const v = exits(summaries(FRESH, { sUSDe: FAILED }))
    expect(v).toMatchObject({ state: 'error', withheld: 'Withheld · sUSDe unavailable' })
    expect(v.rows[0]).toMatchObject({ state: 'error', figure: null })
    const all = exits(RECORDER_VENUES.map((x) => ({ venue: x, load: FAILED })))
    expect(all).toMatchObject({ state: 'error', withheld: OPP_COPY.exitsUnavailable })
  })
})

describe('demandView (tracked carry capital)', () => {
  const demand = (s: Load<StratsDemand>) => demandView({ strats: s, nowMs: NOW })
  const d = (scan: string | null, count = 49): StratsDemand => ({ count, total_usd: 1_715_204_718.85, freshest_scan: scan })

  it('fresh: the $ and the wallet count, with the scan age (ink: not the reader’s money)', () => {
    expect(demand(ok(d(new Date(NOW - 14 * 60_000).toISOString())))).toEqual({
      state: 'ready',
      hatched: false,
      line: '$1.71B tracked in 49 carry wallets.',
      withheld: null,
      age: 'scanned 14m ago',
    })
  })

  it('stale: withheld with the age, said once', () => {
    expect(demand(ok(d('2026-10-02T12:06:28.858Z')))).toMatchObject({
      state: 'stale',
      hatched: true,
      line: null,
      withheld: 'Withheld · last scan 12d old',
      age: null,
    })
    expect(demand(ok(d(null)))).toMatchObject({ state: 'stale', withheld: 'Withheld · not scanned yet' })
  })

  it('loading, error and none tracked', () => {
    expect(demand(PENDING).state).toBe('loading')
    expect(demand(FAILED)).toMatchObject({ state: 'error', hatched: true, withheld: OPP_COPY.demandUnavailable })
    expect(demand(ok(d(null, 0))).line).toBe('No carry wallet is tracked yet.')
  })
})
