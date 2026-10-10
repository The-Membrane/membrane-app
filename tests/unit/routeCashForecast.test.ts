import { describe, expect, it } from 'vitest'

import { forecastRouteCash } from '@/lib/carry/routeCashForecast'
import { checkedRouteCashSamples } from '@/pages/api/carry/forecast'

const routeKey = 'LINK → VaultV2 [LINK]'
const destination = `0x${'a'.repeat(40)}`
const asset = `0x${'b'.repeat(40)}`
const hash = `0x${'c'.repeat(64)}`

function row(block: number, observedAt: string, receivedAt: string) {
  return {
    route_key: routeKey,
    vault: destination,
    asset,
    asset_decimals: 18,
    cash_raw: '123000000000000000000',
    block,
    block_hash: hash,
    observed_at: observedAt,
    first_local_receipt_at: receivedAt,
    cohort_id: 'cohort',
    seed_sha256: 'seed',
    board_sha256: 'board',
    displayed_routes_sha256: 'display',
    seed_source_sha256: 'source',
  }
}

const expected = {
  routeKey,
  destination,
  asset,
  decimals: 18,
  source: 'vault' as const,
  cohortId: 'cohort',
  seedSha256: 'seed',
  boardSha256: 'board',
  displayedRoutesSha256: 'display',
  seedSourceSha256: 'source',
}

describe('exact route cash forecast evidence', () => {
  it('keeps non-dollar assets in underlying units and abstains before validation', () => {
    const samples = checkedRouteCashSamples(
      [
        row(102, '2026-09-29T02:00:00.000Z', '2026-09-29T02:01:00.000Z'),
        row(101, '2026-09-29T01:00:00.000Z', '2026-09-29T01:01:00.000Z'),
      ],
      expected,
    )
    expect(samples?.map((sample) => sample.cashUnits)).toEqual([123, 123])
    const forecast = forecastRouteCash({
      routeKey,
      destination,
      asset,
      assetSymbol: 'LINK',
      cashKind: 'vault_cash',
      amountUnits: 10,
      horizonHours: 1,
      asOf: '2026-09-29T02:05:00.000Z',
      snapshots: samples!,
    })
    expect(forecast.current?.cashUnits).toBe(123)
    expect(forecast.status).toBe('abstain')
    expect(forecast.reason).toBe('insufficient_fit')
    expect(forecast.projection).toBeNull()
    expect(forecast.assetSymbol).toBe('LINK')
    expect(forecast.holderExecutable).toBe(false)
    expect(forecast.predictiveAlertEligible).toBe(false)
    expect('amountUsd' in forecast).toBe(false)
  })

  it('rejects mismatched identity, provenance, and impossible availability', () => {
    const valid = row(101, '2026-09-29T01:00:00.000Z', '2026-09-29T01:01:00.000Z')
    expect(checkedRouteCashSamples([{ ...valid, asset: destination }], expected)).toBeNull()
    expect(checkedRouteCashSamples([{ ...valid, seed_sha256: 'different' }], expected)).toBeNull()
    expect(
      checkedRouteCashSamples(
        [{ ...valid, first_local_receipt_at: '2026-09-29T00:59:00.000Z' }],
        expected,
      ),
    ).toBeNull()
  })

  it('withholds a known wrapper balance from the cash proxy', () => {
    const samples = checkedRouteCashSamples(
      [row(101, '2026-09-29T01:00:00.000Z', '2026-09-29T01:01:00.000Z')],
      { ...expected, unassessedCash: true },
    )
    expect(samples?.[0]).toMatchObject({ cashUnits: null, coverage: 'unverified' })
  })

  it('abstains on a cash anchor older than two hours even for a long horizon', () => {
    const samples = checkedRouteCashSamples(
      [row(101, '2026-09-29T01:00:00.000Z', '2026-09-29T01:01:00.000Z')],
      expected,
    )!
    const forecast = forecastRouteCash({
      routeKey,
      destination,
      asset,
      assetSymbol: 'LINK',
      cashKind: 'vault_cash',
      amountUnits: 10,
      horizonHours: 24,
      asOf: '2026-09-29T04:00:00.000Z',
      snapshots: samples,
    })
    expect(forecast.status).toBe('abstain')
    expect(forecast.reason).toBe('current_observation_stale')
  })

  it('keeps the validation split fixed as prospective observations arrive', () => {
    const early = checkedRouteCashSamples(
      [row(101, '2026-09-29T01:00:00.000Z', '2026-09-29T01:01:00.000Z')],
      expected,
    )!
    const later = checkedRouteCashSamples(
      [
        row(102, '2026-09-29T02:00:00.000Z', '2026-09-29T02:01:00.000Z'),
        row(101, '2026-09-29T01:00:00.000Z', '2026-09-29T01:01:00.000Z'),
      ],
      expected,
    )!
    const input = {
      routeKey,
      destination,
      asset,
      assetSymbol: 'LINK',
      cashKind: 'vault_cash' as const,
      amountUnits: 10,
      horizonHours: 1,
      asOf: '2026-09-29T02:05:00.000Z',
    }
    expect(forecastRouteCash({ ...input, snapshots: early }).backtest.splitAt).toBe(
      forecastRouteCash({ ...input, snapshots: later }).backtest.splitAt,
    )
  })

  it('can validate hourly questions against mildly drifting hourly receipts', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z')
    const snapshots = Array.from({ length: 200 }, (_, i) => {
      const observed = start + i * 65 * 60_000
      return {
        block: 1000 + i,
        observedAt: new Date(observed).toISOString(),
        firstAvailableAt: new Date(observed + 5 * 60_000).toISOString(),
        sourceId: `block-${i}`,
        coverage: 'complete' as const,
        cashUnits: 100,
      }
    })
    const forecast = forecastRouteCash({
      routeKey,
      destination,
      asset,
      assetSymbol: 'LINK',
      cashKind: 'vault_cash',
      amountUnits: 10,
      horizonHours: 1,
      asOf: snapshots.at(-1)!.firstAvailableAt!,
      snapshots,
    })
    expect(forecast.status, forecast.reason ?? '').toBe('research_projection')
    expect(forecast.projection?.cashUnits).toBe(100)
    expect(forecast.holderExecutable).toBe(false)
  })
})
