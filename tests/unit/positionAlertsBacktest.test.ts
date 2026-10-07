// Back-test core (lib/positionAlerts/backtest.ts): the definitions the memo quotes —
// liquidation stamped at the START of its step, lead time from the earliest still-open
// episode, missed / censored / false alarm / undecided — each pinned on a hand-built path.

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ALERT_CONFIG,
  amountForHf,
  ewmaHourlyVol,
  quantile,
  replay,
  scoreReplay,
  setAndForgetSteps,
  summariseLeads,
  type AlertConfig,
  type PriceGrid,
  type Score,
} from '@/lib/positionAlerts'

const H = 3600
const T0 = Date.parse('2026-01-01T00:00:00Z') / 1000
const LT = 0.83
const DEBT = 100_000

const hfOnly: AlertConfig = {
  ...DEFAULT_ALERT_CONFIG,
  liquidationDistance: null,
  cushionBurn: null,
  depeg: null,
  exitCapacity: null,
  oracleChange: null,
}

/** Hourly grid from a close list; lows default to the closes. */
const grid = (close: number[], low?: number[]): PriceGrid => ({ startTs: T0, stepS: H, close, low })

function position(g: PriceGrid, hf0: number, endIdx = g.close.length - 1) {
  return {
    id: 'p',
    venue: 'test',
    symbol: 'ETH',
    amount: amountForHf(hf0, DEBT, g.close[0] as number, LT),
    debtUsd: DEBT,
    liquidationThreshold: LT,
    grid: g,
    startIdx: 0,
    endIdx,
  }
}

describe('setAndForgetSteps + replay', () => {
  it('opens at the requested health factor', () => {
    const g = grid([3000, 3000])
    const [first] = [...setAndForgetSteps(position(g, 1.4))]
    const leg = first.snapshot!.collateral[0]
    expect((leg.amount * leg.oraclePriceUsd * LT) / DEBT).toBeCloseTo(1.4, 9)
  })

  it('stamps a liquidation at the START of the step whose low crosses HF 1', () => {
    // HF0 1.5 at 3000 -> liquidation price 2000. Bar 3 closes at 2100 but its low is 1990.
    const close = [3000, 2900, 2600, 2100, 2050]
    const low = [3000, 2900, 2600, 1990, 2050]
    const r = replay(setAndForgetSteps(position(grid(close, low), 1.5)), hfOnly)
    expect(r.liquidatedAt).toBe(T0 + 3 * H)
    expect(r.modelledLiquidationAt).toBe(T0 + 3 * H)
  })

  it('measures lead time from the first message of the still-open episode', () => {
    // HF path 1.5, 1.45, 1.29, 1.10, 0.95 — watch fires at the bar-2 read (ts = T0+3h).
    const close = [3000, 2900, 2580, 2200, 1900]
    const r = replay(setAndForgetSteps(position(grid(close), 1.5)), hfOnly)
    const s = scoreReplay(r, { minLevel: 1, horizonS: 72 * H })
    expect(r.liquidatedAt).toBe(T0 + 4 * H)
    expect(s.missed).toBe(false)
    expect(s.leadS).toBe(T0 + 4 * H - (T0 + 3 * H))
    expect(s.leadRule).toBe('health-factor')
    // at minLevel warn the episode starts at the bar-3 read (ts = T0+4h), the same instant the
    // liquidating bar opens: zero lead. Not missed, but useless — summaries report >= 15m shares.
    const w = scoreReplay(r, { minLevel: 2, horizonS: 72 * H })
    expect(w.leadS).toBe(0)
  })

  it('counts a liquidation inside one coarse step as MISSED', () => {
    // healthy close, then one bar whose low liquidates: no read ever saw it coming
    const close = [3000, 3000, 3000]
    const low = [3000, 3000, 1900]
    const r = replay(setAndForgetSteps(position(grid(close, low), 1.5)), hfOnly)
    const s = scoreReplay(r, { minLevel: 1, horizonS: 72 * H })
    expect(s.liquidated).toBe(true)
    expect(s.missed).toBe(true)
    expect(s.leadS).toBeNull()
  })

  it('marks a position already in alert at its first read as censored', () => {
    const close = [3000, 2990, 2700, 2300]
    const r = replay(setAndForgetSteps(position(grid(close), 1.2)), hfOnly)
    const s = scoreReplay(r, { minLevel: 1, horizonS: 72 * H })
    expect(s.liquidated).toBe(true)
    expect(s.censored).toBe(true)
  })

  it('an episode that cleared before the liquidation does not count as warning', () => {
    // watch at 1.25, recover far above for > dwell, then a one-bar crash
    const close = [3000, 2500, 3500, 3500, 3500, 3500, 3500]
    const low = [...close.slice(0, 6), 1000]
    const r = replay(setAndForgetSteps(position(grid(close, low), 1.5)), hfOnly)
    expect(r.messages.map((m) => m.transition)).toEqual(['fire'])
    const s = scoreReplay(r, { minLevel: 1, horizonS: 72 * H })
    expect(s.missed).toBe(true)
  })

  it('a monitor that reads less often can miss what a frequent one catches', () => {
    // watch (HF 1.28) at the bar-2 read (T0+3h); liquidation at bar 4's low (T0+4h).
    // A 4h monitor reads at T0+2h (HF 1.5) and not again before the liquidation.
    const close = [3000, 3000, 2560, 2560, 2500]
    const low = [3000, 3000, 2560, 2560, 1900]
    const pos = position(grid(close, low), 1.5)
    const often = scoreReplay(replay(setAndForgetSteps(pos), hfOnly), {
      minLevel: 1,
      horizonS: 72 * H,
    })
    const rarely = scoreReplay(replay(setAndForgetSteps(pos), hfOnly, { monitorEveryS: 4 * H }), {
      minLevel: 1,
      horizonS: 72 * H,
    })
    expect(often.missed).toBe(false)
    expect(often.leadS).toBe(H)
    expect(rarely.missed).toBe(true)
  })

  it('uses a known liquidation time instead of the model, and stops reading before it', () => {
    const close = [3000, 2600, 2550, 2500, 2450]
    const r = replay(setAndForgetSteps(position(grid(close), 1.5)), hfOnly, {
      knownLiquidationTs: T0 + 3 * H,
    })
    expect(r.liquidatedAt).toBe(T0 + 3 * H)
    expect(r.modelledLiquidationAt).toBeNull()
    expect(r.lastTs).toBe(T0 + 3 * H)
  })
})

