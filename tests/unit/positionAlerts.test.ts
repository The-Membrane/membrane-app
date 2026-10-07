// Position alerts — every rule, the anti-flap tracker, the engine and the dry-run
// Telegram formatter. The engine is pure, so each test builds a snapshot by hand and
// asserts the exact transition it produces.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_ALERT_CONFIG,
  DEFAULT_PUSH_MIN_SEVERITY,
  LIQUIDATION_DISTANCE_PRESET,
  computeMetrics,
  dryRunTelegram,
  evaluate,
  formatPositionAlert,
  heldLevel,
  initialEngineState,
  initialTracker,
  isNotifiable,
  ltvLines,
  rawLevel,
  recallNeededUsd,
  repayToReach,
  stepLevel,
  topUpToReach,
  validateConfig,
  validateSpec,
  type Alert,
  type AlertConfig,
  type EngineState,
  type LevelSpec,
  type MarketContext,
  type PositionSnapshot,
  type TrackerState,
} from '@/lib/positionAlerts'

const H = 3600
const T0 = Date.parse('2026-10-01T00:00:00Z') / 1000

const HF_SPEC: LevelSpec = {
  direction: 'below',
  enter: { watch: 1.3, warn: 1.15, critical: 1.05 },
  band: 0.03,
  dwellS: 2 * H,
  confirm: 1,
  cooldownS: 6 * H,
}

/** Run a value sequence (one sample per hour) through one tracker; return the transitions. */
function run(spec: LevelSpec, values: number[], start = T0) {
  let st: TrackerState = initialTracker()
  const out: { i: number; kind: string; from: number; to: number; peak: number }[] = []
  values.forEach((v, i) => {
    const r = stepLevel(spec, st, v, start + i * H)
    st = r.state
    if (r.transition)
      out.push({
        i,
        kind: r.transition.kind,
        from: r.transition.from,
        to: r.transition.to,
        peak: r.transition.peak,
      })
  })
  return { out, state: st }
}

/** Single-collateral ETH position against USD debt, sized to a target health factor. */
function ethPosition(
  hf: number,
  price = 3000,
  opts: Partial<PositionSnapshot> = {},
): PositionSnapshot {
  const debt = 100_000
  const lt = 0.83
  return {
    id: '0x1111111111111111111111111111111111111111',
    ts: T0,
    venue: 'Aave V3',
    collateral: [
      {
        symbol: 'ETH',
        amount: (hf * debt) / (price * lt),
        oraclePriceUsd: price,
        liquidationThreshold: lt,
      },
    ],
    debt: [{ symbol: 'USDC', amount: debt, priceUsd: 1 }],
    ...opts,
  }
}

const only = (cfg: Partial<AlertConfig>): AlertConfig => ({
  healthFactor: null,
  ltv: null,
  liquidationDistance: null,
  cushionBurn: null,
  depeg: null,
  exitCapacity: null,
  oracleChange: null,
  targetHf: 1.3,
  ...cfg,
})

/** Evaluate a sequence of (snapshot, ctx) pairs; return every alert. */
function evalSeq(cfg: AlertConfig, seq: { s: PositionSnapshot; ctx?: MarketContext }[]) {
  let state: EngineState = initialEngineState()
  const alerts: Alert[] = []
  const uncovered: string[][] = []
  for (const { s, ctx } of seq) {
    const r = evaluate(s, ctx ?? {}, state, cfg)
    state = r.state
    alerts.push(...r.alerts)
    uncovered.push(r.uncovered)
  }
  return { alerts, uncovered, state }
}

// ------------------------------------------------------------------ tracker

