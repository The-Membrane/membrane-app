// Oracle registry payload builders (lib/oracleRegistry/view.ts), the file loader
// (lib/oracleRegistry/server.ts) and the two API routes. Synthetic inputs pin the
// downsampling, change-list and degrade rules; one block runs over the collected files in
// data/oracle-registry when they are present.

import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { NextApiRequest, NextApiResponse } from 'next'
import { describe, expect, it } from 'vitest'

import assetHandler from '@/pages/api/oracles/[asset]'
import indexHandler from '@/pages/api/oracles/index'
import type { OracleCatalog, OracleEntry } from '@/lib/oracleRegistry/catalog'
import type { AssetViewResponse, OracleIndexResponse } from '@/lib/oracleRegistry/apiTypes'
import { decodeColours } from '@/lib/oracleRegistry/apiTypes'
import { cacheHeader, getRegistryModel, loadRegistryInputs } from '@/lib/oracleRegistry/server'
import type { EntryHistory, OracleSnapshot } from '@/lib/oracleRegistry/types'
import {
  assetSlug,
  bucketColour,
  bucketRanges,
  buildAssetView,
  buildChanges,
  buildIndex,
  buildModel,
  colourCounts,
  describeDiff,
  describeGovernanceEvent,
  findAssetKey,
  lastInRange,
  MAX_HISTORY_BUCKETS,
  pct1e18,
  summarizeHistory,
  worstOutlier,
  type GovernanceEvent,
  type RegistryInputs,
} from '@/lib/oracleRegistry/view'

// ---- synthetic catalog -----------------------------------------------------------------

