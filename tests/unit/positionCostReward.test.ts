// lib/position/costReward.ts — the cost-vs-reward tracker's measured history (board Q34):
// annualized snapshots at today's size, never an earnings sum.

import { describe, expect, it } from 'vitest'

import raw from '@/components/PositionV0/dev/costRewardFixture.json'
import { VARIANTS } from '@/components/PositionV0/dev/costRewardVariantMeta'
import { baselineFan } from '@/lib/position/baselineFan'
import {
  BASELINE_DAYS,
  baselineSpreadSeries,
  type BaselineFixture,
  FORECAST_EXTENT_D,
  RATE_DAYS,
  costRewardTrack,
  merklCampaigns,
  morphoCampaigns,
  netValue,
  signedPct,
  signedUsd,
  signedUsdWhole,
  sourceStamps,
  spreadQuestion,
  spreadNow,
  spreadPct,
  usd2,
  windowed,
  type MerklOpportunity,
  type RateFixture,
  type RatePoint,
} from '@/lib/position/costReward'

const pt = (day: number, borrowApr: number, supplyApr: number): RatePoint => ({
  block: 1000 + day,
  ts: 1_700_000_000 + day * 86_400,
  borrowApr,
  supplyApr,
  borrowIndex: '1',
  supplyIndex: '1',
})

/** 1,000 USD of USDT debt, 2,000 USD of WETH collateral. */
function fixture(borrow: number[], supply: number[]): RateFixture {
  return {
    capturedAt: '2026-10-16T00:00:00.000Z',
    owner: '0x0',
    block: 1000 + borrow.length - 1,
    source: 'test',
    position: {
      label: 'Test',
      debt: [{ symbol: 'USDT', address: '0xD', amount: 1000, priceUsd: 1 }],
      collateral: [{ symbol: 'WETH', address: '0xC', amount: 1, priceUsd: 2000 }],
    },
    series: {
      '0xd': borrow.map((b, i) => pt(i, b, 0)),
      '0xc': supply.map((s, i) => pt(i, 0, s)),
    },
  }
}

describe('costRewardTrack', () => {
  it('prices each observed rate at the frozen size: C, R and S in $/yr', () => {
    const t = costRewardTrack(fixture([0.04, 0.05, 0.03], [0.01, 0.02, 0.02]))
    expect(t.points.map((p) => +p.costRate.toFixed(6))).toEqual([40, 50, 30])
    expect(t.points.map((p) => +p.rewardRate.toFixed(6))).toEqual([20, 40, 40])
    expect(t.points.map((p) => +p.spread.toFixed(6))).toEqual([-20, -10, 10])
    expect(t.legs.map((l) => [l.side, l.symbol, l.sizeUsd])).toEqual([
      ['cost', 'USDT', 1000],
      ['reward', 'WETH', 2000],
    ])
    expect(t.forecastTo - t.to).toBe(FORECAST_EXTENT_D * 86_400)
  })
  it('refuses a leg with no history, and legs read at different blocks', () => {
    const fx = fixture([0.04, 0.04], [0.01, 0.01])
    delete fx.series['0xc']
    expect(() => costRewardTrack(fx)).toThrow(/no rate history for WETH/)
    const skew = fixture([0.04, 0.04], [0.01, 0.01])
    skew.series['0xc'][1].block = 9999
    expect(() => costRewardTrack(skew)).toThrow(/same blocks/)
  })
  it('windows to the last 7 or 30 days, last observation included', () => {
    const t = costRewardTrack(fixture(Array(40).fill(0.04), Array(40).fill(0.01)))
    expect(windowed(t, '7d').points).toHaveLength(8)
    expect(windowed(t, '30d').points).toHaveLength(31)
    expect(windowed(t, '30d').legs[0].aprs).toHaveLength(31)
    expect(windowed(t, '7d').to).toBe(t.to)
    expect(windowed(t, 'all')).toBe(t)
  })
  it('builds from the captured archive reads', () => {
    const t = costRewardTrack(raw as RateFixture)
    expect(t.points).toHaveLength(RATE_DAYS + 1)
    expect(t.legs.map((l) => l.side).sort()).toEqual(['cost', 'reward'])
    for (let i = 1; i < t.points.length; i++) expect(t.points[i].ts).toBeGreaterThan(t.points[i - 1].ts)
    for (const l of t.legs) for (const a of l.aprs) expect(a).toBeGreaterThanOrEqual(0)
  })
})