describe('level tracker (levels.ts)', () => {
  it('rejects thresholds out of order for the direction', () => {
    expect(() => validateSpec({ ...HF_SPEC, enter: { watch: 1.1, warn: 1.2 } })).toThrow(
      'out of order',
    )
    expect(() =>
      validateSpec({ ...HF_SPEC, direction: 'above', enter: { watch: 3, warn: 2 } }),
    ).toThrow('out of order')
    expect(() => validateSpec({ ...HF_SPEC, confirm: 0 })).toThrow()
    expect(() => validateSpec(HF_SPEC)).not.toThrow()
  })

  it('maps a value to the highest breached level, and holds levels inside the band', () => {
    expect(rawLevel(HF_SPEC, 1.4)).toBe(0)
    expect(rawLevel(HF_SPEC, 1.29)).toBe(1)
    expect(rawLevel(HF_SPEC, 1.1)).toBe(2)
    expect(rawLevel(HF_SPEC, 1.0)).toBe(3)
    expect(heldLevel(HF_SPEC, 1.32)).toBe(1) // 1.32 < 1.30 + 0.03
    expect(heldLevel(HF_SPEC, 1.34)).toBe(0)
  })

  it('fires, escalates through warn to critical, and never delays escalation', () => {
    const { out } = run(HF_SPEC, [1.5, 1.25, 1.12, 1.02])
    expect(out.map((t) => [t.kind, t.to])).toEqual([
      ['fire', 1],
      ['escalate', 2],
      ['escalate', 3],
    ])
  })

  it('debounces a one-sample wick when confirm = 2, but critical fires at once', () => {
    const spec = { ...HF_SPEC, confirm: 2 }
    expect(run(spec, [1.5, 1.25, 1.5, 1.5]).out).toHaveLength(0)
    expect(run(spec, [1.5, 1.25, 1.25]).out.map((t) => t.i)).toEqual([2])
    expect(run(spec, [1.5, 1.0]).out.map((t) => [t.kind, t.to])).toEqual([['fire', 3]])
  })

  it('holds the level while the value sits inside the hysteresis band', () => {
    // 1.31 is above the 1.30 line but inside the 0.03 band: no clear, however long.
    const { out, state } = run(HF_SPEC, [1.25, 1.31, 1.31, 1.31, 1.31, 1.31])
    expect(out.map((t) => t.kind)).toEqual(['fire'])
    expect(state.level).toBe(1)
  })

  it('clears only after the value stays past the band for dwellS, and a bounce resets the dwell', () => {
    // hourly samples, dwell 2h: recovered at i=1, still at i=2 (1h), clear at i=3 (2h)
    expect(run(HF_SPEC, [1.25, 1.4, 1.4, 1.4]).out.map((t) => [t.i, t.kind])).toEqual([
      [0, 'fire'],
      [3, 'clear'],
    ])
    // bounce back into the band at i=2 restarts the dwell
    expect(run(HF_SPEC, [1.25, 1.4, 1.31, 1.4, 1.4, 1.4]).out.map((t) => [t.i, t.kind])).toEqual([
      [0, 'fire'],
      [5, 'clear'],
    ])
  })

  it('eases one level down without clearing, and carries the episode peak into the clear', () => {
    const { out } = run(HF_SPEC, [1.1, 1.25, 1.25, 1.25, 1.5, 1.5, 1.5])
    expect(out.map((t) => [t.kind, t.from, t.to, t.peak])).toEqual([
      ['fire', 0, 2, 2],
      ['ease', 2, 1, 2],
      ['clear', 1, 0, 2],
    ])
  })

  it('suppresses a watch re-fire inside the cooldown, but never a warn re-fire', () => {
    const spec = { ...HF_SPEC, dwellS: 0, cooldownS: 6 * H }
    // watch at 0, clear at 1, watch again at 2 (2h after the first message): suppressed
    expect(run(spec, [1.25, 1.5, 1.25]).out.map((t) => t.kind)).toEqual([
      'fire',
      'clear',
      'suppressed',
    ])
    // same shape at warn: speaks again
    expect(run(spec, [1.1, 1.5, 1.1]).out.map((t) => t.kind)).toEqual(['fire', 'clear', 'fire'])
    // after the cooldown a watch speaks again
    expect(run(spec, [1.25, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.25]).out.map((t) => t.kind)).toEqual([
      'fire',
      'clear',
      'fire',
    ])
  })

  it("works the same way for an 'above' metric", () => {
    const spec: LevelSpec = {
      direction: 'above',
      enter: { watch: 50, warn: 150, critical: 500 },
      band: 20,
      dwellS: 0,
      confirm: 1,
      cooldownS: 0,
    }
    expect(run(spec, [10, 60, 200, 700, 140, 20]).out.map((t) => [t.kind, t.to])).toEqual([
      ['fire', 1],
      ['escalate', 2],
      ['escalate', 3],
      ['ease', 2],
      ['clear', 0],
    ])
  })
})