const T0 = 1_800_000_000
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`
let seq = 1

function entry(p: {
  id: string
  asset?: string
  role?: OracleEntry['consensus']['role']
  cls?: OracleEntry['class']
}): OracleEntry {
  return {
    id: p.id,
    asset: p.asset ?? 'ETH',
    provider: 'chainlink',
    label: `${p.id} label`,
    address: ADDR(seq++),
    chainId: 1,
    readMethod: 'latestRoundData()',
    decimals: 8,
    quoteUnit: 'USD',
    class: p.cls ?? 'market',
    consensus: { role: p.role ?? 'member', note: 'n' },
    mechanism: {
      source: 's',
      aggregation: 'a',
      updateModel: 'push_deviation_heartbeat',
      heartbeatSeconds: 3600,
      deviationThresholdBps: 50,
      governance: [],
      components: [],
    },
    usedBy: [],
    historySource: 'chainlink_rounds',
    docsUrl: 'https://example.org',
    status: 'verified',
  }
}

const ENTRIES = [
  entry({ id: 'eth.basis', role: 'basis', cls: 'exchange_rate' }),
  entry({ id: 'eth.a' }),
  entry({ id: 'eth.b' }),
  entry({ id: 'eth.alt', role: 'alternate' }),
  entry({ id: 'eth.c' }),
]

const CATALOG: OracleCatalog = {
  version: 1,
  chainId: 1,
  generatedAt: 'test',
  sources: [],
  consensusPolicy: 'median of members',
  stalenessPolicy: 'heartbeat + grace',
  assets: [
    { key: 'BTC', symbol: 'BTC', token: null, tokenDecimals: null, kind: 'reference', sanity: {} },
    { key: 'ETH', symbol: 'ETH', token: null, tokenDecimals: null, kind: 'mvp', sanity: {} },
  ],
  entries: [...ENTRIES, entry({ id: 'btc.a', asset: 'BTC' })],
  excluded: [
    { asset: 'ETH', provider: 'api3', reason: 'out of scope' } as OracleCatalog['excluded'][number],
  ],
}

function snapshot(block: number, ts: number, prices: Record<string, number>): OracleSnapshot {
  return {
    version: 1,
    chainId: 1,
    block,
    ts,
    catalogGeneratedAt: 'test',
    entries: Object.entries(prices).map(([id, price]) => ({ id, price, updatedAt: ts - 60 })),
  }
}

/** Event series: one update every 30 minutes for `hours`, price from fn(i). */
function events(id: string, hours: number, fn: (i: number) => number): EntryHistory {
  const points: [number, number][] = []
  for (let i = 0; i <= hours * 2; i++) points.push([T0 + i * 1800, fn(i)])
  return { id, source: 'events', from: T0, to: T0 + hours * 3600, points }
}

function inputs(p: Partial<RegistryInputs> = {}): RegistryInputs {
  return {
    catalog: CATALOG,
    latest: null,
    snapshots: [],
    histories: new Map(),
    historyIndex: null,
    governance: null,
    ...p,
  }
}

// ---- downsampling -----------------------------------------------------------------------

describe('history downsampling', () => {
  it('covers every sample exactly once in at most the bucket cap', () => {
    for (const n of [1, 239, 240, 241, 720, 721]) {
      const r = bucketRanges(n)
      expect(r.length).toBeLessThanOrEqual(MAX_HISTORY_BUCKETS)
      expect(r[0][0]).toBe(0)
      expect(r[r.length - 1][1]).toBe(n)
      for (let i = 1; i < r.length; i++) expect(r[i][0]).toBe(r[i - 1][1])
    }
    expect(bucketRanges(720)).toHaveLength(240)
    expect(bucketRanges(0)).toEqual([])
  })

  it('never lets a bucket hide a one-sample excursion', () => {
    expect(bucketColour(['green', 'red', 'green'], [1, -80, 2])).toBe('red')
    // Both directions inside one bucket: the larger |deviation| decides.
    expect(bucketColour(['gold', 'red'], [60, -90])).toBe('red')
    expect(bucketColour(['gold', 'red'], [120, -90])).toBe('gold')
    expect(bucketColour(['green', 'stale'], [1, null])).toBe('stale')
    // An excursion outranks a stale hour in the same bucket.
    expect(bucketColour(['stale', 'red', 'stale'], [null, -80, null])).toBe('red')
    expect(bucketColour(['unavailable', 'green'], [null, 3])).toBe('green')
    expect(bucketColour(['unavailable'], [null])).toBe('unavailable')
  })

  it("takes a bucket's value at its own end", () => {
    expect(lastInRange([1, 2, null, 4], [0, 3])).toBe(2)
    expect(lastInRange([1, 2, null, 4], [2, 3])).toBeNull()
    expect(lastInRange([1, Number.NaN], [0, 2])).toBe(1)
  })

  it('summarises out-of-band time and the signed worst deviation on the full grid', () => {
    const s = summarizeHistory(
      ['green', 'red', 'gold', 'stale', 'unavailable'],
      [5, -70, 90, -300, null],
      [10, 20, 30, 40, 50],
      3600,
    )
    // The stale sample's −300 never counts: only evaluable verdicts do.
    expect(s).toEqual({
      total: 5,
      evaluable: 3,
      outOfBand: 2,
      stale: 1,
      worst: { bps: 90, ts: 30 },
      stepSeconds: 3600,
    })
  })
})

// ---- aggregates and change list ---------------------------------------------------------

describe('aggregates', () => {
  it('counts colours and names the worst market outlier, never a basis gap', () => {
    const cards = [
      { id: 'a', colour: 'red' as const, deviationBps: -66, tone: 'outlier' as const, label: 'A' },
      { id: 'b', colour: 'gold' as const, deviationBps: 900, tone: 'basis' as const },
      { id: 'c', colour: 'gold' as const, deviationBps: 70, tone: 'outlier' as const },
      { id: 'd', colour: 'stale' as const, deviationBps: -2000, tone: 'outlier' as const },
    ]
    // The basis card's gold is a structural gap, not "above consensus": counted nowhere, so the
    // tab marks and the filter agree with worstOutlier.
    expect(colourCounts(cards)).toEqual({ green: 0, red: 1, gold: 1, stale: 1, unavailable: 0 })
    expect(worstOutlier(cards)).toEqual({ id: 'c', label: 'c', colour: 'gold', deviationBps: 70 })
    expect(worstOutlier(cards.slice(1, 2))).toBeNull()
    expect(colourCounts(cards.slice(1, 2))).toEqual({
      green: 0,
      red: 0,
      gold: 0,
      stale: 0,
      unavailable: 0,
    })
  })

  it('maps slugs back to catalog keys case-insensitively', () => {
    expect(assetSlug('PT-srUSDe-22OCT2026')).toBe('pt-srusde-22oct2026')
    expect(findAssetKey(CATALOG, 'eth')).toBe('ETH')
    expect(findAssetKey(CATALOG, 'EtH')).toBe('ETH')
    expect(findAssetKey(CATALOG, 'doge')).toBeNull()
  })
})

describe('change list', () => {
  const discount: GovernanceEvent = {
    block: 105,
    ts: T0 + 500,
    tx: '0xabc',
    logIndex: 3,
    emitter: ADDR(999),
    event: 'DiscountRatePerYearUpdated',
    args: {
      oldDiscountRatePerYear: '53100000000000000',
      newDiscountRatePerYear: '37700000000000000',
    },
    entryIds: ['eth.basis'],
  }

  it('words governance logs as parameter changes', () => {
    expect(pct1e18('37700000000000000')).toBe('3.77%')
    expect(describeGovernanceEvent(discount)).toEqual({
      title: 'Discount rate',
      detail: '5.31% → 3.77% per year',
      kind: 'discount',
    })
    const capo = describeGovernanceEvent({
      ...discount,
      event: 'CapParametersUpdated',
      args: {
        maxYearlyRatioGrowthPercent: 880,
        snapshotRatio: '1245600000000000000',
        snapshotTimestamp: 1790000000,
      },
    })
    expect(capo.kind).toBe('cap')
    expect(capo.detail).toBe('max growth 8.8%/yr · snapshot ratio 1.24560 · taken 2026-09-21')
    const toll = describeGovernanceEvent({
      ...discount,
      event: 'TollGranted',
      args: { who: ADDR(7) },
    })
    expect(toll.kind).toBe('access')
    expect(toll.detail).toBe('0x0000…0007 granted read access')
  })

  it('drops a snapshot diff that a governance log already explains, keeps the rest, newest first', () => {
    const a = snapshot(100, T0, { 'eth.a': 1 })
    a.entries[0].params = { discountRatePerYear: '53100000000000000', aggregator: ADDR(1) }
    const b = snapshot(110, T0 + 1000, { 'eth.a': 1 })
    b.entries[0].params = { discountRatePerYear: '37700000000000000', aggregator: ADDR(2) }
    const explained = { ...discount, entryIds: ['eth.a'] }
    const out = buildChanges({ window: { days: 180 }, events: [explained] }, [b, a, b])
    expect(out.map((c) => `${c.origin}:${c.kind}`)).toEqual(['diff:aggregator', 'event:discount'])
    expect(out[0]).toMatchObject({
      origin: 'diff',
      fromBlock: 100,
      block: 110,
      entryIds: ['eth.a'],
      title: 'Aggregator',
      detail: 'aggregator: 0x0000…0001 → 0x0000…0002',
    })
    // A governance log outside the diff's interval explains nothing.
    const late = { ...explained, ts: T0 + 5000 }
    expect(buildChanges({ window: { days: 180 }, events: [late] }, [a, b])).toHaveLength(3)
  })

  it('words entry additions without a parameter arrow', () => {
    const d = describeDiff({
      entryId: 'x',
      origin: 'entry',
      param: 'entry',
      kind: 'entry_added',
      from: undefined,
      to: 'x',
      fromBlock: 1,
      toBlock: 2,
      fromTs: 1,
      toTs: 2,
    })
    expect(d.detail).toBe('first seen in this snapshot')
  })
})

describe('change list: explained diffs and unreadable snapshots', () => {
  const at = (block: number, ts: number, params: Record<string, string | number | null>) => {
    const s = snapshot(block, ts, { 'eth.a': 1 })
    s.entries[0].params = params
    return s
  }
  const gov = (
    event: string,
    args: GovernanceEvent['args'],
    over: Partial<GovernanceEvent> = {},
  ): GovernanceEvent => ({
    block: 105,
    ts: T0 + 500,
    tx: '0xabc',
    logIndex: 1,
    emitter: ADDR(999),
    event,
    args,
    entryIds: ['eth.a'],
    ...over,
  })

  it('lets PriceCapUpdated, BarUpdated and AggregatorConfirmed explain their own diffs', () => {
    const a = at(100, T0, { priceCap: '104000000', bar: 13, aggregator: ADDR(1), phaseId: 6 })
    const b = at(110, T0 + 1000, {
      priceCap: '103000000',
      bar: 14,
      aggregator: ADDR(2),
      phaseId: 7,
    })
    const events = [
      gov('PriceCapUpdated', { priceCap: '103000000' }, { logIndex: 1 }),
      gov('BarUpdated', { caller: ADDR(5), oldBar: 13, newBar: 14 }, { logIndex: 2 }),
      gov('AggregatorConfirmed', { previous: ADDR(1), latest: ADDR(2) }, { logIndex: 3 }),
    ]
    const out = buildChanges({ window: { days: 180 }, events }, [a, b])
    expect(out.map((c) => `${c.origin}:${c.kind}`).sort()).toEqual([
      'event:aggregator',
      'event:cap',
      'event:quorum',
    ])
    expect(out.find((c) => c.kind === 'cap')?.detail).toBe('price cap set to $1.03')
  })

  it('explains a diff by block when the governance event has no timestamp', () => {
    const a = at(100, T0, { discountRatePerYear: '53100000000000000' })
    const b = at(110, T0 + 1000, { discountRatePerYear: '37700000000000000' })
    const noTs = gov(
      'DiscountRatePerYearUpdated',
      { oldDiscountRatePerYear: '53100000000000000', newDiscountRatePerYear: '37700000000000000' },
      { ts: null as unknown as number },
    )
    const out = buildChanges({ window: { days: 180 }, events: [noTs] }, [a, b])
    expect(out.map((c) => `${c.origin}:${c.kind}`)).toEqual(['event:discount'])
    // Outside the diff's block interval it explains nothing.
    const later = { ...noTs, block: 111 }
    expect(buildChanges({ window: { days: 180 }, events: [later] }, [a, b])).toHaveLength(2)
  })

  it('reports a change across an unreadable middle snapshot, dated from the last read', () => {
    const a = at(100, T0, { aggregator: ADDR(1) })
    const mid = at(105, T0 + 500, { aggregator: null })
    const b = at(110, T0 + 1000, { aggregator: ADDR(2) })
    const out = buildChanges(null, [b, mid, a])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      origin: 'diff',
      kind: 'aggregator',
      fromBlock: 100,
      block: 110,
      detail: 'aggregator: 0x0000…0001 → 0x0000…0002',
    })
  })
})

// ---- model + payloads -------------------------------------------------------------------

describe('payloads', () => {
  it('degrades to mechanism-only cards when nothing has been collected', () => {
    const m = buildModel(inputs())
    const idx = buildIndex(m)
    expect(idx.available).toBe(false)
    expect(idx.reason).toBe('no snapshot collected yet')
    expect(idx.snapshot).toBeNull()
    // MVP first, reference assets after.
    expect(idx.assets.map((a) => a.key)).toEqual(['ETH', 'BTC'])
    const v = buildAssetView(m, 'ETH')!
    expect(v.available).toBe(false)
    expect(v.cards).toHaveLength(ENTRIES.length)
    expect(v.cards.every((c) => c.colour === 'unavailable')).toBe(true)
    expect(v.cards[0].mechanism.aggregation).toBe('a')
    expect(v.history).toMatchObject({ available: false, ts: [], consensus: [] })
    expect(v.changes).toEqual([])
    expect(v.excluded).toEqual([{ provider: 'api3', reason: 'out of scope' }])
    expect(buildAssetView(m, 'DOGE')).toBeNull()
  })

  it('builds cards in role order with history aligned to the consensus line', () => {
    const hours = 48
    const histories = new Map<string, EntryHistory>([
      ['eth.a', events('eth.a', hours, () => 2000)],
      ['eth.b', events('eth.b', hours, () => 2002)],
      // Dips 1.5% for one half-hour update at i = 40 (hour 20): outside the effective
      // ±100 bps band (every member declares 50 → 50 + 50), not just the ±50 class band.
      ['eth.c', events('eth.c', hours, (i) => (i === 40 ? 1970 : 2001))],
      ['eth.basis', events('eth.basis', hours, () => 2050)],
    ])
    const latestTs = T0 + hours * 3600
    const latest = snapshot(200, latestTs, {
      'eth.a': 2000,
      'eth.b': 2002,
      'eth.c': 1970,
      'eth.alt': 2001,
      'eth.basis': 2050,
      'btc.a': 80000,
    })
    const m = buildModel(
      inputs({
        latest,
        histories,
        historyIndex: {
          window: { startTs: T0, endTs: latestTs, days: 2, stepSeconds: 3600 },
          entries: [{ id: 'eth.c', source: 'events', points: 97, note: 'held value' }],
        },
      }),
    )
    const v = buildAssetView(m, 'ETH')!
    expect(v.available).toBe(true)
    expect(v.cards.map((c) => c.id)).toEqual(['eth.a', 'eth.b', 'eth.c', 'eth.alt', 'eth.basis'])
    expect(v.consensus.status).toBe('ok')
    expect(v.consensus.price).toBe(2000)
    expect(v.cards.find((c) => c.id === 'eth.c')!.colour).toBe('red')
    // The header's band is the effective band the cards were coloured with.
    // ETH is a major: the stable-only widening (owner 2026-10-05) leaves its class band.
    expect(v.bandBps).toBe(50)
    expect(v.band).toEqual({ bandBps: 50, classBandBps: 50, thresholdsBps: [] })
    expect(v.cards.every((c) => c.bandBps === 50)).toBe(true)

    const n = hours + 1
    expect(v.history.available).toBe(true)
    expect(v.history.ts).toHaveLength(n)
    expect(v.history.consensus).toHaveLength(n)
    expect(v.history.bucketSeconds).toBe(3600)
    const c = v.cards.find((x) => x.id === 'eth.c')!
    expect(c.history!.usd).toHaveLength(n)
    expect(decodeColours(c.history!.colours)).toHaveLength(n)
    expect(c.history!.note).toBe('held value')
    expect(c.history!.summary.outOfBand).toBe(1)
    expect(c.history!.summary.worst!.bps).toBeLessThan(-100)
    expect(decodeColours(c.history!.colours)[20]).toBe('red')
    // No history collected for the alternate → the card says so instead of drawing.
    expect(v.cards.find((x) => x.id === 'eth.alt')!.history).toBeNull()

    const idx = buildIndex(m)
    expect(idx.available).toBe(true)
    const eth = idx.assets.find((a) => a.key === 'ETH')!
    expect(eth.consensus.members).toBe(3)
    expect(eth.bandBps).toBe(50) // major: class band (stable-only widening)
    expect(eth.worst).toMatchObject({ id: 'eth.c', colour: 'red', label: 'eth.c label' })
  })

  it('reads an empty or missing data directory as unavailable, never a throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-registry-'))
    try {
      const empty = loadRegistryInputs(dir, CATALOG)
      expect(empty.latest).toBeNull()
      expect(empty.histories.size).toBe(0)
      mkdirSync(join(dir, 'snapshots'))
      mkdirSync(join(dir, 'history'))
      writeFileSync(join(dir, 'snapshots', 'latest.json'), '{ not json')
      writeFileSync(join(dir, 'history', 'eth.a.json'), JSON.stringify({ id: 'eth.a' }))
      writeFileSync(join(dir, 'changes.json'), JSON.stringify({ events: 'nope' }))
      const bad = loadRegistryInputs(dir, CATALOG)
      expect(bad.latest).toBeNull()
      expect(bad.histories.size).toBe(0)
      expect(bad.governance).toBeNull()
      const m = getRegistryModel(dir)
      expect(buildIndex(m).available).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(loadRegistryInputs(join(tmpdir(), 'no-such-registry-dir'), CATALOG).latest).toBeNull()
  })

  it('caches five minutes at the CDN when data exists, one minute when it does not', () => {
    expect(cacheHeader(true)).toContain('s-maxage=300')
    expect(cacheHeader(false)).toContain('s-maxage=60')
  })
})

// ---- API routes over the collected files -------------------------------------------------

type MockRes = {
  statusCode: number
  headers: Record<string, string>
  body: unknown
}

function call(
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
  method: string,
  query: Record<string, string> = {},
): MockRes {
  const out: MockRes = { statusCode: 200, headers: {}, body: undefined }
  const res = {
    setHeader(k: string, v: string) {
      out.headers[k.toLowerCase()] = v
      return res
    },
    status(code: number) {
      out.statusCode = code
      return res
    },
    json(b: unknown) {
      out.body = b
      return res
    },
  }
  handler({ method, query } as unknown as NextApiRequest, res as unknown as NextApiResponse)
  return out
}

const HAVE_DATA = existsSync(
  join(process.cwd(), 'data', 'oracle-registry', 'snapshots', 'latest.json'),
)

describe('API routes', () => {
  it('rejects anything but GET', () => {
    expect(call(indexHandler, 'POST').statusCode).toBe(405)
    expect(call(assetHandler, 'DELETE', { asset: 'eth' }).statusCode).toBe(405)
  })

  it('404s an unknown asset with the valid slugs', () => {
    const r = call(assetHandler, 'GET', { asset: 'doge' })
    expect(r.statusCode).toBe(404)
    expect((r.body as { assets: string[] }).assets).toContain('eth')
  })

  it.skipIf(!HAVE_DATA)(
    'serves every asset from the collected files with a 5-minute CDN cache',
    () => {
      const idx = call(indexHandler, 'GET')
      expect(idx.statusCode).toBe(200)
      expect(idx.headers['cache-control']).toContain('s-maxage=300')
      const body = idx.body as OracleIndexResponse
      expect(body.available).toBe(true)
      expect(body.assets.length).toBeGreaterThanOrEqual(9)
      for (const a of body.assets) {
        const r = call(assetHandler, 'GET', { asset: a.slug })
        expect(r.statusCode).toBe(200)
        const v = r.body as AssetViewResponse
        expect(v.cards).toHaveLength(a.cards)
        // Every series lines up with the asset's consensus line.
        for (const c of v.cards) {
          if (!c.history) continue
          expect(c.history.usd).toHaveLength(v.history.ts.length)
          expect(c.history.colours).toHaveLength(v.history.ts.length)
        }
        expect(v.history.ts.length).toBeLessThanOrEqual(MAX_HISTORY_BUCKETS)
        // Basis cards never vote; members come first.
        expect(v.cards.filter((c) => c.role === 'basis').every((c) => !c.countedInConsensus)).toBe(
          true,
        )
        const roles = v.cards.map((c) => c.role)
        expect(roles.indexOf('member')).toBe(roles.includes('member') ? 0 : -1)
        // Payloads stay small enough to inline in the server-rendered page.
        expect(JSON.stringify(v).length).toBeLessThan(150_000)
      }
    },
  )
})
