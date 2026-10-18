// The lending block's pure logic (lib/position/lender.ts).

import { describe, expect, it } from 'vitest'

import {
  REWARDS_MARK,
  aprFromApy,
  aprLine,
  badDebtWords,
  factsLine,
  lenderView,
  llamaPoolFor,
  parseLlamaChart,
  parseReport,
  parseVaultReport,
  reportQuery,
  reportRequest,
  rewardNote,
  shareText,
} from '@/lib/position/lender'
import type { LendMarketState, ProtocolPosition } from '@/lib/position-sim/types'

const market: LendMarketState = {
  venue: 'morpho-market',
  token: '0x0000000000000000000000000000000000000001',
  aprBasis: 'test',
  morpho: {
    oracle: '0x1111111111111111111111111111111111111111',
    loanToken: '0x0000000000000000000000000000000000000001',
    collateralToken: '0x2222222222222222222222222222222222222222',
    collateralSymbol: 'sNUSD',
    loanDecimals: 6,
    lltv: 0.915,
    irm: '0x3333333333333333333333333333333333333333',
  },
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
      historicalState: {
        liquidityAssetsUsd: [{ x: 200, y: 5 }, { x: 100, y: 4 }, { x: 300, y: null }],
        utilization: [{ x: 100, y: 0.9 }],
        supplyApy: [{ x: 100, y: 0.05 }],
        borrowApy: [{ x: 100, y: 0.06 }],
      },
      ...over,
    },
  },
})