describe('usd2', () => {
  it('prints two significant figures with a true minus', () => {
    expect(usd2(3181.4)).toBe('$3,200')
    expect(usd2(-368.2)).toBe('−$370')
    expect(usd2(46.4)).toBe('$46')
    expect(usd2(4.64)).toBe('$4.6')
    expect(usd2(0)).toBe('$0')
  })
})

describe('the yield spread (round 5)', () => {
  it('is called the yield spread, never "income minus interest"', () => {
    const b = VARIANTS.find((v) => v.key === 'B')!
    expect(b.title).toBe('Yield spread')
    for (const v of VARIANTS) expect(`${v.title} ${v.rationale}`).not.toMatch(/income (minus|−) interest/i)
  })
  it('reads as a percent of net value (collateral − debt, frozen)', () => {
    const t = costRewardTrack(fixture([0.04, 0.04], [0.01, 0.01]))
    expect(netValue(t)).toBe(1000)
    expect(spreadPct(t.points[0].spread, t)).toBeCloseTo(-0.02, 12)
    expect(signedPct(-0.0381)).toBe('−3.81%')
    expect(signedPct(0.0124)).toBe('+1.24%')
    expect(signedUsd(1234)).toBe('+$1,200')
    expect(signedUsd(-1500)).toBe('−$1,500')
  })
  it('adds incentives ‡ at the last observation only: supply adds income, borrow takes off interest', () => {
    const fx = fixture([0.04, 0.05], [0.01, 0.01])
    fx.incentives = {
      source: 'Merkl v4 test',
      fetchedAt: '2026-10-17T05:00:00.000Z',
      searched: 3,
      legs: [
        { address: '0xc', side: 'supply', campaigns: [{ id: 'a', name: 'A', apr: 0.02, start: 1, end: 2, rewardToken: null, conditions: null }] },
        { address: '0xd', side: 'borrow', campaigns: [{ id: 'b', name: 'B', apr: 0.01, start: null, end: null, rewardToken: null, conditions: null }] },
      ],
    }
    const t = costRewardTrack(fx)
    const now = spreadNow(t, fx)
    // Last point: income 2,000 × 1% = 20; interest 1,000 × 5% = 50; spread −30.
    expect(now.base).toBeCloseTo(-30, 9)
    // + 2,000 × 2% supply incentive + 1,000 × 1% borrow incentive = −30 + 40 + 10.
    expect(now.withIncentives).toBeCloseTo(20, 9)
    expect(now.legs.map((l) => [l.side, l.symbol, +l.usdPerYear.toFixed(9)])).toEqual([
      ['supply', 'WETH', 40],
      ['borrow', 'USDT', 10],
    ])
    expect(now.stamp).toBe('Merkl · fetched 17 Oct 05:00 UTC')
    // Never over the history: every point keeps the base spread.
    expect(t.points.map((p) => +p.spread.toFixed(9))).toEqual([-20, -30])
  })
  it('without a read there is no incentive figure; with no live campaign it equals the base', () => {
    const fx0 = fixture([0.04, 0.04], [0.01, 0.01])
    expect(spreadNow(costRewardTrack(fx0), fx0).withIncentives).toBeNull()
    const cap = raw as RateFixture
    expect(cap.incentives).toBeDefined()
    const now = spreadNow(costRewardTrack(cap), cap)
    expect(now.legs).toHaveLength(2)
    if (now.legs.every((l) => l.campaigns.length === 0)) expect(now.withIncentives).toBe(now.base)
  })
  it('matches Merkl Aave V3 opportunities to a leg by side and token, APR from percent', () => {
    const op = (o: Partial<MerklOpportunity>): MerklOpportunity => ({
      id: '1',
      type: 'AAVE_SUPPLY',
      name: 'Lend X on Aave',
      status: 'LIVE',
      chainId: 1,
      apr: 4.7,
      earliestCampaignStart: '1792108800',
      latestCampaignEnd: '1792713600',
      tokens: [{ address: '0xC', symbol: 'X' }],
      ...o,
    })
    const ops = [
      op({}),
      op({ id: '2', type: 'AAVE_BORROW' }),
      op({ id: '3', status: 'PAST' }),
      op({ id: '4', chainId: 8453 }),
      op({ id: '5', type: 'AAVE_V4_HUB_NET_LENDING' }),
      op({ id: '6', tokens: [{ address: '0xE', symbol: 'Y' }] }),
      op({ id: '7', name: 'Lend X (looping required)', type: 'AAVE_NET_LENDING' }),
    ]
    const sup = merklCampaigns(ops, { address: '0xc', side: 'supply' })
    expect(sup.map((c) => c.id)).toEqual(['1', '7'])
    expect(sup[0]).toMatchObject({ apr: 0.047, start: 1792108800, end: 1792713600, conditions: null })
    expect(sup[1].conditions).toMatch(/looping required/)
    expect(merklCampaigns(ops, { address: '0xc', side: 'borrow' }).map((c) => c.id)).toEqual(['2'])
  })
  it("reads Morpho API rewards per side, dropping empty ones", () => {
    const r = [
      { asset: { symbol: 'MORPHO', address: '0xM' }, supplyApr: 0.012, borrowApr: null },
      { asset: { symbol: 'WELL', address: '0xW' }, supplyApr: 0, borrowApr: 0.003 },
    ]
    expect(morphoCampaigns(r, 'supply').map((c) => [c.name, c.apr])).toEqual([['MORPHO rewards', 0.012]])
    expect(morphoCampaigns(r, 'borrow').map((c) => [c.name, c.apr])).toEqual([['WELL rewards', 0.003]])
  })
})

