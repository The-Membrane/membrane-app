import { describe, expect, it } from 'vitest'
import {
  aTokenExternalFlowRaw,
  flowDirection,
  modifiedDietz,
} from '../../scripts/lib/strat-returns.mjs'
import { aggregateTrackedReturn, isTrackedReturnStale } from '@/components/Strats/stratsLogic'

const startAt = '2026-09-01T00:00:00.000Z'
const endAt = '2026-09-11T00:00:00.000Z'

describe('account-attributed flows', () => {
  const account = '0x1111111111111111111111111111111111111111'
  const other = '0x2222222222222222222222222222222222222222'
  const zero = '0x0000000000000000000000000000000000000000'
  it('treats mints and inbound transfers as capital in, burns and outbound as capital out', () => {
    expect(flowDirection(account, zero, account)).toBe(1)
    expect(flowDirection(account, other, account)).toBe(1)
    expect(flowDirection(account, account, zero)).toBe(-1)
    expect(flowDirection(account, account, other)).toBe(-1)
  })
  it('does not double count a self-transfer', () => {
    expect(flowDirection(account, account, account)).toBe(0)
  })
  it('strips aToken accrued interest from mint, burn, and interest-only transfer logs', () => {
    expect(aTokenExternalFlowRaw(110n, { kind: 'mint', value: 110n, balanceIncrease: 10n })).toBe(
      100n,
    )
    expect(aTokenExternalFlowRaw(90n, { kind: 'burn', value: 90n, balanceIncrease: 10n })).toBe(
      -100n,
    )
    expect(aTokenExternalFlowRaw(10n, { kind: 'mint', value: 10n, balanceIncrease: 10n })).toBe(0n)
    expect(aTokenExternalFlowRaw(10n, { kind: 'mint', value: 10n, balanceIncrease: 50n })).toBe(
      -40n,
    )
    expect(aTokenExternalFlowRaw(10n, null)).toBeNull()
  })
})

describe('Modified Dietz tracked-venue return', () => {
  it('subtracts a deposit from gains and weights it by time held', () => {
    const result = modifiedDietz({
      startNavUsd: 100,
      endNavUsd: 220,
      startAt,
      endAt,
      flows: [{ at: '2026-09-06T00:00:00.000Z', usd: 100 }],
    })
    expect(result).toEqual({
      pnlUsd: 20,
      returnPct: (20 / 150) * 100,
      capitalBaseUsd: 150,
      status: 'complete',
    })
  })
  it('adds withdrawals back to P&L rather than reporting a loss', () => {
    const result = modifiedDietz({
      startNavUsd: 200,
      endNavUsd: 120,
      startAt,
      endAt,
      flows: [{ at: '2026-09-06T00:00:00.000Z', usd: -100 }],
    })
    expect(result).toEqual({
      pnlUsd: 20,
      returnPct: (20 / 150) * 100,
      capitalBaseUsd: 150,
      status: 'complete',
    })
  })
  it('makes an unpriced or out-of-window flow unclaimable', () => {
    expect(
      modifiedDietz({
        startNavUsd: 100,
        endNavUsd: 120,
        startAt,
        endAt,
        flows: [{ at: endAt, usd: NaN }],
      }).status,
    ).toBe('unpriced_flow')
    expect(
      modifiedDietz({
        startNavUsd: 100,
        endNavUsd: 120,
        startAt,
        endAt,
        flows: [{ at: '2026-08-31T00:00:00.000Z', usd: 10 }],
      }).pnlUsd,
    ).toBeNull()
  })
  it('does not fabricate a percent from no capital base', () => {
    const result = modifiedDietz({ startNavUsd: 0, endNavUsd: 0, startAt, endAt, flows: [] })
    expect(result.pnlUsd).toBe(0)
    expect(result.returnPct).toBeNull()
    expect(result.status).toBe('empty')
  })
})

describe('venue-window aggregation', () => {
  const nearEnd = new Date(endAt).getTime() + 60 * 60_000
  const aggregate = (
    rows: Parameters<typeof aggregateTrackedReturn>[0],
    venues: string[],
    nowMs = nearEnd,
  ) => aggregateTrackedReturn(rows, venues, nowMs)
  const row = (venue: string, extras = {}) => ({
    venue,
    start_at: startAt,
    observed_at: endAt,
    block: 10,
    last_complete_block: 10,
    pnl_usd: 20,
    capital_base_usd: 100,
    flow_count: 1,
    unpriced_count: 0,
    status: 'complete',
    ...extras,
  })
  it('sums P&L and bases only over matching complete venue windows', () => {
    const result = aggregate(
      [row('a'), row('b', { pnl_usd: -5, capital_base_usd: 50 })],
      ['a', 'b'],
    )
    expect(result.status).toBe('complete')
    expect(result.pnl_usd).toBe(15)
    expect(result.return_pct).toBe(10)
  })
  it('allows a proven empty venue but not an unsupported held aToken', () => {
    expect(
      aggregate(
        [
          row('vault'),
          row('aave', { status: 'empty', pnl_usd: 0, capital_base_usd: 0, flow_count: 0 }),
        ],
        ['vault', 'aave'],
      ).pnl_usd,
    ).toBe(20)
    expect(
      aggregate(
        [row('vault'), row('aave', { status: 'unsupported_atoken', pnl_usd: null })],
        ['vault', 'aave'],
      ).pnl_usd,
    ).toBeNull()
  })
  it('refuses mismatched, missing, and unpriced venues', () => {
    expect(aggregate([row('a')], ['a', 'b']).status).toBe('collecting')
    expect(aggregate([row('a'), row('b', { block: 9 })], ['a', 'b']).pnl_usd).toBeNull()
    expect(
      aggregate([row('a'), row('b', { status: 'unpriced_flow', pnl_usd: null })], ['a', 'b'])
        .return_pct,
    ).toBeNull()
  })
  it('keeps a completed old reading but labels it stale after two hours', () => {
    const old = new Date(endAt).getTime() + 2 * 60 * 60_000 + 1
    expect(aggregate([row('a')], ['a'], old)).toMatchObject({
      status: 'complete',
      pnl_usd: 20,
      return_pct: 20,
      end_at: endAt,
    })
    expect(isTrackedReturnStale(endAt, old)).toBe(true)
    expect(isTrackedReturnStale(endAt, new Date(endAt).getTime() + 2 * 60 * 60_000)).toBe(false)
  })
  it('keeps the last complete snapshot when a later refresh fails', () => {
    expect(aggregate([row('a', { last_error: 'RPC timeout' })], ['a'])).toMatchObject({
      status: 'complete',
      pnl_usd: 20,
      refresh_failed: true,
    })
  })
  it('still suppresses an incomplete scan or invalid timestamp', () => {
    expect(
      aggregate([row('a', { status: 'unpriced_nav', pnl_usd: null })], ['a']).pnl_usd,
    ).toBeNull()
    expect(aggregate([row('a', { observed_at: 'not-a-date' })], ['a']).pnl_usd).toBeNull()
    expect(
      aggregate(
        [row('a', { observed_at: endAt })],
        ['a'],
        new Date(endAt).getTime() - 5 * 60_000 - 1,
      ).pnl_usd,
    ).toBeNull()
  })
})