describe('parseReport', () => {
  it('keeps paying rewards, sorts history and drops null points', () => {
    const r = parseReport(body(), 1)
    expect(r.rewards).toEqual([{ symbol: 'FXN', apr: 0.0461 }])
    expect(r.liquidityUsd).toEqual([
      { t: 100, v: 4 },
      { t: 200, v: 5 },
    ])
    expect(r.liquidityYearUsd).toEqual(r.liquidityUsd)
    expect(r.utilization).toEqual([{ t: 100, v: 0.9 }])
    // APYs become the page's simple APR: ln(1 + APY).
    expect(r.supplyApr[0].v).toBeCloseTo(Math.log(1.05), 12)
    expect(r.borrowApr[0].v).toBeCloseTo(Math.log(1.06), 12)
    expect(r.source).toBe('Morpho API')
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
    // Free liquidity alone goes back a year: the exit region's untested baseline reads it.
    expect(q.variables).toMatchObject({ fromYear: 1_000_000 - 365 * 86_400 })
    expect(q.query).toMatch(/liquidityAssetsUsd\(options: \{ startTimestamp: \$fromYear/)
  })
})

describe('lenderView', () => {
  it('caps withdrawable at the market liquidity', () => {
    const v = lenderView(lender(250_000), null)!
    expect(v.withdrawableNow).toBe(100_000)
    expect(v.withdrawableShare).toBeCloseTo(0.4)
  })
  it('lets a small supply leave in full', () => {
    const v = lenderView(lender(1_000), null)!
    expect(v.withdrawableShare).toBe(1)
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
    expect(v.pending!.share).toBeCloseTo(0.446)
    expect(v.badDebt.line).toBe('pending write-off: 44.6% of supply ≈ $124 of yours')
    expect(v.badDebt.realized).toBe('$290.1k already written off since market creation')
    expect(lenderView(lender(277), parseReport(body({ badDebt: { usd: 0 } }), 1))!.badDebt.line).toBe('no unrealized bad debt')
    expect(lenderView(lender(277), null)!.badDebt.line).toBeNull()
  })
  it('never prints the API severity or repeats bad-debt warnings; names not_whitelisted in words', () => {
    const v = lenderView(lender(1_000), parseReport(body(), 1))!
    const all = v.warnings.map((w) => w.text).join(' | ')
    expect(all).not.toMatch(/red|yellow/i)
    expect(all).not.toMatch(/bad debt unrealized/)
    expect(v.warnings).toEqual([{ text: 'Not listed by Morpho', flagged: false }])
  })
  it('says the structure in one line', () => {
    expect(factsLine(lender(1), market)).toBe(
      'Direct Morpho market · no curator · LLTV 91.5% · oracle 0x1111…1111 · fee 0% · oracle and LLTV fixed at creation',
    )
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
    expect(v.liquidityUsd).toBeCloseTo(0.4)
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

describe('pooled venues and vaults', () => {
  const aave = (deficit: number | null): ProtocolPosition => ({
    ...lender(10_000, {
      ...market,
      venue: 'aave-reserve',
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      fee: 0.1,
      morpho: undefined,
      deficit,
    }),
    protocol: 'aave-v3',
    label: 'Aave V3 · USDC supply',
    marketId: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  })

  it('finds the DefiLlama pool by venue and token, and never guesses an ambiguous one', () => {
    expect(llamaPoolFor('aave-v3', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toMatch(/^[0-9a-f-]{36}$/)
    expect(llamaPoolFor('compound-v3', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toMatch(/^[0-9a-f-]{36}$/)
    // GHO and sGHO share an underlying on DefiLlama: not matched.
    expect(llamaPoolFor('aave-v3', '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f')).toBeNull()
    expect(reportRequest(aave(0))).toMatchObject({ kind: 'llama' })
    expect(reportRequest(lender(1))).toEqual({ kind: 'morpho-market', id: '0xabc' })
  })

  it('reads a DefiLlama chart as daily liquidity and supply APR over the last 30 days, rewards as one line', () => {
    const now = Date.parse('2026-10-17T00:00:00Z')
    const day = (d: number, h = 0) => new Date(now - d * 86_400_000 + h * 3_600_000).toISOString()
    const r = parseLlamaChart(
      {
        status: 'success',
        data: [
          { timestamp: day(40), tvlUsd: 1, apyBase: 1, apyReward: null },
          { timestamp: day(2), tvlUsd: 10, apyBase: 5, apyReward: null },
          { timestamp: day(2, 4), tvlUsd: 12, apyBase: 6, apyReward: null },
          { timestamp: day(1), tvlUsd: null, apyBase: 4, apyReward: 2 },
        ],
      },
      now,
    )
    expect(r.liquidityUsd.map((p) => p.v)).toEqual([12])
    // The year series keeps day −40 for the baseline; the 30-day chart does not.
    expect(r.liquidityYearUsd.map((p) => p.v)).toEqual([1, 12])
    expect(r.supplyApr.map((p) => p.v)).toEqual([Math.log1p(0.06), Math.log1p(0.04)])
    // apyReward is a reward rate in percent, not a compounded APY: divided by 100 only.
    expect(r.rewards).toEqual([{ symbol: 'reward tokens', apr: 0.02 }])
    expect(r.utilization).toEqual([])
    expect(() => parseLlamaChart({ status: 'error' }, now)).toThrow(/no data/)
  })

  const aaveWith = (deficit: number | null, backstop: LendMarketState['backstop'], protocol: 'aave-v3' | 'spark' = 'aave-v3') => {
    const p = aave(deficit)
    return { ...p, protocol, lendMarket: { ...p.lendMarket!, backstop } }
  }

  it('reads an Aave deficit Umbrella cannot slash for as unbacked supply: the last share out cannot be paid', () => {
    const v = lenderView(aaveWith(24_400, { slashable: false, pending: 0, offset: 25_000, stake: 10_000 }), null)!
    expect(v.pending!.share).toBeCloseTo(0.0244)
    expect(v.badDebt.danger).toBe(true)
    expect(v.badDebt.line).toBe(
      '2.44% of this reserve’s supply has no backing (an on-chain deficit; Umbrella cannot slash for it); if lenders withdraw in full, the last 2.44% out cannot be paid — ≈ $244 of yours',
    )
    expect(v.badDebt.line).not.toMatch(/treasury/)
    // Aave still pays interest: an unbacked share is not a paper rate.
    expect(v.paper).toBeNull()
  })
  it('counts only the uncovered part when Umbrella can slash, and none when its stake covers it', () => {
    const part = lenderView(aaveWith(50_000, { slashable: true, pending: 50_000, offset: 0, stake: 30_000 }), null)!
    expect(part.pending!.share).toBeCloseTo(0.02)
    expect(part.badDebt.line).toMatch(/Umbrella’s stake is smaller/)
    const full = lenderView(aaveWith(50_000, { slashable: true, pending: 50_000, offset: 0, stake: 80_000 }), null)!
    expect(full.pending).toBeNull()
    expect(full.badDebt.danger).toBe(false)
    expect(full.badDebt.line).toBe('reserve deficit: 5.00% of supply; slashable, and Umbrella’s stake covers it')
  })
  it('says no deficit, and on Spark that it is not readable rather than reusing the Aave sentence', () => {
    expect(lenderView(aaveWith(0, null), null)!.badDebt.line).toBe('no reserve deficit')
    const spark = lenderView(aaveWith(null, null, 'spark'), null)!
    expect(spark.badDebt.line).toBe('deficit not readable on Spark')
    expect(badDebtWords(aaveWith(null, null, 'spark'), null).short).toBe('A reserve deficit is not readable on Spark.')
    expect(factsLine(aave(0), aave(0).lendMarket!)).toBe('Aave V3 pool reserve · governed by the DAO · every listed collateral backs it · reserve factor 10%')
  })
  it('gives the hero the same words as the block', () => {
    const p = aaveWith(24_400, { slashable: false, pending: 0, offset: 25_000, stake: 10_000 })
    expect(badDebtWords(p, null).short).toBe('2.44% of this reserve’s supply has no backing.')
    expect(badDebtWords(p, null).line).toBe(lenderView(p, null)!.badDebt.line)
  })
  it('keeps the "as of last update" clause to Morpho markets: Aave and Compound rates are live', () => {
    const p = aaveWith(0, null)
    const old = { ...p, lendMarket: { ...p.lendMarket!, lastUpdate: 0, blockTs: 5 * 86_400 } }
    const v = lenderView(old, null)!
    expect(v.sinceUpdateS).toBeNull()
    expect(v.paper).toBeNull()
  })

  it("caps a vault holder's exit at the vault's own maxWithdraw and quotes its reported net rate", () => {
    const vaultMarket: LendMarketState = {
      ...market,
      venue: 'morpho-vault',
      morpho: undefined,
      supplyApr: null,
      borrowApr: null,
      fee: 0.05,
      liquidity: 5_000_000,
      vault: {
        address: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB',
        name: 'Steakhouse USDC',
        assets: 1_000,
        maxWithdraw: 600,
        fee: 0.05,
        curator: '0x4444444444444444444444444444444444444444',
        owner: null,
        allocation: [
          { marketId: '0x01', label: 'wstETH/USDC 86%', assets: 10, marketLiquidity: 5, available: 5, utilization: 0.9 },
          { marketId: '0x02', label: 'USDC idle market', assets: 0, marketLiquidity: 0, available: 0, utilization: 0 },
        ],
      },
    }
    const p = { ...lender(1_000, vaultMarket), protocol: 'morpho-vault' as const }
    const report = parseVaultReport(
      { data: { vaultByAddress: { warnings: [], state: { netApyExcludingRewards: 0.0431, allRewards: [{ asset: { symbol: 'MORPHO' }, supplyApr: 0.01 }] }, historicalState: { netApyWithoutRewards: [{ x: 1, y: 0.04 }] } } } },
      1,
    )
    const v = lenderView(p, report)!
    expect(v.withdrawableNow).toBe(600)
    expect(v.withdrawableShare).toBeCloseTo(0.6)
    expect(v.apr.reported).toBeCloseTo(aprFromApy(0.0431), 12)
    // Base excludes rewards; rewards are their own ‡ line.
    expect(aprLine(v, 'ok')).toBe(`4.22% net, reported (after the vault’s fee) + 1.00%${REWARDS_MARK} rewards = 5.22%${REWARDS_MARK}`)
    expect(report.supplyApr[0].v).toBeCloseTo(Math.log1p(0.04), 12)
    expect(v.paper).toBeNull()
    expect(v.badDebt.line).toBeNull()
    expect(reportRequest(p)).toEqual({ kind: 'morpho-vault', address: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB' })
    expect(factsLine(p, vaultMarket)).toBe('MetaMorpho vault · curator 0x4444…4444 · 1 of 2 queue markets funded · fee 5% · the curator can move supply between markets')
    expect(() => parseVaultReport({ data: { vaultByAddress: null } }, 1)).toThrow(/no vault/)
  })
})