// ------------------------------------------------------------------ metrics

describe('position metrics (metrics.ts)', () => {
  it('computes LTV, health factor, liquidation price and distance for one leg', () => {
    const m = computeMetrics(ethPosition(1.25))
    expect(m.healthFactor).toBeCloseTo(1.25, 9)
    expect(m.liquidationLtv).toBeCloseTo(0.83, 9)
    expect(m.ltv).toBeCloseTo(0.83 / 1.25, 9)
    expect(m.dominant!.liquidationPriceUsd!).toBeCloseTo(3000 / 1.25, 6)
    expect(m.dominant!.distance!).toBeCloseTo(1 - 1 / 1.25, 9)
  })

  it('holds other legs fixed for the dominant liquidation price, and is null when they cover the debt', () => {
    const s = ethPosition(1.25)
    const withUsdc: PositionSnapshot = {
      ...s,
      collateral: [
        ...s.collateral,
        { symbol: 'USDC', amount: 20_000, oraclePriceUsd: 1, liquidationThreshold: 0.78 },
      ],
    }
    const m = computeMetrics(withUsdc)
    const eth = s.collateral[0]
    const expected = (100_000 - 20_000 * 0.78) / (eth.amount * 0.83)
    expect(m.dominant!.symbol).toBe('ETH')
    expect(m.dominant!.liquidationPriceUsd!).toBeCloseTo(expected, 6)

    const covered: PositionSnapshot = {
      ...s,
      collateral: [
        ...s.collateral,
        { symbol: 'USDC', amount: 30_000, oraclePriceUsd: 1, liquidationThreshold: 0.8 },
      ],
      debt: [{ symbol: 'USDC', amount: 20_000, priceUsd: 1 }],
    }
    const c = computeMetrics(covered)
    expect(c.dominant!.symbol).toBe('ETH')
    expect(c.dominant!.liquidationPriceUsd).toBeNull()
  })

  it('reports infinite health factor with no debt', () => {
    expect(computeMetrics(ethPosition(1.5, 3000, { debt: [] })).healthFactor).toBe(Infinity)
  })

  it('values exchange-rate legs at market for marketHealthFactor only', () => {
    const s: PositionSnapshot = {
      ...ethPosition(1.2),
      collateral: [
        {
          symbol: 'rsETH',
          amount: 40,
          oraclePriceUsd: 3000,
          marketPriceUsd: 2700,
          liquidationThreshold: 0.8,
          oracleBasis: 'exchangeRate',
        },
      ],
    }
    const m = computeMetrics(s)
    expect(m.healthFactor).toBeCloseTo((40 * 3000 * 0.8) / 100_000, 9)
    expect(m.marketHealthFactor).toBeCloseTo((40 * 2700 * 0.8) / 100_000, 9)
  })

  it('repay and top-up amounts land exactly on the target health factor', () => {
    const s = ethPosition(1.1)
    const m = computeMetrics(s)
    const repay = repayToReach(m, 1.3)
    const afterRepay = computeMetrics({
      ...s,
      debt: [{ symbol: 'USDC', amount: 100_000 - repay, priceUsd: 1 }],
    })
    expect(afterRepay.healthFactor).toBeCloseTo(1.3, 9)
    const add = topUpToReach(m, 1.3, 0.83)
    const leg = s.collateral[0]
    const afterTopUp = computeMetrics({
      ...s,
      collateral: [{ ...leg, amount: leg.amount + add / leg.oraclePriceUsd }],
    })
    expect(afterTopUp.healthFactor).toBeCloseTo(1.3, 9)
    expect(repayToReach(computeMetrics(ethPosition(2)), 1.3)).toBe(0)
  })

  it('recall needed shocks only market-priced legs', () => {
    const s = ethPosition(1.3) // HF 1.04 after a 20% drop
    const need = recallNeededUsd(s, 0.2, 1.1)
    const w = s.collateral[0].amount * 3000 * 0.8 * 0.83
    expect(need).toBeCloseTo(100_000 - w / 1.1, 6)
    expect(need).toBeGreaterThan(5000)
    expect(recallNeededUsd(ethPosition(1.5), 0.2, 1.1)).toBe(0) // HF 1.2 after the drop
    const pegged: PositionSnapshot = {
      ...s,
      collateral: [{ ...s.collateral[0], oracleBasis: 'exchangeRate' }],
    }
    expect(recallNeededUsd(pegged, 0.2, 1.1)).toBe(0)
  })
})

