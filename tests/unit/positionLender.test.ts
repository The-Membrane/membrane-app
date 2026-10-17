// The lending block's pure logic (lib/position/lender.ts).

import { describe, expect, it } from 'vitest'

import { REWARDS_MARK, aprLine, lenderView, parseReport, reportQuery, rewardNote, shareText } from '@/lib/position/lender'
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
  lastUpdate: 1_000_000,
  blockTs: 1_000_600,
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
  it('ties unrealized bad debt to the user and labels realized debt since creation', () => {
    const v = lenderView(lender(277), parseReport(body({ badDebt: { usd: 446_000 }, realizedBadDebt: { usd: 290_100 } }), 1))!
    const r = v.risks.find((x) => x.id === 'bad-debt')!
    expect(r.flagged).toBe(true)
    expect(v.pending!.share).toBeCloseTo(0.446)
    expect(r.facts).toEqual(['pending write-off: 44.6% of supply ≈ $124 of yours', '$290.1k already written off since market creation'])
  })
  it('never prints the API severity or repeats bad-debt warnings; names not_whitelisted in words', () => {
    const v = lenderView(lender(1_000), parseReport(body(), 1))!
    const all = v.risks.flatMap((r) => r.facts).join(' | ')
    expect(all).not.toMatch(/red|yellow/i)
    expect(all).not.toMatch(/bad debt unrealized/)
    expect(v.risks.find((r) => r.id === 'curator')!.facts).toEqual(['Not listed by Morpho'])
  })
  it('makes the rate a paper rate at 99%+ utilization, with bad debt, or after a day without an update', () => {
    expect(lenderView(lender(1_000), null)!.paper).toBeNull()
    const full = { ...market, utilization: 1, liquidity: 0, borrowApr: 7.9999, supplyApr: 7.9999, lastUpdate: 0, blockTs: 16 * 86_400 + 5 }
    const v = lenderView(lender(277, full), parseReport(body({ badDebt: { usd: 446_000 } }), 1))!
    expect(v.paper).toBe(
      'Rate at the rate model’s ceiling (800% APR) because 100% is borrowed. Interest accrues on paper; with unrealized bad debt at 45% of supply it is not being paid. Last on-chain update: 16 days ago.',
    )
    expect(lenderView(lender(1_000, { ...market, lastUpdate: 0, blockTs: 2 * 86_400 }), null)!.paper).toMatch(/Last on-chain update: 2 days ago/)
  })
  it('reads tiny liquidity as under $1 and a sliver of exit as ~0%', () => {
    const tiny = { ...market, liquidity: 0.4 }
    const v = lenderView(lender(1_000, tiny), null)!
    expect(v.risks.find((r) => r.id === 'exit')!.body).toContain('under $1 is free')
    expect(shareText(v.withdrawableShare)).toBe('~0%')
    expect(shareText(null)).toBe('—')
    expect(shareText(1)).toBe('100%')
    expect(lenderView(lender(0), null)!.withdrawableShare).toBeNull()
  })
  it('says what a reward figure is', () => {
    expect(rewardNote(['FXN'])).toBe('pool average, at today’s FXN price, claimed separately; the program can end')
  })
  it('is null without the market state', () => {
    const p = lender(1_000)
    delete p.lendMarket
    expect(lenderView(p, null)).toBeNull()
  })
})

describe('lending positions on the page', () => {
  it('folds dust supply into one count, orders lenders largest first, and the picker says so', async () => {
    const { pageState, noLines } = await import('@/components/PositionV0/viewModel')
    const { TOUCH_TABLE } = await import('@/lib/position/touchHistory')
    const dust = (id: string): ProtocolPosition => {
      const p = { ...lender(0), marketId: id, dustSupply: true }
      delete p.lendMarket
      p.supplied = []
      return p
    }
    const small = { ...lender(5), marketId: '0xsmall' }
    const big = { ...lender(277), marketId: '0xbig' }
    const results = {
      'morpho-blue': { protocol: 'morpho-blue' as const, label: 'Morpho Blue', status: 'ok' as const, fetchedAt: 0, positions: [dust('0xd1'), small, dust('0xd2'), big] },
    }
    const s = pageState(true, [], results, TOUCH_TABLE)
    expect(s.kind).toBe('positions')
    if (s.kind !== 'positions') return
    expect(s.dust).toBe(2)
    expect(s.views.map((v) => v.position.marketId)).toEqual(['0xbig', '0xsmall'])
    expect(noLines(s.views)).toBe(true)
  })
})
