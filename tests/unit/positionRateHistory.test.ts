import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ASSETS, buildSeries, parseCsv } from '../../scripts/position/build-rate-history.mjs'
import {
  RATE_HISTORY,
  assertRateHistoryTable,
  findRateHistory,
  parseRateHistory,
} from '@/lib/position/rateHistory'

const DAY = 86400
const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const dates = ['2026-10-05', '2026-10-06', '2026-10-07']
const target = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000

function fixture() {
  const blocks = dates.map((date, i) => ({
    snapshot: date,
    kind: 'daily',
    block: String(200 + i),
    block_ts: String(target(date) - 13),
    T: String(target(date)),
    next_ts: String(target(date) + 1),
    proof: 'ok',
  }))
  const identities = Object.fromEntries(
    Object.entries(ASSETS).map(([, asset]) => [
      asset.key,
      {
        pool,
        asset: asset.token,
        aToken: asset.aToken,
        variableDebtToken: asset.debtToken,
      },
    ]),
  )
  const rows = Object.entries(ASSETS).flatMap(([symbol, asset]) =>
    dates.map((date, i) => ({
      snapshot: date,
      reserve: symbol,
      block: String(200 + i),
      block_ts: String(target(date) - 13),
      listed: '1',
      rd_status: 'ok',
      aToken_matches: '1',
      aToken_rd: asset.aToken,
      variableDebtToken: asset.debtToken,
      strategy: '0x1111111111111111111111111111111111111111',
      RF_bps: '1000',
      optimal: '900000000000000000000000000',
      base: '0',
      slope1: '40000000000000000000000000',
      slope2: '100000000000000000000000000',
      variableBorrowRate_ray: '40000000000000000000000000',
      liquidityRate_ray: '30000000000000000000000000',
    })),
  )
  return { blocks, identities, rows }
}