// ------------------------------------------------------------------ rules through the engine

describe('health-factor rule', () => {
  it('fires warn below 1.15 with the default thresholds and says where liquidation starts', () => {
    const { alerts } = evalSeq(only({ healthFactor: DEFAULT_ALERT_CONFIG.healthFactor }), [
      { s: ethPosition(1.14) },
    ])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].ruleId).toBe('health-factor')
    expect(alerts[0].severity).toBe('warn')
    expect(alerts[0].threshold).toBe(1.15)
    expect(alerts[0].detail).toContain('Liquidation starts at 1.00')
  })

  it('stays quiet on a healthy position', () => {
    expect(
      evalSeq(only({ healthFactor: DEFAULT_ALERT_CONFIG.healthFactor }), [{ s: ethPosition(1.8) }])
        .alerts,
    ).toHaveLength(0)
  })
})

describe('ltv rule', () => {
  it('is off by default', () => {
    expect(DEFAULT_ALERT_CONFIG.ltv).toBeNull()
  })

  it("fires at the user's own LTV line", () => {
    const cfg = only({ ltv: ltvLines({ warn: 0.65, critical: 0.75 }) })
    const { alerts } = evalSeq(cfg, [
      { s: ethPosition(1.5) },
      { s: { ...ethPosition(1.2), ts: T0 + H } },
    ])
    // LTV 0.553 then 0.692
    expect(alerts.map((a) => [a.ruleId, a.severity, a.threshold])).toEqual([['ltv', 'warn', 0.65]])
    expect(alerts[0].title).toContain('69.2%')
  })
})

describe('liquidation-distance rule', () => {
  const dist = LIQUIDATION_DISTANCE_PRESET

  it('is opt-in: off in the default config', () => {
    expect(DEFAULT_ALERT_CONFIG.liquidationDistance).toBeNull()
  })

  it('static mode: critical when the dominant asset is within 7% of its liquidation price', () => {
    const cfg = only({ liquidationDistance: { ...dist, mode: 'static' } })
    const { alerts } = evalSeq(cfg, [{ s: ethPosition(1.06) }]) // distance 5.7%
    expect(alerts.map((a) => [a.key, a.severity])).toEqual([['ETH:pct', 'critical']])
    expect(alerts[0].title).toContain('ETH at $2,830')
  })

  it('sigma mode: the same distance alarms in a fast market and not in a calm one', () => {
    const cfg = only({ liquidationDistance: dist })
    // distance 20%: ln(1/0.8) = 0.223. 24h horizon.
    const calm = evalSeq(cfg, [{ s: ethPosition(1.25), ctx: { hourlyVol: { ETH: 0.004 } } }]) // 0.223/(0.004*4.9) = 11 sigma
    const fast = evalSeq(cfg, [{ s: ethPosition(1.25), ctx: { hourlyVol: { ETH: 0.03 } } }]) // 1.5 sigma
    expect(calm.alerts).toHaveLength(0)
    expect(fast.alerts.map((a) => [a.key, a.severity])).toEqual([['ETH:sigma', 'warn']])
    expect(fast.alerts[0].detail).toContain('sigma')
  })

  it('sigma mode falls back to the static thresholds without a volatility reading', () => {
    const { alerts } = evalSeq(only({ liquidationDistance: dist }), [{ s: ethPosition(1.06) }])
    expect(alerts.map((a) => a.key)).toEqual(['ETH:pct'])
  })
})

