import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { appendGapRun, type GapObservation } from '@/lib/curatorFeed/oracleGap'
import { ORACLE_GAP_FILE, SCHEMA, type OracleGapFile } from '@/lib/curatorFeed/store'
import record from '@/lib/curatorFeed/i3Record.generated.json'

// GET /api/curator-feed?view=oracle-gap against a synthetic store: the route reads
// lib/curatorFeed/paths liveDir()/seedDir(), mocked to two temp directories.

const dirs = vi.hoisted(() => {
  // Runs before the imports: plain strings only.
  const root = `${process.env.TMPDIR || '/tmp'}/oracle-gap-api-${process.pid}-${Date.now()}`
  return { live: `${root}/live`, seed: `${root}/seed`, root }
})
vi.mock('@/lib/curatorFeed/paths', () => ({
  liveDir: () => dirs.live,
  seedDir: () => dirs.seed,
  datasetsRoot: () => dirs.root,
}))

import handler from '@/pages/api/curator-feed'

const H = 3600
const NOW = 1_790_000_000
const A = '0x' + 'a'.repeat(64) // fired: 30 h at +3 %
const B = '0x' + 'b'.repeat(64) // building: 10 h at +2.5 %
const Cm = '0x' + 'c'.repeat(64) // below: oracle under market
const D = '0x' + 'd'.repeat(64) // held, never observed
const E = '0x' + 'e'.repeat(64) // fired, no curated vault holds it
const F = '0x' + 'f'.repeat(64) // held, priced only at DefiLlama confidence 0.5
const tok = (n: string) => '0x' + n.repeat(40)
const VAULT = tok('1')

const feed = {
  meta: { schema: SCHEMA, collectedAt: new Date(NOW * 1000).toISOString() },
  entities: {
    tokens: {
      [tok('2')]: { symbol: 'USDC', decimals: 6 },
      [tok('3')]: { symbol: 'AZND', decimals: 18 },
      [tok('4')]: { symbol: 'wstETH', decimals: 18 },
      [tok('5')]: { symbol: 'XYZ', decimals: 18 },
      [tok('6')]: { symbol: 'NODATA', decimals: 18 },
      [tok('7')]: { symbol: 'DUST', decimals: 18 },
      [tok('8')]: { symbol: 'LOWCONF', decimals: 18 },
    },
    markets: Object.fromEntries(
      [
        [A, tok('3')],
        [B, tok('4')],
        [Cm, tok('5')],
        [D, tok('6')],
        [E, tok('7')],
        [F, tok('8')],
      ].map(([id, coll], i) => [
        id,
        {
          loan: tok('2'),
          collateral: coll,
          oracle: tok(String(7 + i)),
          irm: tok('e'),
          lltv: '915000000000000000',
        },
      ]),
    ),
    vaults: {
      [VAULT]: { protocol: 'morpho-v1', name: 'Test USDC', asset: tok('2'), curatorKey: 'k' },
    },
    curators: { k: { name: 'Curator K', source: 'morpho-api' } },
    strategies: {},
    aaveMarkets: {},
    v2Ids: {},
  },
  actions: [],
  attribution: [],
  spikes: [],
}
const exposure = {
  schema: SCHEMA,
  block: 100,
  ts: NOW - 2 * H,
  vaults: [
    {
      vault: VAULT,
      protocol: 'morpho-v1',
      totalAssets: '1',
      allocations: [A, B, Cm, D, F].map((t, i) => ({
        target: t,
        scope: 'market',
        collateral: [],
        assets: '1',
        usd: i < 4 ? 1_000_000 * (4 - i) : 500_000,
        share: 0.2,
      })),
    },
  ],
}

/** 30 hourly runs ending one hour before NOW. */
function series(): OracleGapFile {
  let f: OracleGapFile | null = null
  for (let i = 0; i < 30; i++) {
    const ts = NOW - (30 - i) * H
    const o = (gap: number): GapObservation => ({
      ts,
      gap,
      oracleUsd: 1,
      marketUsd: Number((1 / (1 + gap)).toPrecision(6)),
      marketConfidence: 0.99,
    })
    const rows: [string, GapObservation][] = [
      [A, o(0.03)],
      [Cm, o(-0.05)],
      [E, o(0.5)],
      [F, { ...o(0.4), gap: null, rawGap: 0.4, marketConfidence: 0.5 }],
    ]
    if (i >= 20) rows.push([B, o(0.025)])
    f = appendGapRun(f, { ts, block: 1000 + i }, rows).file
  }
  return f!
}

const call = (query: Record<string, string>) => {
  const out: { status: number; body: any; headers: Record<string, string> } = {
    status: 0,
    body: null,
    headers: {},
  }
  const res = {
    status(n: number) {
      out.status = n
      return res
    },
    json(b: unknown) {
      out.body = b
    },
    setHeader(k: string, v: string) {
      out.headers[k] = v
    },
  }
  handler({ method: 'GET', query } as any, res as any)
  return out
}

const write = (name: string, body: unknown) => {
  mkdirSync(dirs.live, { recursive: true })
  writeFileSync(join(dirs.live, name), typeof body === 'string' ? body : JSON.stringify(body))
}