describe('false alarms', () => {
  it('counts a message with no liquidation in the horizon as false, and one whose horizon runs past the data as undecided', () => {
    // 100 hourly bars: dip to watch at bar 1 and recover; dip again at bar 98
    const close = Array.from({ length: 100 }, (_, i) => (i === 1 || i === 98 ? 2560 : 3000))
    const r = replay(setAndForgetSteps(position(grid(close), 1.5)), {
      ...hfOnly,
      healthFactor: { ...hfOnly.healthFactor!, cooldownS: 0 },
    })
    const s = scoreReplay(r, { minLevel: 1, horizonS: 72 * H })
    expect(s.liquidated).toBe(false)
    expect(s.worsening).toBe(2)
    expect(s.falseAlarms).toBe(1)
    expect(s.undecided).toBe(1)
  })

  it('counts a message followed by a liquidation inside the horizon as true', () => {
    const close = [3000, 2560, 2560, 2560, 1900]
    const s = scoreReplay(replay(setAndForgetSteps(position(grid(close), 1.5)), hfOnly), {
      minLevel: 1,
      horizonS: 72 * H,
    })
    expect(s.trueAlarms).toBe(1)
    expect(s.falseAlarms).toBe(0)
  })
})

describe('helpers', () => {
  it('ewmaHourlyVol is lookahead-free', () => {
    const close = Array.from({ length: 200 }, (_, i) => 3000 * Math.exp(0.01 * Math.sin(i)))
    const a = ewmaHourlyVol(grid(close), 24, 24)
    const changed = [...close]
    changed[150] = 1000
    const b = ewmaHourlyVol(grid(changed), 24, 24)
    for (let i = 0; i < 150; i++)
      expect(Number.isNaN(a[i]) ? 'nan' : a[i]).toEqual(Number.isNaN(b[i]) ? 'nan' : b[i])
    expect(b[150]).toBeGreaterThan(a[150])
    expect(Number.isNaN(a[10])).toBe(true) // inside warm-up
  })

  it('ewmaHourlyVol scales minute returns to an hourly sigma', () => {
    // alternating ±0.1% per minute: per-step sigma 0.001 -> hourly ~0.001 * sqrt(60)
    const close = Array.from({ length: 6000 }, (_, i) => 3000 * (i % 2 ? 1.001 : 1))
    const v = ewmaHourlyVol({ startTs: T0, stepS: 60, close }, 6, 24)
    expect(v[5999]).toBeCloseTo(Math.log(1.001) * Math.sqrt(60), 4)
  })

  it('quantile and summariseLeads', () => {
    expect(quantile([], 0.5)).toBeNull()
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5)
    const mk = (leadS: number | null, liquidated = true): Score => ({
      liquidated,
      leadS,
      missed: liquidated && leadS === null,
      censored: false,
      leadRule: null,
      worsening: 0,
      falseAlarms: 0,
      trueAlarms: 0,
      undecided: 0,
      messages: 0,
    })
    const s = summariseLeads([mk(30 * 60), mk(2 * H), mk(5 * H), mk(null), mk(null, false)])
    expect(s.liquidations).toBe(4)
    expect(s.missed).toBe(1)
    expect(s.atLeast15m).toBe(0.75)
    expect(s.atLeast1h).toBe(0.5)
    expect(s.atLeast4h).toBe(0.25)
    expect(s.median).toBe(2 * H)
  })
})