describe('cushion-burn rule', () => {
  const cfg = only({ cushionBurn: DEFAULT_ALERT_CONFIG.cushionBurn })

  it('fires when most of the cushion above 1.0 goes inside the lookback', () => {
    // HF 1.20 -> 1.04 in one hour: 80% of the 0.20 cushion gone
    const { alerts } = evalSeq(cfg, [
      { s: ethPosition(1.2) },
      { s: { ...ethPosition(1.04), ts: T0 + H } },
    ])
    expect(alerts.map((a) => [a.ruleId, a.severity])).toEqual([['cushion-burn', 'critical']])
    expect(alerts[0].detail).toContain('80% of the cushion')
  })

  it('judges a looper parked at HF 1.005 on the same scale', () => {
    const steady = evalSeq(cfg, [
      { s: ethPosition(1.012) },
      { s: { ...ethPosition(1.011), ts: T0 + H } }, // 8% of a 0.012 cushion: quiet
    ])
    expect(steady.alerts).toHaveLength(0)
    const { alerts } = evalSeq(cfg, [
      { s: ethPosition(1.012) },
      { s: { ...ethPosition(1.011), ts: T0 + H } },
      { s: { ...ethPosition(1.005), ts: T0 + 2 * H } }, // 58% of a 0.012 cushion
    ])
    expect(alerts.map((a) => a.severity)).toEqual(['critical'])
  })

  it('fires only at critical by default — a 40% burn stays quiet', () => {
    // HF 1.25 -> 1.15 in an hour: 40% of the 0.25 cushion
    const { alerts } = evalSeq(cfg, [
      { s: ethPosition(1.25) },
      { s: { ...ethPosition(1.15), ts: T0 + H } },
    ])
    expect(alerts).toHaveLength(0)
  })

  it('ignores the same proportional drop above maxHf, and a slow drift outside the lookback', () => {
    expect(
      evalSeq(cfg, [{ s: ethPosition(2.5) }, { s: { ...ethPosition(1.8), ts: T0 + H } }]).alerts,
    ).toHaveLength(0)
    // 1.30 -> 1.20 over 12h in 1h steps, lookback 6h: never 30% of the cushion inside 6h
    const slow = Array.from({ length: 13 }, (_, i) => ({
      s: { ...ethPosition(1.3 - (0.1 * i) / 12), ts: T0 + i * H },
    }))
    expect(evalSeq(cfg, slow).alerts).toHaveLength(0)
  })
})

