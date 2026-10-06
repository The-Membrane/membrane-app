// Oracle registry engine: normalization → consensus → colour, the history replay, and the
// config-change detector. Synthetic catalogs pin the rules at their exact boundaries; one
// block of invariants runs over the collected snapshot (data/oracle-registry/snapshots).

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  getOracleCatalog,
  type OracleCatalog,
  type OracleEntry,
} from '@/lib/oracleRegistry/catalog'
import { classifyParam, detectChanges, detectChangeSeries } from '@/lib/oracleRegistry/changes'
import {
  basisInfo,
  classifyColour,
  colourForDeviation,
  deviationBps,
  evaluateHistory,
  evaluateReadings,
  evaluateSnapshot,
  readingAt,
  sampleGrid,
  timeGrid,
} from '@/lib/oracleRegistry/classify'
import {
  bandFor,
  bandOf,
  consensusOf,
  DEFAULT_BANDS_BPS,
  effectiveBand,
  median,
  resolveConsensus,
  riskClassOf,
} from '@/lib/oracleRegistry/consensus'
import {
  AGE_ONLY_MAX_AGE_SECONDS,
  assessFreshness,
  graceSeconds,
  normalizeToUsd,
  PULL_MAX_AGE_SECONDS,
  resolveQuote,
} from '@/lib/oracleRegistry/normalize'
import type {
  EntryHistory,
  Freshness,
  OracleReading,
  OracleSnapshot,
} from '@/lib/oracleRegistry/types'

// ---- synthetic catalog -----------------------------------------------------------------

