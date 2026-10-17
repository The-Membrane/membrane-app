// lib/position/costReward.ts — the cost-vs-reward tracker's measured history (board Q34):
// annualized snapshots at today's size, never an earnings sum.

import { describe, expect, it } from 'vitest'

import raw from '@/components/PositionV0/dev/costRewardFixture.json'
import {
  FORECAST_EXTENT_D,
  RATE_DAYS,
  costRewardTrack,
  usd2,
  windowed,
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