describe('bounded measured position rate history', () => {
  it('ships four bounded daily series with pinned sources, excluding all private flows and training data', () => {
    expect(() => assertRateHistoryTable(RATE_HISTORY)).not.toThrow()
    expect(RATE_HISTORY.series).toHaveLength(4)
    expect(RATE_HISTORY.source.sha256['depositor-balances/reserve-state.csv']).toBe(
      '430532cd3cef4e6f6413b77279940a21fe9cfa7d8e381f49913e8bf56f3a4478',
    )
    expect(RATE_HISTORY.source.sha256['depositor-balances/blocks.csv']).toBe(
      'c59020cf9c734416936e75de7182ab4aa116625b0bd7727048fe25cd883e313e',
    )
    expect(
      Object.keys(RATE_HISTORY.source.sha256).some((path) =>
        /validation|flows|balances-/.test(path),
      ),
    ).toBe(false)
    expect(
      readFileSync(new URL('../../lib/position/rateHistory.generated.json', import.meta.url))
        .byteLength,
    ).toBeLessThan(150_000)
    for (const series of RATE_HISTORY.series) {
      expect(series.points).toHaveLength(90)
      expect(series.points[0].date).toBe('2026-07-10')
      expect(series.points.at(-1)?.date).toBe('2026-10-07')
      expect(series.points.at(-1)?.observedAt).toBe(1791331199)
      expect(series.points.every((point) => point.observedAt !== target(point.date))).toBe(true)
    }
  })

  it('requires every identity field and the correct side; case of addresses is harmless', () => {
    const series = RATE_HISTORY.series[0]
    expect(findRateHistory(RATE_HISTORY, series.identity, 'borrow')).toBe(series)
    expect(
      findRateHistory(
        RATE_HISTORY,
        { ...series.identity, tokenAddress: series.identity.tokenAddress.toUpperCase() },
        'borrow',
      ),
    ).toBe(series)
    for (const changed of [
      { chainId: 10 },
      { protocol: 'spark' },
      { venueAddress: '0x1111111111111111111111111111111111111111' },
      { marketId: ASSETS.USDT.token },
      { tokenAddress: ASSETS.USDT.token },
    ])
      expect(findRateHistory(RATE_HISTORY, { ...series.identity, ...changed }, 'borrow')).toBeNull()
    expect(findRateHistory(RATE_HISTORY, series.identity, 'supply')?.side).toBe('supply')
    expect(
      RATE_HISTORY.series.every(
        (s) => s.componentScope === (s.side === 'borrow' ? 'variable-debt-only' : 'all-supply'),
      ),
    ).toBe(true)
    expect(
      RATE_HISTORY.series
        .filter((s) => s.side === 'supply')
        .every((s) => s.feeBasis === 'protocol-fees-already-deducted'),
    ).toBe(true)
  })

  it('converts rays to APR fractions and retains actual proved block times', () => {
    const { rows, blocks, identities } = fixture()
    const first = buildSeries(rows, blocks, identities)[0]
    expect(first.points).toHaveLength(90)
    expect(first.points.slice(-3).map((p) => p.apr)).toEqual([0.04, 0.04, 0.04])
    expect(first.points.slice(-3).map((p) => p.observedAt)).toEqual(
      dates.map((date) => target(date) - 13),
    )
    expect(first.points[0]).toMatchObject({
      quality: 'missing',
      apr: null,
      observedAt: null,
      block: null,
    })
  })

  it('retains gaps and breaks an IRM regime seam without filling zero or carrying rates', () => {
    const { rows, blocks, identities } = fixture()
    rows.find((r) => r.reserve === 'USDC' && r.snapshot === dates[1])!.slope1 =
      '50000000000000000000000000'
    rows.find((r) => r.reserve === 'USDC' && r.snapshot === dates[2])!.slope1 =
      '50000000000000000000000000'
    const series = buildSeries(
      rows.filter((r) => !(r.reserve === 'USDT' && r.snapshot === dates[1])),
      blocks,
      identities,
    )
    expect(series[0].points.slice(-3).map((p) => p.apr)).toEqual([0.04, null, 0.04])
    expect(series[0].points.at(-2)?.quality).toBe('regime-change')
    expect(series[2].points.at(-2)).toMatchObject({
      quality: 'missing',
      apr: null,
      observedAt: null,
    })
    expect(series[2].points.at(-1)?.apr).toBe(0.04)
  })

  it('rejects a nominal timestamp substituted for an actual block observation', () => {
    const { rows, blocks, identities } = fixture()
    rows[0].block_ts = String(target(rows[0].snapshot))
    expect(() => buildSeries(rows, blocks, identities)).toThrow('timestamp mismatch')
    const table = structuredClone(RATE_HISTORY)
    table.series[0].points[0].observedAt = target(table.series[0].points[0].date)
    expect(() => parseRateHistory(table)).toThrow('actual observation time')
  })

  it('rejects invalid block proofs, duplicate rows and unverified venue/token identities', () => {
    const { rows, blocks, identities } = fixture()
    blocks[0].proof = 'fail'
    expect(() => buildSeries(rows, blocks, identities)).toThrow('block proof')
    blocks[0].proof = 'ok'
    expect(() => buildSeries([...rows, rows[0]], blocks, identities)).toThrow('duplicate reserve')
    identities['aave-core-usdc'].pool = '0x1111111111111111111111111111111111111111'
    expect(() => buildSeries(rows, blocks, identities)).toThrow('unverified identity')
  })

  it('does not admit missing or mismatched source reads as zero-rate observations', () => {
    const { rows, blocks, identities } = fixture()
    rows[0].liquidityRate_ray = ''
    rows[1].aToken_matches = '0'
    const series = buildSeries(rows, blocks, identities)
    expect(series[1].points.at(-3)).toMatchObject({ quality: 'missing', apr: null })
    expect(series[0].points.at(-2)).toMatchObject({ quality: 'missing', apr: null })
  })

  it('checks gaps, regime boundaries, conventions and bounded dates at import', () => {
    const mutate = (change: (table: typeof RATE_HISTORY) => void, message: string) => {
      const table = structuredClone(RATE_HISTORY)
      change(table)
      expect(() => parseRateHistory(table)).toThrow(message)
    }
    mutate((t) => {
      t.series[0].points.find((p) => p.quality === 'regime-change')!.apr = 0
    }, 'gap must remain null')
    mutate((t) => {
      const seam = t.series[0].points.find((p) => p.quality === 'regime-change')!
      seam.quality = 'observed'
      seam.apr = 0.04
      seam.missingReason = null
    }, 'unbroken regime boundary')
    mutate((t) => {
      t.series[0].points.pop()
    }, 'bounded daily slots')
    mutate((t) => {
      t.series[0].points[0].apr = Number.NaN
    }, 'observed point')
    mutate((t) => {
      t.series[0].feeBasis = 'protocol-fees-already-deducted'
    }, 'component/fee basis')
    mutate((t) => {
      t.series[0].points[1].date = t.series[0].points[0].date
    }, 'daily calendar grid')
    expect(DAY).toBe(target(dates[1]) - target(dates[0]))
  })

  it('parses source CSV quotes rather than splitting blindly on commas', () => {
    expect(parseCsv('date,note\n2026-10-07,"a,b and ""quoted"""\n')).toEqual([
      { date: '2026-10-07', note: 'a,b and "quoted"' },
    ])
    expect(() => parseCsv('a,a\n1,2\n')).toThrow('CSV header')
  })
})