const NOW = 1_800_000_000
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`
let addrSeq = 1

function entry(p: {
  id: string
  asset: string
  role?: OracleEntry['consensus']['role']
  cls?: OracleEntry['class']
  quoteUnit?: OracleEntry['quoteUnit']
  quoteAsset?: string
  provider?: OracleEntry['provider']
  hb?: number | null
  updateModel?: OracleEntry['mechanism']['updateModel']
  components?: OracleEntry['mechanism']['components']
  /** Declared deviation threshold (default 50; null = declares none, e.g. a TWAP). */
  dev?: number | null
}): OracleEntry {
  return {
    id: p.id,
    asset: p.asset,
    provider: p.provider ?? 'chainlink',
    label: p.id,
    address: ADDR(addrSeq++),
    chainId: 1,
    readMethod: 'latestRoundData()',
    decimals: 8,
    quoteUnit: p.quoteUnit ?? 'USD',
    ...(p.quoteAsset ? { quoteAsset: p.quoteAsset } : {}),
    class: p.cls ?? 'market',
    consensus: { role: p.role ?? 'member', note: '' },
    mechanism: {
      source: '',
      aggregation: '',
      updateModel: p.updateModel ?? 'push_deviation_heartbeat',
      heartbeatSeconds: p.hb === undefined ? 3600 : p.hb,
      deviationThresholdBps: p.dev === undefined ? 50 : p.dev,
      governance: [],
      components: p.components ?? [],
    },
    usedBy: [],
    historySource: 'chainlink_rounds',
    docsUrl: '',
    status: 'verified',
  }
}

function catalogOf(assets: string[], entries: OracleEntry[]): OracleCatalog {
  return {
    version: 1,
    chainId: 1,
    generatedAt: 'test',
    sources: [],
    consensusPolicy: '',
    stalenessPolicy: '',
    assets: assets.map((key) => ({
      key,
      symbol: key,
      token: null,
      tokenDecimals: null,
      kind: 'mvp' as const,
      sanity: {},
    })),
    entries,
    excluded: [],
  }
}

const read = (id: string, price: number | null, age: number | null = 60): OracleReading => ({
  id,
  price,
  updatedAt: age == null ? null : NOW - age,
})

const FRESH: Freshness = { state: 'fresh', ageSeconds: 60, limitSeconds: 4200, basis: 'heartbeat' }
const keys = new Set(['ETH', 'BTC', 'WBTC', 'USDe', 'weETH'])

// ---- normalization ---------------------------------------------------------------------

describe('normalize', () => {
  it('passes USD through and flags stablecoin quotes as peg-assumed', () => {
    const usd = entry({ id: 'u', asset: 'ETH' })
    expect(normalizeToUsd({ price: 2000 }, resolveQuote(usd, keys), () => null)).toEqual({
      usd: 2000,
      derived: false,
    })
    const usdc = entry({ id: 'c', asset: 'ETH', quoteUnit: 'USD', quoteAsset: 'USDC' })
    expect(normalizeToUsd({ price: 2000 }, resolveQuote(usdc, keys), () => null)).toEqual({
      usd: 2000,
      derived: false,
      pegAssumed: 'USDC',
    })
  })

  it('multiplies ETH-denominated feeds by the ETH consensus and flags them derived', () => {
    const weethEth = entry({ id: 'w', asset: 'weETH', quoteUnit: 'ETH', quoteAsset: 'WETH' })
    const q = resolveQuote(weethEth, keys)
    expect(q).toEqual({ kind: 'asset', asset: 'ETH' }) // WETH is ETH exactly — no peg flag
    const n = normalizeToUsd({ price: 1.1 }, q, (a) => (a === 'ETH' ? 2500 : null))
    expect(n.usd).toBeCloseTo(2750, 9)
    expect(n.derived).toBe(true)
    expect(n.conversion).toEqual({ asset: 'ETH', rate: 2500 })
  })

  it('routes BTC/WBTC/underlying quotes to the right consensus and stETH as peg-assumed ETH', () => {
    expect(resolveQuote(entry({ id: 'a', asset: 'WBTC', quoteUnit: 'BTC' }), keys)).toEqual({
      kind: 'asset',
      asset: 'BTC',
    })
    expect(
      resolveQuote(entry({ id: 'b', asset: 'cbBTC', quoteUnit: 'BTC', quoteAsset: 'WBTC' }), keys),
    ).toEqual({ kind: 'asset', asset: 'WBTC' })
    expect(
      resolveQuote(
        entry({ id: 'c', asset: 'PT', quoteUnit: 'underlying', quoteAsset: 'USDe' }),
        keys,
      ),
    ).toEqual({ kind: 'asset', asset: 'USDe' })
    expect(
      resolveQuote(
        entry({ id: 'd', asset: 'wstETH', quoteUnit: 'underlying', quoteAsset: 'stETH' }),
        keys,
      ),
    ).toEqual({ kind: 'asset', asset: 'ETH', pegAssumed: 'stETH' })
    expect(resolveQuote(entry({ id: 'e', asset: 'X', quoteUnit: 'rate' }), keys).kind).toBe(
      'unsupported',
    )
  })

  it('never guesses: no rate → no_conversion, no price → no_reading', () => {
    const q = resolveQuote(entry({ id: 'w', asset: 'weETH', quoteUnit: 'ETH' }), keys)
    expect(normalizeToUsd({ price: 1.1 }, q, () => null)).toMatchObject({
      usd: null,
      reason: 'no_conversion',
    })
    expect(normalizeToUsd({ price: null }, q, () => 2500)).toMatchObject({
      usd: null,
      reason: 'no_reading',
    })
    expect(normalizeToUsd({ price: 0 }, q, () => 2500).reason).toBe('no_reading')
  })
})

// ---- freshness -------------------------------------------------------------------------

describe('freshness', () => {
  it('is stale strictly past heartbeat + grace (grace = max(600 s, 10%))', () => {
    expect(graceSeconds(3600)).toBe(600)
    expect(graceSeconds(86_400)).toBe(8640)
    const e = entry({ id: 'f', asset: 'ETH', hb: 3600 })
    expect(assessFreshness(e, read('f', 1, 4200), NOW).state).toBe('fresh') // exactly at limit
    expect(assessFreshness(e, read('f', 1, 4201), NOW).state).toBe('stale')
  })

  it('pull feeds use the 1 h limit and heartbeat-less feeds the age-only limit', () => {
    const pyth = entry({ id: 'p', asset: 'ETH', hb: null, updateModel: 'pull' })
    expect(assessFreshness(pyth, read('p', 1, PULL_MAX_AGE_SECONDS + 1), NOW).state).toBe('stale')
    const chronicle = entry({ id: 'c', asset: 'ETH', hb: null })
    const f = assessFreshness(chronicle, read('c', 1, AGE_ONLY_MAX_AGE_SECONDS), NOW)
    expect(f).toMatchObject({ state: 'fresh', basis: 'age_only' })
    expect(assessFreshness(chronicle, read('c', 1, AGE_ONLY_MAX_AGE_SECONDS + 1), NOW).state).toBe(
      'stale',
    )
  })

  it('views inherit staleness from components (each against its own catalog heartbeat)', () => {
    const fastRef = entry({ id: 'ref.eth-usd', asset: 'ETH', hb: 3600 })
    const view = entry({
      id: 'view',
      asset: 'ETH',
      hb: 86_400,
      updateModel: 'on_read_view',
      components: [
        { role: 'BASE', address: fastRef.address, label: '', ref: 'ref.eth-usd' },
        { role: 'QUOTE', address: ADDR(999), label: '' },
      ],
    })
    const byId = (id: string) => (id === fastRef.id ? fastRef : undefined)
    const r = (ageBase: number, ageQuote: number): OracleReading => ({
      id: 'view',
      price: 1,
      updatedAt: null,
      components: [
        { role: 'BASE', address: fastRef.address, updatedAt: NOW - ageBase },
        { role: 'QUOTE', address: ADDR(999), updatedAt: NOW - ageQuote },
      ],
    })
    // the ETH/USD leg (1 h heartbeat) is 2 h old → stale even though the view's own hb is 24 h
    expect(assessFreshness(view, r(7200, 100), NOW, byId)).toMatchObject({
      state: 'stale',
      basis: 'components',
      ageSeconds: 7200,
    })
    // the un-referenced leg uses the view's 24 h heartbeat
    expect(assessFreshness(view, r(100, 80_000), NOW, byId).state).toBe('fresh')
    // a TWAP with no clock at all is 'live'
    const twap = entry({ id: 't', asset: 'ETH', hb: null, updateModel: 'twap' })
    expect(assessFreshness(twap, read('t', 1, null), NOW).state).toBe('live')
  })
})

// ---- consensus -------------------------------------------------------------------------

describe('consensus', () => {
  it('median handles odd, even, unsorted and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([10, 20])).toBe(15)
    expect(median([])).toBeNull()
    expect(median([Number.NaN, 5])).toBe(5)
  })

  it('needs at least two eligible members, else insufficient (one survivor = reference only)', () => {
    const one = consensusOf('X', [
      { id: 'a', usd: 100 },
      { id: 'b', usd: 90, exclusion: 'stale' },
    ])
    expect(one).toMatchObject({
      status: 'insufficient',
      price: null,
      reference: { id: 'a', usd: 100 },
    })
    expect(one.excluded).toEqual([{ id: 'b', reason: 'stale' }])
    expect(consensusOf('X', []).status).toBe('insufficient')
    const two = consensusOf('X', [
      { id: 'a', usd: 100 },
      { id: 'b', usd: 102 },
    ])
    expect(two).toMatchObject({ status: 'ok', price: 101 })
    expect(two.spreadBps).toBeCloseTo((2 / 101) * 10_000, 9)
  })

  it('bands: stables 25, majors 50, LST/LRT 75, PT fixed-income; overridable', () => {
    expect(bandFor('USDe')).toBe(25)
    expect(bandFor('ETH')).toBe(50)
    expect(bandFor('cbBTC')).toBe(50)
    expect(bandFor('weETH')).toBe(75)
    expect(riskClassOf('PT-srUSDe-22OCT2026')).toBe('fixed_income')
    expect(bandFor('PT-x')).toBe(DEFAULT_BANDS_BPS.fixed_income)
    expect(bandFor('ETH', { byClass: { major: 40 } })).toBe(40)
    expect(bandFor('ETH', { byAsset: { ETH: 30 }, byClass: { major: 40 } })).toBe(30)
  })

  it('resolves dependencies first: weETH/ETH members need the ETH consensus at the same time', () => {
    const cat = catalogOf(
      ['weETH', 'ETH'], // deliberately out of dependency order
      [
        entry({ id: 'eth.a', asset: 'ETH' }),
        entry({ id: 'eth.b', asset: 'ETH', provider: 'redstone' }),
        entry({ id: 'eth.c', asset: 'ETH', provider: 'chronicle' }),
        entry({ id: 'weeth.ratio', asset: 'weETH', quoteUnit: 'ETH' }),
        entry({ id: 'weeth.usd', asset: 'weETH', provider: 'chronicle' }),
      ],
    )
    const readings = new Map(
      [
        read('eth.a', 2000),
        read('eth.b', 2010),
        read('eth.c', 2020),
        read('weeth.ratio', 1.1),
        read('weeth.usd', 2205),
      ].map((r) => [r.id, r]),
    )
    const { byAsset, entries } = resolveConsensus(cat, readings, NOW)
    expect(byAsset.get('ETH')).toMatchObject({ status: 'ok', price: 2010 })
    const weeth = byAsset.get('weETH')
    expect(weeth?.status).toBe('ok')
    expect(weeth?.price).toBeCloseTo((1.1 * 2010 + 2205) / 2, 9)
    expect(entries.get('weeth.ratio')?.normalized).toMatchObject({ derived: true })
  })

  it('excludes stale members and members whose conversion is missing', () => {
    const cat = catalogOf(
      ['ETH', 'weETH'],
      [
        entry({ id: 'eth.a', asset: 'ETH' }),
        entry({ id: 'eth.stale', asset: 'ETH', provider: 'redstone' }),
        entry({ id: 'weeth.ratio', asset: 'weETH', quoteUnit: 'ETH' }),
        entry({ id: 'weeth.usd', asset: 'weETH', provider: 'chronicle' }),
        entry({ id: 'weeth.usd2', asset: 'weETH', provider: 'redstone' }),
      ],
    )
    const readings = new Map(
      [
        read('eth.a', 2000),
        read('eth.stale', 2000, 99_999),
        read('weeth.ratio', 1.1),
        read('weeth.usd', 2200),
        read('weeth.usd2', 2210),
      ].map((r) => [r.id, r]),
    )
    const { byAsset } = resolveConsensus(cat, readings, NOW)
    expect(byAsset.get('ETH')).toMatchObject({
      status: 'insufficient',
      excluded: [{ id: 'eth.stale', reason: 'stale' }],
    })
    // ETH has no consensus → the ETH-quoted weETH member cannot vote; the two USD ones still do
    expect(byAsset.get('weETH')).toMatchObject({ status: 'ok', price: 2205 })
    expect(byAsset.get('weETH')?.excluded).toEqual([{ id: 'weeth.ratio', reason: 'no_conversion' }])
  })
})

// ---- colour ----------------------------------------------------------------------------

describe('colour', () => {
  const okConsensus = (price: number) => ({
    asset: 'ETH',
    status: 'ok' as const,
    price,
    memberIds: [],
    excluded: [],
    spreadBps: 0,
    minMembers: 2,
  })
  const colourAt = (usd: number, band = 50, freshness: Freshness = FRESH) =>
    classifyColour({
      price: usd,
      normalized: { usd, derived: false },
      freshness,
      consensus: okConsensus(2000),
      bandBps: band,
    })

  it('is green exactly at ±band and red/gold just beyond it', () => {
    expect(deviationBps(2010, 2000)).toBe(50)
    expect(colourAt(2010)).toMatchObject({
      colour: 'green',
      reason: 'within_band',
      deviationBps: 50,
    })
    expect(colourAt(1990)).toMatchObject({ colour: 'green', deviationBps: -50 })
    expect(colourAt(2010.02)).toMatchObject({ colour: 'gold', reason: 'upside_outlier' })
    expect(colourAt(1989.98)).toMatchObject({ colour: 'red', reason: 'downside_outlier' })
    expect(colourForDeviation(25, 25)).toBe('green')
    expect(colourForDeviation(-25.0001, 25)).toBe('red')
    expect(colourForDeviation(75.0001, 75)).toBe('gold')
  })

  it('stale overrides green (and keeps the deviation for display)', () => {
    const stale: Freshness = {
      state: 'stale',
      ageSeconds: 9999,
      limitSeconds: 4200,
      basis: 'heartbeat',
    }
    expect(colourAt(2000, 50, stale)).toMatchObject({
      colour: 'stale',
      reason: 'stale',
      deviationBps: 0,
    })
  })

  it('is unavailable without a reading, a conversion or a consensus', () => {
    const base = { freshness: FRESH, bandBps: 50 }
    expect(
      classifyColour({
        ...base,
        price: null,
        normalized: { usd: null, derived: false, reason: 'no_reading' },
        consensus: okConsensus(1),
      }),
    ).toMatchObject({ colour: 'unavailable', reason: 'no_reading' })
    expect(
      classifyColour({
        ...base,
        price: 1.1,
        normalized: { usd: null, derived: true, reason: 'no_conversion' },
        consensus: okConsensus(1),
      }),
    ).toMatchObject({ colour: 'unavailable', reason: 'no_conversion' })
    expect(
      classifyColour({
        ...base,
        price: 1,
        normalized: { usd: 1, derived: false },
        consensus: { ...okConsensus(1), status: 'insufficient', price: null },
      }),
    ).toMatchObject({ colour: 'unavailable', reason: 'insufficient_consensus' })
  })
})

// ---- basis cards -----------------------------------------------------------------------

describe('exchange-rate / capped basis handling', () => {
  // wstETH-like asset trading at a 1% discount to its redemption value.
  const cat = catalogOf(
    ['ETH', 'LST'],
    [
      entry({ id: 'eth.a', asset: 'ETH' }),
      entry({ id: 'eth.b', asset: 'ETH', provider: 'redstone' }),
      entry({ id: 'lst.mkt1', asset: 'LST' }),
      entry({ id: 'lst.mkt2', asset: 'LST', provider: 'redstone' }),
      entry({ id: 'lst.mkt3', asset: 'LST', provider: 'chronicle' }),
      entry({
        id: 'lst.rate',
        asset: 'LST',
        cls: 'exchange_rate',
        role: 'basis',
        provider: 'spark',
        quoteUnit: 'ETH',
      }),
      entry({
        id: 'lst.capo',
        asset: 'LST',
        cls: 'capped_exchange_rate',
        role: 'basis',
        provider: 'aave',
      }),
    ],
  )
  const board = evaluateReadings(
    cat,
    [
      read('eth.a', 2000),
      read('eth.b', 2000),
      read('lst.mkt1', 2376), // market: 1.188 ETH
      read('lst.mkt2', 2376),
      read('lst.mkt3', 2376),
      read('lst.rate', 1.2), // redemption: 1.2 ETH → +101 bps vs market
      read('lst.capo', 2350), // cap binding: −109 bps vs market
    ],
    NOW,
  )
  const lst = board.assets.find((a) => a.asset === 'LST')
  const card = (id: string) => lst?.cards.find((c) => c.id === id)

  it('basis feeds never vote: the consensus is the market median', () => {
    expect(lst?.consensus).toMatchObject({ status: 'ok', price: 2376 })
    expect(lst?.consensus.memberIds).toEqual(['lst.mkt1', 'lst.mkt2', 'lst.mkt3'])
    expect(card('lst.rate')?.countedInConsensus).toBe(false)
  })

  it('a healthy exchange rate during a market discount shows as GOLD basis, not a red outlier', () => {
    const c = card('lst.rate')
    expect(c?.colour).toBe('gold')
    expect(c?.tone).toBe('basis')
    expect(c?.derived).toBe(true)
    expect(c?.deviationBps).toBeCloseTo(101.0101, 3)
    expect(c?.basis).toMatchObject({
      direction: 'above_market',
      label: 'exchange rate, not a market price',
    })
  })

  it('a CAPO below the market beyond the band is red, labelled as a possibly binding cap', () => {
    const c = card('lst.capo')
    expect(c?.colour).toBe('red')
    expect(c?.tone).toBe('basis')
    expect(c?.basis?.direction).toBe('below_market')
    expect(c?.basis?.explanation).toMatch(/cap may be binding/)
  })

  it('a small basis is green and still labelled; market cards carry no basis block', () => {
    const e = cat.entries.find((x) => x.id === 'lst.rate') as OracleEntry
    expect(basisInfo(e, 10)?.direction).toBe('above_market')
    expect(basisInfo(e, null)).toBeUndefined()
    expect(card('lst.mkt1')?.basis).toBeUndefined()
    expect(card('lst.mkt1')?.tone).toBe('outlier')
  })
})

// ---- history -----------------------------------------------------------------------------

describe('history replay', () => {
  const ev = (id: string, points: [number, number][]): EntryHistory => ({
    id,
    source: 'chainlink_rounds',
    from: 0,
    to: 0,
    points,
  })

  it('event series are step functions: the last update at or before t, with its age', () => {
    const h = ev('a', [
      [100, 10],
      [200, 20],
    ])
    expect(readingAt(h, 99)).toEqual({ id: 'a', price: null, updatedAt: null })
    expect(readingAt(h, 150)).toEqual({ id: 'a', price: 10, updatedAt: 100 })
    expect(readingAt(h, 200)).toEqual({ id: 'a', price: 20, updatedAt: 200 })
    expect(readingAt({ ...h, source: 'none_public', points: [] }, 150)).toBeUndefined()
  })

  it('sampled series read the NEAREST sample within half a step, keeping a third-element clock', () => {
    const s: EntryHistory = {
      id: 's',
      source: 'archive_sampling',
      stepSeconds: 3600,
      from: 0,
      to: 0,
      points: [
        [3600, 1, 3500],
        [7200, 2],
      ],
    }
    expect(readingAt(s, 7190)).toEqual({ id: 's', price: 2, updatedAt: null }) // next is nearer
    expect(readingAt(s, 3700)).toEqual({ id: 's', price: 1, updatedAt: 3500 })
    expect(readingAt(s, 7200 + 1801)?.price).toBeNull() // beyond tolerance
    expect(sampleGrid(new Map([['s', s]]))).toEqual([3600, 7200])
    expect(timeGrid(0, 7200, 3600)).toEqual([0, 3600, 7200])
  })

  it('replays the snapshot rules over a grid (conversion at the same moment, staleness, bands)', () => {
    const cat = catalogOf(
      ['ETH', 'weETH'],
      [
        entry({ id: 'eth.a', asset: 'ETH' }),
        entry({ id: 'eth.b', asset: 'ETH', provider: 'redstone' }),
        entry({ id: 'w.ratio', asset: 'weETH', quoteUnit: 'ETH' }),
        entry({ id: 'w.usd', asset: 'weETH', provider: 'chronicle' }),
      ],
    )
    const T = 1_000_000
    const histories = new Map<string, EntryHistory>([
      [
        'eth.a',
        ev('eth.a', [
          [T, 2000],
          [T + 3600, 2200],
        ]),
      ],
      [
        'eth.b',
        ev('eth.b', [
          [T, 2000],
          [T + 3600, 2200],
        ]),
      ],
      ['w.ratio', ev('w.ratio', [[T, 1.1]])],
      [
        'w.usd',
        ev('w.usd', [
          [T, 2200],
          [T + 3600, 2420],
        ]),
      ],
    ])
    const s = evaluateHistory(cat, histories, [T + 60, T + 3660, T + 3600 * 3])
    expect(s.consensus.ETH).toEqual([2000, 2200, null]) // third point: ETH feeds stale (> 4200 s)
    expect(s.entries['w.ratio'].usd[0]).toBeCloseTo(2200, 9)
    expect(s.entries['w.ratio'].usd[1]).toBeCloseTo(2420, 9) // ratio held, ETH moved: same moment
    expect(s.entries['w.ratio'].colour.slice(0, 2)).toEqual(['green', 'green'])
    expect(s.entries['eth.a'].colour[2]).toBe('stale')
  })
})

// ---- change detection --------------------------------------------------------------------

describe('change detector', () => {
  const snap = (block: number, entries: OracleSnapshot['entries']): OracleSnapshot => ({
    version: 1,
    chainId: 1,
    block,
    ts: block * 12,
    catalogGeneratedAt: 'test',
    entries,
  })
  const row = (id: string, params: Record<string, string | number | null>, config = {}) => ({
    id,
    price: 1,
    updatedAt: null,
    params,
    config: { heartbeatSeconds: 3600, ...config },
  })

  it('reports aggregator swaps, cap updates, market-source swaps and catalog heartbeat edits', () => {
    const a = snap(1, [
      row('feed', { aggregator: '0xAAAA000000000000000000000000000000000001', phaseId: 6 }),
      row('capo', { getSnapshotRatio: '1000', getMaxYearlyGrowthRatePercent: '880' }),
      row('pt', { 'source:Aave V3 Core PT': '0x1111111111111111111111111111111111111111' }),
    ])
    const b = snap(2, [
      row(
        'feed',
        { aggregator: '0xBBBB000000000000000000000000000000000002', phaseId: 7 },
        { heartbeatSeconds: 86_400 },
      ),
      row('capo', { getSnapshotRatio: '1010', getMaxYearlyGrowthRatePercent: '880' }),
      row('pt', { 'source:Aave V3 Core PT': '0x2222222222222222222222222222222222222222' }),
    ])
    const ch = detectChanges(a, b)
    const kinds = ch.map((c) => `${c.entryId}:${c.param}:${c.kind}:${c.origin}`)
    expect(kinds).toEqual([
      'feed:aggregator:aggregator:onchain',
      'feed:phaseId:aggregator:onchain',
      'feed:heartbeatSeconds:heartbeat:catalog',
      'capo:getSnapshotRatio:cap:onchain',
      'pt:source:Aave V3 Core PT:market_source:onchain',
    ])
    expect(ch[0]).toMatchObject({ fromBlock: 1, toBlock: 2, fromTs: 12, toTs: 24 })
  })

  it('ignores unreadable values and address case; reports entries added and removed', () => {
    const a = snap(1, [
      row('x', { aggregator: '0xabcdef0000000000000000000000000000000001', bar: 13 }),
      row('gone', {}),
    ])
    const b = snap(2, [
      row('x', { aggregator: '0xABCDEF0000000000000000000000000000000001', bar: null }),
      row('new', {}),
    ])
    expect(detectChanges(a, b).map((c) => `${c.entryId}:${c.kind}`)).toEqual([
      'new:entry_added',
      'gone:entry_removed',
    ])
  })

  it('maps parameter names onto alert categories', () => {
    expect(classifyParam('twapWindowSeconds')).toBe('twap_window')
    expect(classifyParam('deviationThresholdBps')).toBe('deviation_threshold')
    expect(classifyParam('deviationThreshold')).toBe('deviation_threshold')
    expect(classifyParam('discountRatePerYear')).toBe('discount')
    expect(classifyParam('priceCap')).toBe('cap')
    expect(classifyParam('currentOracle')).toBe('market_source')
    expect(classifyParam('component:BASE_FEED_1')).toBe('wiring')
    expect(classifyParam('bar')).toBe('quorum')
    expect(classifyParam('updateModel')).toBe('update_model')
    expect(classifyParam('MATURITY')).toBe('other')
  })
})

// ---- invariants over the collected snapshot ---------------------------------------------

const LATEST = join(process.cwd(), 'data', 'oracle-registry', 'snapshots', 'latest.json')

describe.skipIf(!existsSync(LATEST))('collected snapshot invariants', () => {
  const catalog = getOracleCatalog()
  const snapshot = JSON.parse(readFileSync(LATEST, 'utf8')) as OracleSnapshot
  const board = evaluateSnapshot(catalog, snapshot)
  const cards = board.assets.flatMap((a) => a.cards)

  it('covers every verified catalog entry exactly once', () => {
    const verified = catalog.entries.filter((e) => e.status === 'verified').map((e) => e.id)
    expect(cards.map((c) => c.id).sort()).toEqual([...verified].sort())
    expect(new Set(snapshot.entries.map((r) => r.id)).size).toBe(snapshot.entries.length)
  })

  it('never paints a stale card green and never lets a non-member vote', () => {
    for (const c of cards) {
      if (c.freshness.state === 'stale') expect(c.colour, c.id).toBe('stale')
      if (c.countedInConsensus) expect(c.role, c.id).toBe('member')
    }
  })

  it('every ok consensus lies within its members’ range', () => {
    for (const a of board.assets) {
      if (a.consensus.status !== 'ok') continue
      const usd = a.cards.filter((c) => c.countedInConsensus).map((c) => c.usd as number)
      expect(usd.length, a.asset).toBeGreaterThanOrEqual(2)
      expect(a.consensus.price, a.asset).toBeGreaterThanOrEqual(Math.min(...usd))
      expect(a.consensus.price, a.asset).toBeLessThanOrEqual(Math.max(...usd))
    }
  })
})

// ---- review fixes (2026-10-05): staleness of multi-leg views ----------------------------

describe('freshness of views with legs', () => {
  const viewOf = (id: string, asset: string, components: OracleEntry['mechanism']['components']) =>
    entry({
      id,
      asset,
      hb: 86_400,
      updateModel: 'on_read_view',
      role: 'basis',
      cls: 'composite',
      components,
    })

  it('judges a leg with no ref by the catalog entry at its address, not the view’s 24 h heartbeat', () => {
    const btc = entry({ id: 'btc.feed', asset: 'BTC', hb: 3600 })
    const view = viewOf('wbtc.view', 'WBTC', [
      { role: 'BASE_FEED_2', address: btc.address, label: 'BTC / USD' }, // no ref
    ])
    const readings = new Map<string, OracleReading>([
      ['btc.feed', read('btc.feed', 60_000, 72_000)],
      [
        'wbtc.view',
        {
          id: 'wbtc.view',
          price: 60_000,
          updatedAt: null,
          components: [{ role: 'BASE_FEED_2', address: btc.address, updatedAt: NOW - 72_000 }],
        },
      ],
    ])
    const { entries } = resolveConsensus(catalogOf(['BTC', 'WBTC'], [btc, view]), readings, NOW)
    expect(entries.get('wbtc.view')?.freshness).toMatchObject({
      state: 'stale',
      basis: 'components',
      ageSeconds: 72_000,
      limitSeconds: 4200,
    })
  })

  it('uses a non-catalog leg’s declared heartbeat', () => {
    const view = viewOf('v', 'ETH', [
      { role: 'QUOTE', address: ADDR(901), label: 'DAI / USD', heartbeatSeconds: 3600 },
    ])
    const r: OracleReading = {
      id: 'v',
      price: 1,
      updatedAt: null,
      components: [{ role: 'QUOTE', address: ADDR(901), updatedAt: NOW - 20_000 }],
    }
    expect(assessFreshness(view, r, NOW)).toMatchObject({ state: 'stale', limitSeconds: 4200 })
  })

  it('a leg that is a catalog entry passes on that entry’s verdict, recursively', () => {
    // feed (1 h) ← capped adapter (no clock, reads the feed) ← CAPO view (reads the adapter)
    const feed = entry({ id: 'usdt.feed', asset: 'USDe', hb: 3600, role: 'alternate' })
    const capped = viewOf('usde.capped', 'USDe', [
      { role: 'ASSET_TO_USD', address: feed.address, label: '', ref: 'usdt.feed' },
    ])
    const capo = viewOf('susde.capo', 'sUSDe', [
      { role: 'BASE_TO_USD', address: capped.address, label: '', ref: 'usde.capped' },
    ])
    const cat = catalogOf(['USDe', 'sUSDe'], [feed, capped, capo])
    const bare = (id: string): OracleReading => ({ id, price: 1, updatedAt: null })
    const at = (age: number) =>
      new Map([
        ['usdt.feed', read('usdt.feed', 1, age)],
        ['usde.capped', bare('usde.capped')],
        ['susde.capo', bare('susde.capo')],
      ])
    expect(
      resolveConsensus(cat, at(20_000), NOW).entries.get('susde.capo')?.freshness,
    ).toMatchObject({ state: 'stale', ageSeconds: 20_000, limitSeconds: 4200, basis: 'components' })
    expect(resolveConsensus(cat, at(60), NOW).entries.get('susde.capo')?.freshness.state).toBe(
      'fresh',
    )
  })

  it('ignores a timestamp that is the read time and ages the view by its legs instead', () => {
    const cl = entry({ id: 'eth.cl', asset: 'ETH', hb: 3600 })
    const median = entry({
      id: 'eth.median',
      asset: 'ETH',
      hb: null,
      role: 'derived',
      cls: 'composite',
      updateModel: 'on_read_view',
      components: [{ role: 'chainlink', address: cl.address, label: '', ref: 'eth.cl' }],
    })
    median.mechanism.timestampIsReadTime = true
    const readings = new Map([
      ['eth.cl', read('eth.cl', 2000, 20_000)],
      ['eth.median', read('eth.median', 2000, 0)], // updatedAt = block time
    ])
    const { entries } = resolveConsensus(catalogOf(['ETH'], [cl, median]), readings, NOW)
    expect(entries.get('eth.median')?.freshness).toMatchObject({
      state: 'stale',
      ageSeconds: 20_000,
    })
  })

  it('never recurses forever on a reference cycle', () => {
    const a = viewOf('a', 'ETH', [])
    const b = viewOf('b', 'ETH', [{ role: 'A', address: a.address, label: '', ref: 'a' }])
    a.mechanism.components.push({ role: 'B', address: b.address, label: '', ref: 'b' })
    const readings = new Map([
      ['a', { id: 'a', price: 1, updatedAt: null }],
      ['b', { id: 'b', price: 1, updatedAt: null }],
    ])
    const { entries } = resolveConsensus(catalogOf(['ETH'], [a, b]), readings, NOW)
    expect(entries.get('a')?.freshness.state).toBe('live')
  })

  it('real catalog: every Morpho leg is judged against its own heartbeat, not the market’s 24 h', () => {
    const cat = getOracleCatalog()
    const byId = (id: string) => cat.entries.find((x) => x.id === id)
    for (const [id, role] of [
      ['wbtc.morpho.wbtc-usdc', 'BASE_FEED_2'],
      ['wbtc.morpho.wbtc-usdt', 'BASE_FEED_2'],
      ['wbtc.morpho.wbtc-rlusd', 'BASE_FEED_2'],
      ['weeth.morpho.weeth-rlusd', 'BASE_FEED_2'],
      ['weeth.morpho.weeth-pyusd', 'BASE_FEED_2'],
      ['susds.morpho.susds-usdt-dai', 'BASE_FEED_1'], // DAI/USD, not a catalog entry
    ] as const) {
      const e = byId(id) as OracleEntry
      const reading: OracleReading = {
        id,
        price: 1,
        updatedAt: null,
        components: e.mechanism.components.map((k) => ({
          role: k.role,
          address: k.address,
          updatedAt: NOW - (k.role === role ? 72_000 : 60),
        })),
      }
      expect(assessFreshness(e, reading, NOW, byId), id).toMatchObject({
        state: 'stale',
        limitSeconds: 4200,
      })
    }
  })
})

describe('real catalog: views whose input has no clock still age by the feed underneath', () => {
  const cat = getOracleCatalog()
  const byId = (id: string) => cat.entries.find((e) => e.id === id) as OracleEntry
  const bare = (id: string): OracleReading => ({ id, price: 1, updatedAt: null })
  const legsAt = (id: string, ages: Record<string, number>): OracleReading => ({
    ...bare(id),
    components: Object.entries(ages).map(([address, age]) => ({
      role: byId(id).mechanism.components.find((k) => k.address === address)?.role ?? address,
      address,
      updatedAt: NOW - age,
    })),
  })
  const freshness = (readings: OracleReading[], id: string) =>
    resolveConsensus(cat, new Map(readings.map((r) => [r.id, r])), NOW).entries.get(id)?.freshness

  it('Spark’s medians (clock = read time) and the Spark exchange rates built on them', () => {
    const readings = [
      read('eth.chainlink.eth-usd', 2000, 20_000), // 1 h heartbeat: stale
      read('eth.chronicle.eth-usd', 2000, 60),
      read('eth.redstone.eth-usd', 2000, 60),
      read('eth.spark.eth-usd-median', 2000, 0), // latestRoundData's updatedAt = block time
      legsAt('wsteth.spark.exchange-rate', {
        [byId('eth.spark.eth-usd-median').address]: 0,
      }),
    ]
    expect(freshness(readings, 'eth.spark.eth-usd-median')).toMatchObject({
      state: 'stale',
      ageSeconds: 20_000,
    })
    expect(freshness(readings, 'wsteth.spark.exchange-rate')?.state).toBe('stale')
    readings[0] = read('eth.chainlink.eth-usd', 2000, 60)
    expect(freshness(readings, 'eth.spark.eth-usd-median')?.state).toBe('fresh')
  })

  it('Aave sUSDe CAPO → capped USDT adapter → Chainlink USDT/USD', () => {
    const usdt = '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D'
    const readings = [legsAt('usde.aave.capped-usdt', { [usdt]: 100_000 }), bare('susde.aave.capo')]
    expect(freshness(readings, 'susde.aave.capo')).toMatchObject({
      state: 'stale',
      limitSeconds: 95_040,
    })
  })

  it('the PT linear discount (nested USDT/USD) and the cbBTC meta-oracle (primary feed)', () => {
    const pt = 'pt-srusde-22oct2026.aave.linear-discount'
    const usdt = '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D'
    expect(freshness([legsAt(pt, { [usdt]: 100_000 })], pt)?.state).toBe('stale')
    const meta = 'cbbtc.morpho.cbbtc-usdt-meta'
    expect(
      freshness([read('btc.chainlink.btc-usd-shared-svr', 86_000, 20_000), bare(meta)], meta),
    ).toMatchObject({ state: 'stale', limitSeconds: 4200 })
  })
})

describe('feeds with no update clock', () => {
  it('are never green: a push feed without a timestamp is unavailable (unknown_freshness)', () => {
    const v = classifyColour({
      price: 2000,
      normalized: { usd: 2000, derived: false },
      freshness: { state: 'unknown', ageSeconds: null, limitSeconds: null, basis: 'none' },
      consensus: {
        asset: 'ETH',
        status: 'ok',
        price: 2000,
        memberIds: ['a', 'b'],
        excluded: [],
        spreadBps: 0,
        minMembers: 2,
      },
      bandBps: 50,
    })
    expect(v).toEqual({ colour: 'unavailable', reason: 'unknown_freshness', deviationBps: 0 })
  })
})

// ---- review fixes: a two-member consensus is a tie --------------------------------------

describe('two-member consensus', () => {
  // Real thresholds: Chainlink USDe/USD 0.5%, RedStone 0.2%, Pyth/Chronicle declare none —
  // so the effective band is max(25, 50 + 20) = 70 bps.
  const usde = (extra: OracleEntry[] = []) =>
    catalogOf(
      ['USDe'],
      [
        entry({ id: 'usde.cl', asset: 'USDe', hb: 86_400, dev: 50 }),
        entry({ id: 'usde.rs', asset: 'USDe', provider: 'redstone', hb: 86_400, dev: 20 }),
        entry({ id: 'usde.py', asset: 'USDe', provider: 'pyth', updateModel: 'pull', dev: null }),
        ...extra,
      ],
    )
  const chronicle = () =>
    entry({ id: 'usde.ch', asset: 'USDe', provider: 'chronicle', hb: 86_400, dev: null })

  it('blames neither feed when the only two fresh members are more than two bands apart', () => {
    // Pyth is months stale, so Chainlink and RedStone are the only voters; Chainlink is
    // ~157 bps off — more than 2 × the 70 bps effective band.
    const board = evaluateReadings(
      usde(),
      [read('usde.cl', 0.984), read('usde.rs', 0.9996), read('usde.py', 1, 10_000_000)],
      NOW,
    )
    const a = board.assets[0]
    expect(a.bandBps).toBe(70)
    expect(a.consensus).toMatchObject({
      status: 'insufficient',
      reason: 'members_disagree',
      price: null,
      memberIds: ['usde.cl', 'usde.rs'],
    })
    expect(a.consensus.spreadBps).toBeCloseTo(157.3, 1)
    for (const c of a.cards) expect(['red', 'gold'], c.id).not.toContain(c.colour)
    expect(a.cards.find((c) => c.id === 'usde.rs')?.colour).toBe('unavailable')
  })

  it('an honest pair a full d1 + d2 = 70 bps apart is a consensus, both green (effective band)', () => {
    // Each feed lags spot the opposite way inside its own trigger. Under the bare ±25 bps
    // class band this pair was 'members_disagree' (35 bps from the midpoint > 25).
    const board = evaluateReadings(
      usde(),
      [read('usde.cl', 0.9965), read('usde.rs', 1.0035), read('usde.py', 1, 10_000_000)],
      NOW,
    )
    const a = board.assets[0]
    expect(a.consensus).toMatchObject({ status: 'ok', price: 1 })
    expect(a.consensus.spreadBps).toBeCloseTo(70, 6)
    expect(a.cards.find((c) => c.id === 'usde.cl')?.colour).toBe('green')
    expect(a.cards.find((c) => c.id === 'usde.rs')?.colour).toBe('green')
    const atClassBand = consensusOf(
      'USDe',
      [
        { id: 'a', usd: 0.9965 },
        { id: 'b', usd: 1.0035 },
      ],
      2,
      DEFAULT_BANDS_BPS.stable,
    )
    expect(atClassBand).toMatchObject({ status: 'insufficient', reason: 'members_disagree' })
  })

  it('still forms a consensus while two members sit within two bands (honest trigger lag)', () => {
    const c = consensusOf(
      'USDe',
      [
        // 40 bps apart: each 20 bps from the midpoint, inside the 25 bps band.
        { id: 'a', usd: 0.998 },
        { id: 'b', usd: 1.002 },
      ],
      2,
      25,
    )
    expect(c).toMatchObject({ status: 'ok', price: 1 })
    expect(c.reason).toBeUndefined()
    // No band given (a caller outside the engine): the old midpoint rule.
    expect(
      consensusOf('USDe', [
        { id: 'a', usd: 0.99 },
        { id: 'b', usd: 1.01 },
      ]).status,
    ).toBe('ok')
  })

  it('with a third member the median is a member, so only the bad feed is flagged', () => {
    // Chainlink ~76 bps under the median: outside the 70 bps effective band.
    const board = evaluateReadings(
      usde([chronicle()]),
      [read('usde.cl', 0.992), read('usde.rs', 0.9996), read('usde.ch', 0.9997)],
      NOW,
    )
    const colours = Object.fromEntries(board.assets[0].cards.map((c) => [c.id, c.colour]))
    expect(colours).toMatchObject({ 'usde.cl': 'red', 'usde.rs': 'green', 'usde.ch': 'green' })
    // ~56 bps under: inside its own 0.5% trigger, so green (red under the bare ±25 class band).
    const honest = evaluateReadings(
      usde([chronicle()]),
      [read('usde.cl', 0.994), read('usde.rs', 0.9996), read('usde.ch', 0.9997)],
      NOW,
    )
    const cl = honest.assets[0].cards.find((c) => c.id === 'usde.cl')!
    expect(cl.deviationBps).toBeCloseTo(-56, 0)
    expect(cl.colour).toBe('green')
  })
})

// ---- owner ruling 2026-10-05: the effective band ----------------------------------------

describe("effective band = max(class band, d1 + d2 of the members' declared thresholds)", () => {
  it('the formula: 0, 1 and 2+ declared thresholds', () => {
    // None declared (TWAPs, Chronicle, pull oracles): the class band.
    expect(effectiveBand(25, [])).toEqual({ bandBps: 25, classBandBps: 25, thresholdsBps: [] })
    expect(effectiveBand(25, [null, undefined, Number.NaN])).toEqual({
      bandBps: 25,
      classBandBps: 25,
      thresholdsBps: [],
    })
    // Exactly one declared: max(class, d1).
    expect(effectiveBand(25, [50, null])).toEqual({
      bandBps: 50,
      classBandBps: 25,
      thresholdsBps: [50],
    })
    expect(effectiveBand(75, [null, 50]).bandBps).toBe(75)
    // Two or more: the two LARGEST, summed; the rest and the undeclared add nothing.
    expect(effectiveBand(25, [20, null, 50, 10])).toEqual({
      bandBps: 70,
      classBandBps: 25,
      thresholdsBps: [50, 20],
    })
    expect(effectiveBand(50, [50, 200, 50]).bandBps).toBe(250)
    expect(effectiveBand(50, [25, 25]).bandBps).toBe(50) // a tie keeps the class band
  })

  it('USDe-like members (Chainlink 0.5% + RedStone 0.2% + Pyth none) widen ±25 to ±70', () => {
    const cat = catalogOf(
      ['USDe'],
      [
        entry({ id: 'usde.cl', asset: 'USDe', dev: 50 }),
        entry({ id: 'usde.rs', asset: 'USDe', provider: 'redstone', dev: 20 }),
        entry({ id: 'usde.py', asset: 'USDe', provider: 'pyth', dev: null }),
      ],
    )
    expect(bandOf(cat, 'USDe')).toEqual({ bandBps: 70, classBandBps: 25, thresholdsBps: [50, 20] })
    // The collected catalog says the same for both Ethena dollars.
    expect(bandOf(getOracleCatalog(), 'USDe').bandBps).toBe(70)
    expect(bandOf(getOracleCatalog(), 'sUSDe').bandBps).toBe(70)
  })

  it('never widens a non-stable asset, however loose its feeds (cbBTC/USD triggers at 2%)', () => {
    const cat = catalogOf(
      ['cbBTC', 'USDe'],
      [
        entry({ id: 'c.a', asset: 'cbBTC', dev: 200 }),
        entry({ id: 'c.b', asset: 'cbBTC', provider: 'redstone', dev: 50 }),
        entry({ id: 'u.a', asset: 'USDe', dev: 50 }),
        entry({ id: 'u.b', asset: 'USDe', provider: 'redstone', dev: 20 }),
      ],
    )
    expect(bandOf(cat, 'cbBTC')).toEqual({ bandBps: 50, classBandBps: 50, thresholdsBps: [] })
    expect(bandOf(cat, 'USDe')).toEqual({ bandBps: 70, classBandBps: 25, thresholdsBps: [50, 20] })
  })

  it('the class band dominates when the declared thresholds sum to less', () => {
    const cat = catalogOf(
      ['weETH', 'sUSDS'],
      [
        entry({ id: 'w.a', asset: 'weETH', dev: 20 }),
        entry({ id: 'w.b', asset: 'weETH', provider: 'redstone', dev: 20 }),
        entry({ id: 'w.c', asset: 'weETH', provider: 'uniswap_v3', dev: null }),
        entry({ id: 's.a', asset: 'sUSDS', provider: 'chronicle', dev: null }),
      ],
    )
    // Owner ruling 2026-10-05 widens the STABLE band only: a non-stable asset keeps its class band.
    expect(bandOf(cat, 'weETH')).toEqual({ bandBps: 75, classBandBps: 75, thresholdsBps: [] })
    expect(bandOf(cat, 'sUSDS')).toEqual({ bandBps: 25, classBandBps: 25, thresholdsBps: [] })
    // sUSDS and the PT have no member that declares a threshold in the collected catalog.
    expect(bandOf(getOracleCatalog(), 'sUSDS').bandBps).toBe(DEFAULT_BANDS_BPS.stable)
    expect(bandOf(getOracleCatalog(), 'PT-srUSDe-22OCT2026').bandBps).toBe(
      DEFAULT_BANDS_BPS.fixed_income,
    )
  })

  it('counts only consensus members (verified unless includeUnverified); an override is the floor', () => {
    const cat = catalogOf(
      ['USDe'],
      [
        entry({ id: 'm.a', asset: 'USDe', dev: 20 }),
        entry({ id: 'm.b', asset: 'USDe', provider: 'redstone', dev: 20 }),
        entry({ id: 'alt', asset: 'USDe', role: 'alternate', dev: 500 }),
        entry({ id: 'basis', asset: 'USDe', role: 'basis', cls: 'exchange_rate', dev: 500 }),
        {
          ...entry({ id: 'unv', asset: 'USDe', provider: 'pyth', dev: 300 }),
          status: 'unverified',
        },
      ],
    )
    expect(bandOf(cat, 'USDe').bandBps).toBe(40)
    expect(bandOf(cat, 'USDe', { includeUnverified: true }).bandBps).toBe(320)
    expect(bandOf(cat, 'USDe', { bands: { byAsset: { USDe: 100 } } })).toEqual({
      bandBps: 100,
      classBandBps: 100,
      thresholdsBps: [20, 20],
    })
  })

  it('colouring, the consensus test and the history replay all use the effective band', () => {
    const cat = catalogOf(
      ['USDe'],
      [
        entry({ id: 'cl', asset: 'USDe', hb: 86_400, dev: 50 }),
        entry({ id: 'rs', asset: 'USDe', provider: 'redstone', hb: 86_400, dev: 20 }),
        entry({ id: 'ch', asset: 'USDe', provider: 'chronicle', hb: 86_400, dev: null }),
      ],
    )
    // Snapshot: the board, every card and the consensus test carry 70, not 25.
    const board = evaluateReadings(cat, [read('cl', 0.994), read('rs', 1), read('ch', 1)], NOW)
    const a = board.assets[0]
    expect(a.band).toEqual({ bandBps: 70, classBandBps: 25, thresholdsBps: [50, 20] })
    expect(a.bandBps).toBe(70)
    expect(a.cards.every((c) => c.bandBps === 70)).toBe(true)
    expect(a.cards.find((c) => c.id === 'cl')?.colour).toBe('green') // −60 bps
    // History: −60 bps green, −80 bps red; a two-member hour 70 bps apart keeps a consensus.
    const T = 2_000_000
    const ev = (id: string, points: [number, number][]): EntryHistory => ({
      id,
      source: 'chainlink_rounds',
      from: T,
      to: T + 3 * 3600,
      points,
    })
    const histories = new Map<string, EntryHistory>([
      [
        'cl',
        ev('cl', [
          [T, 0.994],
          [T + 3600, 0.992],
          [T + 7200, 0.9965],
        ]),
      ],
      [
        'rs',
        ev('rs', [
          [T, 1],
          [T + 7200, 1.0035],
        ]),
      ],
      [
        'ch',
        ev('ch', [
          [T, 1],
          [T + 3600, 1],
        ]),
      ],
    ])
    const s = evaluateHistory(cat, histories, [T + 60, T + 3660])
    expect(s.entries.cl.deviationBps[0]).toBeCloseTo(-60, 6)
    expect(s.entries.cl.colour).toEqual(['green', 'red'])
    // Without Chronicle, Chainlink and RedStone alone sit 70 bps apart: still a consensus.
    const pair = catalogOf(
      ['USDe'],
      cat.entries.filter((e) => e.id !== 'ch'),
    )
    const two = evaluateHistory(pair, histories, [T + 7260])
    expect(two.consensus.USDe[0]).toBeCloseTo(1, 12)
    expect(two.entries.cl.colour).toEqual(['green'])
    expect(two.entries.rs.colour).toEqual(['green'])
  })
})

// ---- review fixes: history replays the snapshot's staleness -----------------------------

describe('history staleness parity', () => {
  const members = () => [
    entry({ id: 'x.a', asset: 'X' }),
    entry({ id: 'x.b', asset: 'X', provider: 'redstone' }),
  ]
  const ev = (id: string, t: number): EntryHistory => ({
    id,
    source: 'events',
    from: t - 3600,
    to: t,
    points: [[t - 60, 100]],
  })

  it('a sampled view keeps its recorded leg ages: stale in history exactly as in the snapshot', () => {
    const leg = ADDR(777)
    const view = entry({
      id: 'x.view',
      asset: 'X',
      provider: 'morpho',
      hb: 86_400,
      updateModel: 'on_read_view',
      role: 'alternate',
      components: [{ role: 'BASE_FEED_1', address: leg, label: '', heartbeatSeconds: 3600 }],
    })
    const cat = catalogOf(['X'], [...members(), view])
    const t = NOW
    const histories = new Map<string, EntryHistory>([
      ['x.a', ev('x.a', t)],
      ['x.b', ev('x.b', t)],
      [
        'x.view',
        {
          id: 'x.view',
          source: 'archive_sampling',
          stepSeconds: 3600,
          from: t - 3600,
          to: t,
          components: [{ role: 'BASE_FEED_1', address: leg }],
          points: [[t, 100, null, [t - 200_000]]],
        },
      ],
    ])
    const replay = evaluateHistory(cat, histories, [t])
    expect(replay.entries['x.view'].colour).toEqual(['stale'])
    const snap = evaluateReadings(
      cat,
      [
        read('x.a', 100),
        read('x.b', 100),
        {
          id: 'x.view',
          price: 100,
          updatedAt: null,
          components: [{ role: 'BASE_FEED_1', address: leg, updatedAt: t - 200_000 }],
        },
      ],
      t,
    )
    expect(snap.assets[0].cards.find((c) => c.id === 'x.view')?.colour).toBe('stale')
    expect(readingAt(histories.get('x.view'), t)?.components).toEqual([
      { role: 'BASE_FEED_1', address: leg, updatedAt: t - 200_000 },
    ])
  })

  it('a sampled view whose leg is a catalog entry inherits that entry’s replayed age', () => {
    const feed = entry({ id: 'y.feed', asset: 'Y', hb: 3600, role: 'alternate' })
    const view = entry({
      id: 'x.view2',
      asset: 'X',
      provider: 'morpho',
      hb: 86_400,
      updateModel: 'on_read_view',
      role: 'alternate',
      components: [{ role: 'BASE_FEED_1', address: feed.address, label: '', ref: 'y.feed' }],
    })
    const cat = catalogOf(['X', 'Y'], [...members(), feed, view])
    const t = NOW
    const histories = new Map<string, EntryHistory>([
      ['x.a', ev('x.a', t)],
      ['x.b', ev('x.b', t)],
      [
        'y.feed',
        { id: 'y.feed', source: 'events', from: t - 30_000, to: t, points: [[t - 20_000, 1]] },
      ],
      [
        'x.view2',
        {
          id: 'x.view2',
          source: 'archive_sampling',
          stepSeconds: 3600,
          from: t,
          to: t,
          points: [[t, 100]],
        },
      ],
    ])
    expect(evaluateHistory(cat, histories, [t]).entries['x.view2'].colour).toEqual(['stale'])
  })
})

// ---- review fixes: a change survives an unreadable snapshot -----------------------------

describe('change series', () => {
  const A = '0xAAAA000000000000000000000000000000000001'
  const B = '0xBBBB000000000000000000000000000000000002'
  const snapOf = (block: number, aggregator: string | null): OracleSnapshot => ({
    version: 1,
    chainId: 1,
    block,
    ts: block * 12,
    catalogGeneratedAt: 'test',
    entries: [{ id: 'feed', price: 1, updatedAt: null, params: { aggregator } }],
  })

  it('carries the last read value over an unreadable snapshot: A → unreadable → B is one change', () => {
    const ch = detectChangeSeries([snapOf(3, B), snapOf(1, A), snapOf(2, null)])
    expect(ch).toHaveLength(1)
    expect(ch[0]).toMatchObject({
      entryId: 'feed',
      param: 'aggregator',
      kind: 'aggregator',
      from: A,
      to: B,
      fromBlock: 1,
      toBlock: 3,
      fromTs: 12,
      toTs: 36,
    })
    // An unreadable value is still never a change on its own.
    expect(detectChangeSeries([snapOf(1, A), snapOf(2, null), snapOf(3, A)])).toEqual([])
  })
})

// ---- invariants over the collected history ----------------------------------------------

const DATA = join(process.cwd(), 'data', 'oracle-registry')

describe.skipIf(!existsSync(join(DATA, 'history', 'index.json')))(
  'collected history invariants',
  () => {
    const catalog = getOracleCatalog()
    const index = JSON.parse(readFileSync(join(DATA, 'history', 'index.json'), 'utf8')) as {
      window: { endBlock: number }
    }
    const end = readdirSync(join(DATA, 'snapshots'))
      .map((f) => JSON.parse(readFileSync(join(DATA, 'snapshots', f), 'utf8')) as OracleSnapshot)
      .find((s) => s.block === index.window.endBlock)

    it('dates Chronicle updates by the poke’s block (what readWithAge returns), not the signed age', () => {
      expect(end, 'snapshot at the window end').toBeDefined()
      let checked = 0
      for (const e of catalog.entries.filter((x) => x.provider === 'chronicle')) {
        const h = JSON.parse(
          readFileSync(join(DATA, 'history', `${e.id}.json`), 'utf8'),
        ) as EntryHistory
        const r = end?.entries.find((x) => x.id === e.id)
        if (h.source !== 'events' || !r?.updatedAt || r.updatedAt <= h.from) continue
        const last = h.points[h.points.length - 1]
        expect(last[0], e.id).toBe(r.updatedAt)
        checked++
      }
      expect(checked).toBeGreaterThan(0)
    })

    it('records leg ages for every sampled view that ages by its legs (history = snapshot rules)', () => {
      const missing: string[] = []
      for (const r of end?.entries ?? []) {
        if (!r.components?.length) continue
        const path = join(DATA, 'history', `${r.id}.json`)
        if (!existsSync(path)) continue
        const h = JSON.parse(readFileSync(path, 'utf8')) as EntryHistory
        if (h.source !== 'archive_sampling') continue
        const recorded = new Set((h.components ?? []).map((c) => c.address.toLowerCase()))
        for (const c of r.components)
          if (!recorded.has(c.address.toLowerCase())) missing.push(`${r.id}/${c.role}`)
      }
      expect(missing).toEqual([])
    })
  },
)