describe('collateral-depeg rule', () => {
  const cfg = only({ depeg: DEFAULT_ALERT_CONFIG.depeg })
  const usde = (price: number, ts = T0): PositionSnapshot => ({
    id: 'p1',
    ts,
    venue: 'Morpho',
    collateral: [
      {
        symbol: 'USDe',
        amount: 100_000,
        oraclePriceUsd: 1,
        marketPriceUsd: price,
        liquidationThreshold: 0.86,
        oracleBasis: 'hardcoded',
        peg: { class: 'stable', underlying: 'USD', rate: 1 },
      },
    ],
    debt: [{ symbol: 'USDC', amount: 80_000, priceUsd: 1 }],
  })

  it('needs two confirming samples, then fires warn at 150+ bps for a stable', () => {
    const { alerts } = evalSeq(cfg, [{ s: usde(0.98) }, { s: usde(0.98, T0 + H) }])
    expect(alerts.map((a) => [a.key, a.severity, a.ts])).toEqual([['USDe', 'warn', T0 + H]])
    expect(alerts[0].title).toContain('200 bps below $1')
  })

  it('tells a hard-coded-oracle borrower that health factor does not see the move', () => {
    const { alerts } = evalSeq(cfg, [{ s: usde(0.9) }, { s: usde(0.9, T0 + H) }])
    expect(alerts[0].severity).toBe('critical')
    expect(alerts[0].detail).toContain('a fixed value')
    expect(alerts[0].evidence.marketHealthFactor as number).toBeLessThan(
      alerts[0].evidence.healthFactor as number,
    )
  })

  it('measures an LST against its underlying times the redemption rate', () => {
    const wst = (price: number, ts: number): PositionSnapshot => ({
      ...ethPosition(1.5),
      ts,
      collateral: [
        {
          symbol: 'wstETH',
          amount: 50,
          oraclePriceUsd: price,
          liquidationThreshold: 0.8,
          peg: { class: 'lst', underlying: 'ETH', rate: 1.2 },
        },
      ],
    })
    // fair = 3000 * 1.2 = 3600; 3510 is 250 bps under -> not above the 250 warn line; 3500 is 278 bps
    const ctx = { underlyingUsd: { ETH: 3000 } }
    const { alerts } = evalSeq(cfg, [
      { s: wst(3500, T0), ctx },
      { s: wst(3500, T0 + H), ctx },
    ])
    expect(alerts.map((a) => [a.key, a.severity])).toEqual([['wstETH', 'warn']])
    expect(alerts[0].detail).toContain('already counts it')
  })

  it('reports itself uncovered without an underlying price, and skips small legs', () => {
    const wst: PositionSnapshot = {
      ...ethPosition(1.5),
      collateral: [
        {
          symbol: 'wstETH',
          amount: 50,
          oraclePriceUsd: 3500,
          liquidationThreshold: 0.8,
          peg: { class: 'lst', underlying: 'ETH', rate: 1.2 },
        },
      ],
    }
    const r = evalSeq(cfg, [{ s: wst }])
    expect(r.alerts).toHaveLength(0)
    expect(r.uncovered[0].join()).toContain('collateral-depeg:wstETH')
    const tiny: PositionSnapshot = {
      ...ethPosition(1.5),
      collateral: [
        ...ethPosition(1.5).collateral,
        {
          symbol: 'USDe',
          amount: 10,
          oraclePriceUsd: 1,
          marketPriceUsd: 0.5,
          liquidationThreshold: 0.8,
          peg: { class: 'stable', underlying: 'USD', rate: 1 },
        },
      ],
    }
    expect(evalSeq(cfg, [{ s: tiny }, { s: { ...tiny, ts: T0 + H } }]).alerts).toHaveLength(0)
  })
})

describe('exit-capacity rule', () => {
  const cfg = only({ exitCapacity: DEFAULT_ALERT_CONFIG.exitCapacity })
  // HF 1.0x after a 20% shock needs a recall; size it.
  const s = ethPosition(1.2)
  const need = recallNeededUsd(s, 0.2, 1.1)
  const reading = (availableUsd: number, asOf = T0) => ({
    venue: 'aave-usde',
    availableUsd,
    asOf,
    provenance: 'test',
  })

  it('is uncovered with no reading, and with only a stale one', () => {
    expect(evalSeq(cfg, [{ s }]).uncovered[0].join()).toContain('exit-capacity:recall')
    expect(
      evalSeq(cfg, [{ s, ctx: { capacity: [reading(1e9, T0 - 3 * H)] } }]).uncovered[0].join(),
    ).toContain('no fresh venue capacity')
  })

  it('goes critical when the venue cannot cover the recall the position would need', () => {
    expect(need).toBeGreaterThan(0)
    const { alerts } = evalSeq(cfg, [{ s, ctx: { capacity: [reading(need * 0.8)] } }])
    expect(alerts.map((a) => a.severity)).toEqual(['critical'])
    expect(alerts[0].detail).toContain('0.80x')
  })

  it('stays quiet when capacity is ample or nothing would need recalling', () => {
    expect(evalSeq(cfg, [{ s, ctx: { capacity: [reading(need * 10)] } }]).alerts).toHaveLength(0)
    expect(
      evalSeq(cfg, [{ s: ethPosition(3), ctx: { capacity: [reading(1)] } }]).alerts,
    ).toHaveLength(0)
  })
})