describe('the spread baseline (round 6, model-only)', () => {
  it('is the same series as the history where they overlap, over 12 months, and builds a fan', async () => {
    const base = (await import('@/components/PositionV0/dev/costRewardBaseline.json')).default as unknown as BaselineFixture
    const fx = raw as RateFixture
    const s = baselineSpreadSeries(fx, base)
    expect(s).toHaveLength(BASELINE_DAYS + 1)
    const t = costRewardTrack(fx)
    const tail = s.slice(-t.points.length)
    tail.forEach((p, i) => expect(p.v).toBeCloseTo(t.points[i].spread, 9))
    const fan = baselineFan(s, t.points[t.points.length - 1].spread, t.to, 'diff')
    expect(fan.ok).toBe(true)
    // The 91-day history alone is not enough: the region would stay model pending.
    expect(baselineFan(tail, 0, t.to, 'diff')).toMatchObject({ ok: false })
  })
  it('refuses a baseline that does not end at the fixture block', () => {
    const fx = fixture([0.04, 0.05], [0.01, 0.02])
    expect(() => baselineSpreadSeries(fx, { capturedAt: '', block: 1, source: '', series: {} })).toThrow(/fixture block/)
  })
})

describe('round 6: the spread to the dollar, and a question that fits its state', () => {
  it('shows the dollar figure to the nearest dollar beside its %', () => {
    expect(signedUsdWhole(-1635.4)).toBe('−$1,635')
    expect(signedUsdWhole(1234.6)).toBe('+$1,235')
    expect(signedUsdWhole(0.2)).toBe('$0')
    // −$1,635 over a $40,250 net value reads −4.06%: the two now agree.
    expect(signedPct(-1635 / 40_250)).toBe('−4.06%')
  })
  it('asks whether a negative spread gets back above $0, not whether it will go negative', () => {
    expect(spreadQuestion(-1635)).toMatchObject({ headline: 'Your spread is negative. Will it get back above $0?', cta: 'Alert me if the spread turns positive' })
    expect(spreadQuestion(12)).toMatchObject({ headline: 'Will your spread go negative?', cta: 'Alert me if the spread turns negative' })
    expect(spreadQuestion(0).headline).toBe('Will your spread go negative?')
  })
})

describe('round 7: one Sources line per source, each stamped', () => {
  it('stamps every line with its fetch time and names the baseline model-only', () => {
    const fx = raw as RateFixture
    const lines = sourceStamps(fx, { ok: true, days: 364 }, { source: 'Aave V3 Pool getReserveData', capturedAt: '2026-10-18T19:16:00Z' })
    expect(lines).toHaveLength(fx.incentives ? 4 : 3)
    for (const l of lines) expect(l).toMatch(/ · fetched \d\d:\d\d UTC/)
    expect(lines[2]).toMatch(/^Baseline, model-only: .*364 daily reads/)
    expect(sourceStamps(fx, { ok: false }, null)).toHaveLength(fx.incentives ? 3 : 2)
  })
})
