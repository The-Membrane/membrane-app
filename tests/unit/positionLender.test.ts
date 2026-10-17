// The lending block's pure logic (lib/position/lender.ts).

import { describe, expect, it } from 'vitest'

import { REWARDS_MARK, aprLine, lenderView, parseReport, reportQuery } from '@/lib/position/lender'
import type { ProtocolPosition } from '@/lib/position-sim/types'

const market = {
  symbol: 'USDC',
  priceUsd: 1,
  totalSupply: 1_000_000,
  totalBorrow: 900_000,
  liquidity: 100_000,
  utilization: 0.9,
  borrowApr: 0.05,
  fee: 0,
  supplyApr: 0.045,
  block: 21_000_000,
}

const lender = (amount: number, m = market): ProtocolPosition => ({
  protocol: 'morpho-blue',
  label: 'Morpho · sNUSD/USDC 91.5%',
  marketId: '0xabc',
  collateral: [],
  debt: [],
  totalCollateralUsd: 0,
  totalDebtUsd: 0,
  ltv: 0,
  liquidationLtv: 0.915,
  healthFactor: Number.POSITIVE_INFINITY,
  provenance: { kind: 'onchain', label: 'test', at: 0 },
  status: 'supply-only',
  supplied: [{ symbol: 'USDC', address: '0x1', decimals: 6, amount, priceUsd: 1, valueUsd: amount }],
  lendMarket: m,
})

const body = (over: Record<string, unknown> = {}) => ({
  data: {
    marketById: {
      state: { rewards: [{ asset: { symbol: 'FXN' }, supplyApr: 0.0461 }, { asset: { symbol: 'X' }, supplyApr: 0 }] },
      warnings: [
        { type: 'bad_debt_unrealized', level: 'RED' },
        { type: 'not_whitelisted', level: 'YELLOW' },
      ],
      badDebt: { usd: 3544.8 },
      realizedBadDebt: { usd: 0 },
      historicalState: { liquidityAssetsUsd: [{ x: 200, y: 5 }, { x: 100, y: 4 }, { x: 300, y: null }] },
      ...over,
    },
  },
})

describe('parseReport', () => {
  it('keeps paying rewards, sorts history and drops null points', () => {
    const r = parseReport(body(), 1)
    expect(r.rewards).toEqual([{ symbol: 'FXN', apr: 0.0461 }])
    expect(r.history).toEqual([
      { t: 100, usd: 4 },
      { t: 200, usd: 5 },
    ])
    expect(r.badDebtUsd).toBe(3544.8)
    expect(r.realizedBadDebtUsd).toBe(0)
  })
  it('throws on a GraphQL error or a missing market, never returns an empty report', () => {
    expect(() => parseReport({ errors: [{ message: 'boom' }] }, 1)).toThrow(/boom/)
    expect(() => parseReport({ data: { marketById: null } }, 1)).toThrow(/no market/)
  })
  it('asks for 30 days of history ending now', () => {
    const q = reportQuery('0xabc', 1_000_000)
    expect(q.variables).toMatchObject({ id: '0xabc', chainId: 1, to: 1_000_000, from: 1_000_000 - 30 * 86_400 })
  })
})

describe('lenderView', () => {
  it('caps withdrawable at the market liquidity', () => {
    const v = lenderView(lender(250_000), null)!
    expect(v.withdrawableNow).toBe(100_000)
    expect(v.withdrawableShare).toBeCloseTo(0.4)
    expect(v.risks.find((r) => r.id === 'exit')!.flagged).toBe(true)
  })
  it('lets a small supply leave in full', () => {
    const v = lenderView(lender(1_000), null)!
    expect(v.withdrawableShare).toBe(1)
    expect(v.risks.find((r) => r.id === 'exit')!.flagged).toBe(false)
  })
  it('keeps rewards unknown until the report lands, then adds them with ‡', () => {
    const before = lenderView(lender(1_000), null)!
    expect(before.apr.rewards).toBeNull()
    expect(before.apr.total).toBeNull()
    expect(aprLine(before, 'reading')).toBe('4.50% base · rewards reading…')
    expect(aprLine(before, 'error')).toBe('4.50% base · rewards not read')
    const after = lenderView(lender(1_000), parseReport(body(), 1))!
    expect(after.apr.total).toBeCloseTo(0.0911)
    expect(after.apr.marked).toBe(true)
    expect(aprLine(after, 'ok')).toBe(`4.50% base + 4.61%${REWARDS_MARK} rewards = 9.11%${REWARDS_MARK}`)
  })
  it('says no rewards only when the API answered with none', () => {
    const v = lenderView(lender(1_000), parseReport(body({ state: { rewards: [] } }), 1))!
    expect(aprLine(v, 'ok')).toBe('4.50% base · no rewards reported')
  })
  it('puts the API bad debt and its RED warning under the bad-debt risk', () => {
    const v = lenderView(lender(1_000), parseReport(body(), 1))!
    const r = v.risks.find((x) => x.id === 'bad-debt')!
    expect(r.flagged).toBe(true)
    expect(r.facts.join(' · ')).toContain('unrealized bad debt $3.5k')
    expect(r.facts.join(' · ')).toContain('bad debt unrealized (red)')
  })
  it('is null without the market state', () => {
    const p = lender(1_000)
    delete p.lendMarket
    expect(lenderView(p, null)).toBeNull()
  })
})