describe('oracle-change rule (stub interface)', () => {
  const cfg = only({ oracleChange: DEFAULT_ALERT_CONFIG.oracleChange })
  const ev = (
    kind: 'feed_replaced' | 'paused' | 'heartbeat_changed',
    asset = 'ETH',
    ts = T0 - 60,
  ) => ({
    asset,
    oracle: '0xfeed',
    kind,
    ts,
    detail: 'test',
    source: 'test',
  })

  it('is uncovered while the registry is not wired', () => {
    const r = evalSeq(cfg, [{ s: ethPosition(1.5), ctx: { oracleEvents: [ev('paused')] } }])
    expect(r.alerts).toHaveLength(0)
    expect(r.uncovered[0].join()).toContain('oracle registry not wired')
  })

  it('maps change kinds to severity and ignores assets the position does not hold', () => {
    const on = (events: ReturnType<typeof ev>[]) =>
      evalSeq(cfg, [
        { s: ethPosition(1.5), ctx: { oracleEvents: events, oracleEventsCovered: true } },
      ]).alerts
    expect(on([ev('feed_replaced')]).map((a) => a.severity)).toEqual(['warn'])
    expect(on([ev('paused')]).map((a) => a.severity)).toEqual(['critical'])
    expect(on([ev('heartbeat_changed')]).map((a) => a.severity)).toEqual(['watch'])
    expect(on([ev('paused', 'BTC')])).toHaveLength(0)
  })

  it('clears once the event ages out of the window', () => {
    const ctx = { oracleEvents: [ev('feed_replaced')], oracleEventsCovered: true }
    const { alerts } = evalSeq(cfg, [
      { s: ethPosition(1.5), ctx },
      { s: { ...ethPosition(1.5), ts: T0 + 25 * H }, ctx },
    ])
    expect(alerts.map((a) => a.transition)).toEqual(['fire', 'clear'])
  })
})

// ------------------------------------------------------------------ engine

describe('engine', () => {
  it('accepts the default config and rejects a mis-ordered one', () => {
    expect(() => validateConfig(DEFAULT_ALERT_CONFIG)).not.toThrow()
    expect(() =>
      validateConfig({
        ...DEFAULT_ALERT_CONFIG,
        healthFactor: { ...HF_SPEC, enter: { warn: 1.3, critical: 1.4 } },
      }),
    ).toThrow()
  })

  it('does not mutate the state it is given', () => {
    const s0 = initialEngineState()
    const snapshot = JSON.stringify(s0)
    evaluate(ethPosition(1.1), {}, s0, DEFAULT_ALERT_CONFIG)
    expect(JSON.stringify(s0)).toBe(snapshot)
  })

  it('sends fires and escalations, a clear only after a warn-level episode, never eases or suppressed re-entries', () => {
    const base: Alert = {
      positionId: 'p',
      ruleId: 'health-factor',
      key: 'hf',
      transition: 'fire',
      from: 0,
      to: 1,
      severity: 'watch',
      peak: 1,
      ts: T0,
      value: 1.2,
      threshold: 1.3,
      title: '',
      detail: '',
      evidence: {},
    }
    expect(isNotifiable(base)).toBe(true)
    expect(isNotifiable({ ...base, transition: 'escalate' })).toBe(true)
    expect(isNotifiable({ ...base, transition: 'clear', peak: 1 })).toBe(false)
    expect(isNotifiable({ ...base, transition: 'clear', peak: 2 })).toBe(true)
    expect(isNotifiable({ ...base, transition: 'ease' })).toBe(false)
    expect(isNotifiable({ ...base, transition: 'suppressed' })).toBe(false)
  })

  it('pushes from warn by default: a watch fire is not pushed, a warn fire and its clear are', () => {
    const base: Alert = {
      positionId: 'p',
      ruleId: 'health-factor',
      key: 'hf',
      transition: 'fire',
      from: 0,
      to: 1,
      severity: 'watch',
      peak: 1,
      ts: T0,
      value: 1.2,
      threshold: 1.3,
      title: '',
      detail: '',
      evidence: {},
    }
    expect(DEFAULT_PUSH_MIN_SEVERITY).toBe('warn')
    expect(isNotifiable(base, DEFAULT_PUSH_MIN_SEVERITY)).toBe(false)
    expect(isNotifiable({ ...base, to: 2, severity: 'warn' }, DEFAULT_PUSH_MIN_SEVERITY)).toBe(true)
    expect(
      isNotifiable(
        { ...base, transition: 'escalate', from: 1, to: 3, severity: 'critical' },
        'critical',
      ),
    ).toBe(true)
    expect(
      isNotifiable(
        { ...base, transition: 'clear', from: 2, to: 0, severity: 'warn', peak: 2 },
        DEFAULT_PUSH_MIN_SEVERITY,
      ),
    ).toBe(true)
    expect(
      isNotifiable(
        { ...base, transition: 'clear', from: 2, to: 0, severity: 'warn', peak: 2 },
        'critical',
      ),
    ).toBe(false)
  })

  it('keeps health-factor history bounded to the lookback', () => {
    let state = initialEngineState()
    for (let i = 0; i < 200; i++)
      state = evaluate({ ...ethPosition(1.4), ts: T0 + i * 600 }, {}, state).state
    expect(state.hfHistory.length).toBeLessThanOrEqual(62)
  })
})