describe('GET /api/curator-feed?view=oracle-gap', () => {
  beforeEach(() => {
    rmSync(dirs.live, { recursive: true, force: true })
    rmSync(dirs.seed, { recursive: true, force: true })
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
  })
  afterAll(() => {
    vi.useRealTimers()
    rmSync(dirs.root, { recursive: true, force: true })
  })

  it('503 with no dataset on disk, as every view', () => {
    const r = call({ view: 'oracle-gap' })
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/dataset unavailable \(ENOENT\)/)
  })

  it('not measured yet: 200, measured false, the record, no markets', () => {
    write('feed.json', feed)
    write('exposure.json', exposure)
    const r = call({ view: 'oracle-gap' })
    expect(r.status).toBe(200)
    expect(r.headers['Cache-Control']).toMatch(/s-maxage=300/)
    expect(r.body.meta).toMatchObject({ measured: false, runs: 0, stale: false })
    expect(r.body.markets).toEqual([])
    expect(r.body.record.source.sha256).toBe(record.source.sha256)
    expect(r.body.constants).toEqual({ gap: 0.02, persistenceHours: 24, persistenceDailyPoints: 2 })
  })

  it('fired first, then building, each by $ exposed; low confidence and never observed are unobserved', () => {
    write('feed.json', feed)
    write('exposure.json', exposure)
    write(ORACLE_GAP_FILE, series())
    const r = call({ view: 'oracle-gap' })
    expect(r.status).toBe(200)
    const b = r.body
    expect(b.meta).toMatchObject({ measured: true, runs: 30, lastRunTs: NOW - H, stale: false })
    expect(b.counts).toEqual({ fired: 2, building: 1, below: 1, stale: 0, unobserved: 2 })
    expect(b.curatedUsd).toEqual({
      fired: 4_000_000,
      building: 3_000_000,
      below: 2_000_000,
      stale: 0,
      unobserved: 1_500_000,
    })
    expect(b.exposed).toEqual({ fired: 1, building: 1, below: 1, stale: 0, unobserved: 2 })
    expect(b.exposedMinUsd).toBe(1)
    expect(
      b.markets.map((m: any) => [m.market, m.i3.state, m.i3.hoursAboveConsecutive, m.curatedUsd]),
    ).toEqual([
      [A, 'fired', 30, 4_000_000],
      [E, 'fired', 30, undefined],
      [B, 'building', 10, 3_000_000],
      [Cm, 'below', 0, 2_000_000],
      [D, 'unobserved', 0, 1_000_000],
      [F, 'unobserved', 0, 500_000],
    ])
    const f = b.markets[5]
    expect(f.latest).toBeUndefined()
    expect(f.lastRaw).toMatchObject({ rawGap: 0.4, marketConfidence: 0.5, ts: NOW - H })
    expect(f.series.every((p: any) => p.gap === null)).toBe(true)
    expect(b.markets[0].locked).toBe(false)
    const a = b.markets[0]
    expect(a).toMatchObject({
      claim: 'possible-leading-signal',
      collateralSymbol: 'AZND',
      loanSymbol: 'USDC',
      curatedUsd: 4_000_000,
      latest: { ts: NOW - H, oracleUsd: 1, marketConfidence: 0.99 },
    })
    expect(a.i3.firedSince).toBe(NOW - 7 * H) // the 24th of 30 hourly points
    expect(a.series.length).toBe(30) // fewer than 2 × 24 points so far
    expect(a.vaults[0]).toMatchObject({ vaultName: 'Test USDC', curatorName: 'Curator K' })
    expect(b.markets[4].series).toEqual([])
    // Filters and limit.
    expect(
      call({ view: 'oracle-gap', collateral: 'wstETH' }).body.markets.map((m: any) => m.market),
    ).toEqual([B])
    const one = call({ view: 'oracle-gap', limit: '1' }).body
    expect(one.markets.length).toBe(1)
    expect(one.total).toBe(6)
    expect(call({ view: 'oracle-gap', market: 'nope' }).status).toBe(400)
  })

  it('stale once the newest run is more than 3 h old', () => {
    write('feed.json', feed)
    write('exposure.json', exposure)
    write(ORACLE_GAP_FILE, series())
    vi.setSystemTime((NOW + 3 * H) * 1000)
    const b = call({ view: 'oracle-gap' }).body
    expect(b.meta.stale).toBe(true)
    expect(b.counts.stale).toBe(4) // F was never observed (low confidence only): unobserved
    expect(b.counts.fired).toBe(0)
    // Ranked as of their last point: the formerly fired market with $ exposed leads.
    expect(b.markets[0].market).toBe(A)
  })

  it('CURATOR_FEED_NOW pins the request clock outside production', () => {
    write('feed.json', feed)
    write('exposure.json', exposure)
    write(ORACLE_GAP_FILE, series())
    process.env.CURATOR_FEED_NOW = String(NOW + 3 * H)
    try {
      const b = call({ view: 'oracle-gap' }).body
      expect(b.meta.now).toBe(NOW + 3 * H)
      expect(b.meta.stale).toBe(true)
    } finally {
      delete process.env.CURATOR_FEED_NOW
    }
    expect(call({ view: 'oracle-gap' }).body.meta.now).toBe(NOW)
  })

  it('an unreadable series is a 503, never cached', () => {
    write('feed.json', feed)
    write('exposure.json', exposure)
    write(ORACLE_GAP_FILE, '{"schema": 99}')
    const r = call({ view: 'oracle-gap' })
    expect(r.status).toBe(503)
    expect(r.headers['Cache-Control']).toBe('no-store')
    expect(r.body.error).toMatch(/oracle gap series unavailable/)
  })
})