// ------------------------------------------------------------------ telegram (dry run)

describe('telegram formatter (dry run only)', () => {
  it('formats a borrower message with the level, the numbers and what to do', () => {
    const s = ethPosition(1.12)
    const r = evaluate(s, {}, initialEngineState(), DEFAULT_ALERT_CONFIG)
    const text = formatPositionAlert({
      alerts: r.alerts.filter((a) => isNotifiable(a)),
      snapshot: s,
      metrics: r.metrics,
      targetHf: 1.3,
    })!
    expect(text.startsWith('[WARN] Aave V3 · 0x1111…1111')).toBe(true)
    expect(text).toContain('Health factor 1.12')
    expect(text.split('Health factor 1.12').length - 1).toBe(1) // stated once, in the alert title
    expect(text).toContain('Collateral $')
    expect(text).toContain('Liquidation if ETH reaches $2,679')
    expect(text).toMatch(/To get back to HF 1\.30: repay \$[0-9.]+K, or add \$[0-9.]+K of ETH\./)
    expect(text).toContain('Dry run: formatted, not sent')
    expect(text.length).toBeLessThanOrEqual(4096)
  })

  it('returns null for no alerts and an [OK] header for an all-clear', () => {
    const s = ethPosition(1.5)
    const m = computeMetrics(s)
    expect(formatPositionAlert({ alerts: [], snapshot: s, metrics: m, targetHf: 1.3 })).toBeNull()
    const clear: Alert = {
      positionId: s.id,
      ruleId: 'health-factor',
      key: 'hf',
      transition: 'clear',
      from: 2,
      to: 0,
      severity: 'warn',
      peak: 2,
      ts: T0,
      value: 1.5,
      threshold: 1.18,
      title: 'Health factor back to 1.50',
      detail: 'Recovered above 1.18.',
      evidence: {},
    }
    const text = formatPositionAlert({ alerts: [clear], snapshot: s, metrics: m, targetHf: 1.3 })!
    expect(text.startsWith('[OK]')).toBe(true)
    expect(text).not.toContain('To get back')
  })

  it('wraps the text without sending anything', () => {
    const d = dryRunTelegram('chat:test', 'hello')
    expect(d).toEqual({
      channel: 'telegram',
      dryRun: true,
      sent: false,
      to: 'chat:test',
      text: 'hello',
      parseMode: null,
      chars: 5,
    })
  })

  it('does not reuse the radar alarm sender and makes no network call anywhere in the module', () => {
    const dir = fileURLToPath(new URL('../../lib/positionAlerts/', import.meta.url))
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code).not.toMatch(/\bfetch\s*\(/)
      expect(code).not.toContain('api.telegram.org')
      expect(code).not.toMatch(
        /from ['"][^'"]*(notify|telegramBot|Radar\/telegramLogic|alarmRules)/,
      )
      expect(code).not.toMatch(/process\.env|BOT_TOKEN|CHAT_ID/)
    }
  })
})
