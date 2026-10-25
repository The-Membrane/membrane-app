// The borrower channel: the R27 "3% rule" (at risk / act now) combined with the
// health-factor ladder, the episode re-arm, the multi-collateral k* distance, the health
// bar model and the dry-run template. Every snapshot is built by hand; ids are synthetic.

import { describe, expect, it } from 'vitest'

import {
  AT_RISK_RULE,
  AT_RISK_SUBTEXT,
  AT_RISK_SUBTEXT_CONFIG,
  DEFAULT_ALERT_CONFIG,
  atRiskSubtext,
  distanceAtHealthFactor,
  dryRunTelegram,
  evaluateBorrower,
  formatPositionAlert,
  healthBarModel,
  inAppNotice,
  initialBorrowerState,
  isAtRiskCheckDue,
  liquidationGeometry,
  type BorrowerState,
  type LiquidationTimer,
  type MarketContext,
  type PositionSnapshot,
} from '@/lib/positionAlerts'

const H = 3600
const T0 = Date.parse('2026-10-01T00:00:00Z') / 1000

/** 1 ETH at LT 0.8 against `debt` USDC. Liquidation price = debt / 0.8. */
function eth(
  price: number,
  opts: { debt?: number; amount?: number; spot?: number; i?: number } = {},
): PositionSnapshot {
  return {
    id: 'pos-a',
    ts: T0 + (opts.i ?? 0) * H,
    venue: 'Test venue',
    collateral: [
      {
        symbol: 'ETH',
        amount: opts.amount ?? 1,
        oraclePriceUsd: price,
        marketPriceUsd: opts.spot,
        liquidationThreshold: 0.8,
      },
    ],
    debt: [{ symbol: 'USDC', amount: opts.debt ?? 1600, priceUsd: 1 }],
  }
}
// Liquidation price for the default position: 1600 / 0.8 = 2000.
const LIQ = 2000
const at = (distance: number) => LIQ / (1 - distance)

/** Run a price path (one sample per hour), return each sample's evaluation. */
function path(prices: Array<number | PositionSnapshot>, ctx: MarketContext = {}) {
  let st: BorrowerState = initialBorrowerState()
  return prices.map((p, i) => {
    const snap = typeof p === 'number' ? eth(p, { i }) : { ...p, ts: T0 + i * H }
    const r = evaluateBorrower(snap, ctx, st)
    st = r.state
    return r
  })
}

const steps = (rs: ReturnType<typeof path>) =>
  rs.map((r) => r.inApp.filter((a) => a.step).map((a) => a.step))

const PROBABILITY = /probab|chance|likel|odds|confiden|\d+(\.\d+)?\s*%\s*(chance|likely|probab)/i

describe('config', () => {
  it('keeps every ladder default and adds the R27 constants with sources', () => {
    expect(DEFAULT_ALERT_CONFIG.healthFactor?.enter).toEqual({
      watch: 1.3,
      warn: 1.15,
      critical: 1.05,
    })
    expect(DEFAULT_ALERT_CONFIG.atRisk).toBe(AT_RISK_RULE)
    expect(AT_RISK_RULE).toEqual({ threshold: 0.03, rearmDistance: 0.1, evaluationIntervalS: H })
    expect(AT_RISK_SUBTEXT_CONFIG.provenance).toMatchObject({
      data: 'development',
      dataset: 'Aave V3 Polygon, Arbitrum and Optimism, 2023–2026 (simulated price touches)',
      ruling: 'Q26-R27 60fb0e6; replications Q26-R30 1f76bc9 and Q26-R31 4d6d6a0',
      review: 'c59f67f, f6092e8, 57653f4, 769f616',
    })
  })

  it('renders the subtext from a template, so the numbers can be swapped', () => {
    expect(AT_RISK_SUBTEXT.text).toBe(
      'Past data: alerts at this level came a median of 10 hours before liquidation, and about 2 in 3 simulated price touches got at least an hour of warning. Some come faster, so act now if you can.',
    )
    expect(
      atRiskSubtext({ ...AT_RISK_SUBTEXT_CONFIG, medianLeadH: 6, caughtShare: '3 in 4' }),
    ).toContain('median of 6 hours before liquidation, and about 3 in 4 simulated price touches')
    expect(AT_RISK_SUBTEXT.text).not.toMatch(PROBABILITY)
    expect(AT_RISK_SUBTEXT.text).not.toMatch(/you have \d+ hours/i)
  })

  it('evaluation is due at least hourly', () => {
    const st = initialBorrowerState().proximity
    expect(isAtRiskCheckDue(st, T0)).toBe(true)
    expect(isAtRiskCheckDue({ ...st, lastEvalTs: T0 }, T0 + H - 1)).toBe(false)
    expect(isAtRiskCheckDue({ ...st, lastEvalTs: T0 }, T0 + H)).toBe(true)
  })
})

describe('distance (k* rule)', () => {
  it('one volatile leg against a stable debt: distance = 1 − 1/HF', () => {
    const g = liquidationGeometry(eth(2500))
    const hf = (2500 * 0.8) / 1600
    expect(g.distance).toBeCloseTo(1 - 1 / hf, 12)
    expect(distanceAtHealthFactor(g, 1.3)).toBeCloseTo(1 - 1 / 1.3, 12)
    expect(distanceAtHealthFactor(g, 1.05)).toBeCloseTo(1 - 1 / 1.05, 12)
  })

  it('several legs: the uniform fall of the non-stable legs, stables held', () => {
    const s: PositionSnapshot = {
      id: 'pos-multi',
      ts: T0,
      venue: 'Test venue',
      collateral: [
        { symbol: 'ETH', amount: 1, oraclePriceUsd: 2000, liquidationThreshold: 0.8 }, // 1600
        { symbol: 'WBTC', amount: 0.01, oraclePriceUsd: 60000, liquidationThreshold: 0.75 }, // 450
        { symbol: 'USDC', amount: 500, oraclePriceUsd: 1, liquidationThreshold: 0.9 }, // 450
      ],
      debt: [
        { symbol: 'USDT', amount: 1500, priceUsd: 1 },
        { symbol: 'WETH', amount: 0.25, priceUsd: 2000 }, // 500, moves with the fall
      ],
    }
    const g = liquidationGeometry(s)
    // cStable 450, cMoving 2050, dStable 1500, dMoving 500 → m = (1500 − 450)/(2050 − 500)
    expect(g.cStable).toBeCloseTo(450)
    expect(g.cMoving).toBeCloseTo(2050)
    expect(g.dMoving).toBeCloseTo(500)
    const m = 1050 / 1550
    expect(g.distance).toBeCloseTo(1 - m, 12)
    expect(g.movingSymbols).toEqual(['ETH', 'WBTC'])
    // At that multiplier the health factor is exactly 1.
    const coll = 450 + 2050 * m
    const debt = 1500 + 500 * m
    expect(coll / debt).toBeCloseTo(1, 12)
    // HF lines map onto the same axis: at the 1.15 line, distance-to-line is 1 − m/m(1.15).
    const m115 = (1.15 * 1500 - 450) / (2050 - 1.15 * 500)
    expect(distanceAtHealthFactor(g, 1.15)).toBeCloseTo(1 - m / m115, 12)
  })

  it('a stable/PT loop is flagged and the 3% rule stays off for it', () => {
    const loop: PositionSnapshot = {
      id: 'pos-loop',
      ts: T0,
      venue: 'Morpho · PT-sUSDe/USDC 91.5%',
      collateral: [
        { symbol: 'PT-sUSDe', amount: 1000, oraclePriceUsd: 0.97, liquidationThreshold: 0.915 },
      ],
      debt: [{ symbol: 'USDC', amount: 870, priceUsd: 1 }],
    }
    expect(liquidationGeometry(loop).correlatedLoop).toBe(true)
    const r = evaluateBorrower(loop)
    expect(r.alerts.some((a) => a.ruleId === 'at-risk' || a.ruleId === 'act-now')).toBe(false)
    const bar = healthBarModel(loop)
    expect(bar.state).toBe('loop')
    expect(bar.markers.some((m) => m.id === 'at-risk')).toBe(false)
  })
})

describe('3% rule', () => {
  it('fires once per episode when the oracle price is within 3% of the line', () => {
    const rs = path([at(0.2), at(0.029), at(0.025), at(0.028), at(0.02)])
    const fired = rs.flatMap((r) => r.push.filter((a) => a.ruleId === 'at-risk'))
    expect(fired).toHaveLength(1)
    expect(fired[0].ts).toBe(T0 + H)
    expect(fired[0].subtext).toBe(AT_RISK_SUBTEXT.text)
    expect(fired[0].evidence.basis).toBe('oracle')
  })

  it('does not fire at 3.5%', () => {
    const rs = path([at(0.2), at(0.035)])
    expect(rs[1].alerts.some((a) => a.ruleId === 'at-risk')).toBe(false)
  })

  it('re-arms after the position moves more than 10% away', () => {
    const rs = path([at(0.02), at(0.08), at(0.02), at(0.11), at(0.02)])
    const fires = rs.map((r) => r.push.filter((a) => a.ruleId === 'at-risk').length)
    expect(fires).toEqual([1, 0, 0, 0, 1])
    expect(rs[3].rearmed).toContain('moved-away')
  })

  it('re-arms when the borrower adds collateral or repays', () => {
    const topUp = eth(at(0.02) / 1.001, { amount: 1.001 }) // same value at risk, more units
    const rs = path([at(0.02), topUp])
    expect(rs[1].rearmed).toContain('acted')
    expect(rs[1].push.some((a) => a.ruleId === 'at-risk')).toBe(true)

    const repay = eth(at(0.02), { debt: 1599 })
    const rs2 = path([at(0.02), repay])
    expect(rs2[1].rearmed).toContain('acted')
  })

  it('re-arms after a liquidation', () => {
    let st = initialBorrowerState()
    const a = evaluateBorrower(eth(at(0.02)), {}, st)
    st = a.state
    const b = evaluateBorrower(eth(at(0.02), { i: 1 }), {}, st, DEFAULT_ALERT_CONFIG, {
      liquidated: true,
    })
    expect(b.rearmed).toContain('liquidated')
    expect(b.push.some((x) => x.ruleId === 'at-risk')).toBe(true)
  })

  it('act now fires when spot is at or through the line, even with the oracle above it', () => {
    const snap = eth(at(0.02), { spot: LIQ * 0.99 })
    const r = evaluateBorrower(snap)
    expect(r.push.map((a) => a.step)).toEqual(['act-now'])
    expect(r.deduped.map((a) => a.step)).toContain('at-risk')
    expect(r.push[0].detail).toContain('Liquidation can start at any time')
    expect(r.push[0].detail).not.toMatch(/you have|hours? left|\d+ ?h to act/i)
  })

  it('reports a cadence gap longer than an hour', () => {
    let st = initialBorrowerState()
    st = evaluateBorrower(eth(3000), {}, st).state
    const late = evaluateBorrower({ ...eth(3000), ts: T0 + 2 * H }, {}, st)
    expect(late.cadenceGapS).toBe(2 * H)
    expect(late.cadenceOk).toBe(false)
  })
})

describe('combined with the health-factor ladder', () => {
  it('escalates watch → warn → critical → at risk → act now, one message per step', () => {
    // HF 1.25, 1.10, 1.04 (4.8% line passed, distance 3.8%), distance 2.5%, spot through.
    const rs = path([
      eth((1.25 * 1600) / 0.8, { i: 0 }),
      eth((1.1 * 1600) / 0.8, { i: 1 }),
      eth((1.04 * 1600) / 0.8, { i: 2 }),
      eth(at(0.025), { i: 3 }),
      eth(at(0.02), { spot: LIQ, i: 4 }),
      eth(at(0.02), { spot: LIQ * 0.98, i: 5 }),
    ])
    expect(steps(rs)).toEqual([['watch'], ['warn'], ['critical'], ['at-risk'], ['act-now'], []])
    // watch stays in-app; warn and up are pushed.
    expect(rs[0].push).toHaveLength(0)
    expect(rs[1].push.filter((a) => a.step).map((a) => a.step)).toEqual(['warn'])
  })

  it('a sample that crosses several steps sends only the highest', () => {
    const rs = path([eth(3000), eth(at(0.02), { i: 1 })])
    expect(rs[1].push.filter((a) => a.step).map((a) => a.step)).toEqual(['at-risk'])
    expect(rs[1].deduped.map((a) => a.step)).toEqual(['critical'])
  })

  it('no lower ladder step after at risk in the same episode', () => {
    // Multi-collateral: the 3% line is reached while HF is still above 1.05, then HF dips
    // under 1.05 later in the same episode. The ladder's critical is held back.
    const mk = (ethPx: number, i: number): PositionSnapshot => ({
      id: 'pos-mix',
      ts: T0 + i * H,
      venue: 'Test venue',
      collateral: [
        { symbol: 'ETH', amount: 1, oraclePriceUsd: ethPx, liquidationThreshold: 0.8 },
        { symbol: 'USDC', amount: 1000, oraclePriceUsd: 1, liquidationThreshold: 0.9 },
      ],
      debt: [{ symbol: 'USDC', amount: 2500, priceUsd: 1 }],
    })
    // Line: 0.8·p + 900 = 2500 → p = 2000. 3% away: p = 2061.9 → HF ≈ 1.0198 (already < 1.05).
    // So drive it from the warn zone straight into at-risk, then wobble inside critical.
    const rs = path([mk(2400, 0), mk(2061, 1), mk(2070, 2), mk(2055, 3)])
    const sent = rs.flatMap((r) => r.push.filter((a) => a.step).map((a) => a.step))
    expect(sent).toEqual(['warn', 'at-risk'])
  })

  it('other rules pass through untouched', () => {
    const snap: PositionSnapshot = {
      ...eth(3000),
      collateral: [
        ...eth(3000).collateral,
        {
          symbol: 'USDe',
          amount: 1000,
          oraclePriceUsd: 1,
          marketPriceUsd: 0.9,
          liquidationThreshold: 0.8,
          peg: { class: 'stable', underlying: 'USD', rate: 1 },
        },
      ],
    }
    // A 10% depeg is critical at once; the ladder dedup does not touch it.
    const r = evaluateBorrower(snap)
    expect(r.push.some((a) => a.ruleId === 'collateral-depeg' && !a.step)).toBe(true)
    expect(r.deduped.some((a) => a.ruleId === 'collateral-depeg')).toBe(false)
  })
})

describe('Membrane act now: line crossing, explainer, timer and recovery stubs', () => {
  const membrane = (price: number, i = 0): PositionSnapshot => ({
    ...eth(price, { i }),
    venue: 'Membrane',
  })
  const timer: LiquidationTimer = {
    startedTs: T0,
    expiresTs: T0 + 8 * H,
    immediateLiquidationPriceUsd: null,
    source: 'stub',
  }
  const BANNED = /you have \d+ hours|you have 8|a further drop|4%|hours? left/i

  it('fires at the oracle line crossing itself, with no timer event', () => {
    const r = evaluateBorrower(membrane(LIQ * 0.995))
    const a = r.push.find((x) => x.step === 'act-now')
    expect(a).toBeDefined()
    expect(a?.evidence.basis).toBe('line-crossing')
    expect(a?.detail).toContain(
      'Membrane uses a 1-hour average oracle price, which can lag the market. If it falls below your liquidation price ($2,000), anyone can start an 8-hour liquidation timer.',
    )
    // X = P / (1 + window); launch window until chain state is read.
    expect(a?.detail).toContain(
      'If it falls below $1,923, you can be liquidated at once, timer or not.',
    )
    expect(a?.detail).toContain('Past liquidations often came well before the 8 hours ended.')
    expect(a?.detail).not.toMatch(BANNED)
    expect(a?.detail).not.toMatch(PROBABILITY)
  })

  it('X follows the chain-state window when supplied', () => {
    const r = evaluateBorrower(membrane(LIQ * 0.995), { liquidationWindow: 0.05 })
    const a = r.push.find((x) => x.step === 'act-now')
    expect(a?.evidence.immediateLiquidationPrice).toBeCloseTo(2000 / 1.05, 9)
  })

  it('a started timer adds start and expiry, never a countdown promise', () => {
    const r = evaluateBorrower(membrane(LIQ * 0.995), { liquidationTimer: timer })
    const a = r.push.find((x) => x.step === 'act-now')
    expect(a?.title).toBe('Act now: Liquidation timer started')
    expect(a?.detail).toContain(
      'Liquidation timer started 2026-10-01 00:00 UTC, expires 2026-10-01 08:00 UTC.',
    )
    expect(a?.detail).not.toMatch(BANNED)
    const bar = healthBarModel(membrane(LIQ * 0.995), DEFAULT_ALERT_CONFIG, {
      liquidationTimer: timer,
    })
    expect(bar.state).toBe('act-now')
    expect(inAppNotice(bar)?.title).toBe('Liquidation timer started')
    expect(inAppNotice(bar)?.action).toBeNull()
  })

  it('post-recovery: oracle back above the line, timer still running → clear-it stub, disabled', () => {
    const bar = healthBarModel(membrane(at(0.05)), DEFAULT_ALERT_CONFIG, {
      liquidationTimer: timer,
    })
    expect(bar.state).toBe('act-now')
    const n = inAppNotice(bar)
    expect(n?.title).toBe('Repaying does not stop the timer. Clear it now.')
    expect(n?.action).toMatchObject({ id: 'clearRecoveredTimer', enabled: false })
    const r = evaluateBorrower(membrane(at(0.05)), { liquidationTimer: timer })
    const a = r.push.find((x) => x.step === 'act-now')
    expect(a?.evidence.recoveredTimer).toBe(1)
    expect(inAppNotice(bar, a)?.action?.enabled).toBe(false)
  })

  it('other venues keep the plain act-now line', () => {
    const r = evaluateBorrower(eth(LIQ * 0.995))
    expect(r.push.find((x) => x.step === 'act-now')?.detail).toContain(
      'Liquidation can start at any time',
    )
  })
})

describe('health bar model', () => {
  it('places the ladder lines, the 3% line and the position on one distance axis', () => {
    const bar = healthBarModel(eth(2500))
    const byId = Object.fromEntries(bar.markers.map((m) => [m.id, m]))
    expect(byId['act-now'].distance).toBe(0)
    expect(byId['at-risk'].distance).toBe(0.03)
    expect(byId.critical.distance).toBeCloseTo(1 - 1 / 1.05, 9)
    expect(byId.warn.distance).toBeCloseTo(1 - 1 / 1.15, 9)
    expect(byId.watch.distance).toBeCloseTo(1 - 1 / 1.3, 9)
    expect(bar.markers.map((m) => m.id)).toEqual([
      'act-now',
      'at-risk',
      'critical',
      'warn',
      'watch',
    ])
    expect(bar.distance).toBeCloseTo(0.2, 9)
    expect(bar.liquidationPriceUsd).toBeCloseTo(2000, 9)
    expect(bar.state).toBe('watch')
    expect(bar.axis.min).toBeLessThan(0)
  })

  it('states', () => {
    expect(healthBarModel(eth(4000)).state).toBe('clear')
    expect(healthBarModel(eth(at(0.1))).state).toBe('warn')
    expect(healthBarModel(eth(at(0.04))).state).toBe('critical')
    expect(healthBarModel(eth(at(0.02))).state).toBe('at-risk')
    expect(healthBarModel(eth(at(0.02), { spot: 1990 })).state).toBe('act-now')
    expect(healthBarModel(eth(3000, { debt: 0 })).state).toBe('no-debt')
    expect(healthBarModel(eth(10000)).offScale).toBe(true)
  })

  it('has a text equivalent with every number and no probability', () => {
    const bar = healthBarModel(eth(2500))
    expect(bar.summary).toContain('20.0% from liquidation')
    expect(bar.summary).toContain('ETH oracle $2,500, liquidation at $2,000')
    expect(bar.summary).toContain('at risk 3.0%')
    expect(bar.summary).toContain('watch 23.1% (HF 1.30)')
    for (const d of [0.5, 0.2, 0.1, 0.04, 0.02, -0.01])
      expect(healthBarModel(eth(at(d))).summary).not.toMatch(PROBABILITY)
  })

  it('the in-app notice puts the subtext under at risk only', () => {
    const atRisk = inAppNotice(healthBarModel(eth(at(0.02))))
    expect(atRisk?.tag).toBe('At risk')
    expect(atRisk?.subtext).toBe(AT_RISK_SUBTEXT.text)
    expect(inAppNotice(healthBarModel(eth(at(0.02), { spot: 1990 })))?.subtext).toBeNull()
    expect(inAppNotice(healthBarModel(eth(at(0.1))))).toBeNull()
    for (const n of [atRisk]) expect(`${n?.title} ${n?.detail}`).not.toMatch(PROBABILITY)
  })
})

describe('dry-run template', () => {
  it('tags AT RISK, includes the subtext, sends nothing and shows no probability', () => {
    const r = evaluateBorrower(eth(at(0.02)))
    const text = formatPositionAlert({
      alerts: r.push,
      snapshot: eth(at(0.02)),
      metrics: r.evaluation.metrics,
      targetHf: DEFAULT_ALERT_CONFIG.targetHf,
    })
    expect(text).not.toBeNull()
    expect(text!.split('\n')[0]).toBe('[AT RISK] Test venue · pos-a')
    expect(text).toContain(AT_RISK_SUBTEXT.text)
    expect(text).toContain('Dry run: formatted, not sent')
    expect(text).not.toMatch(PROBABILITY)
    const d = dryRunTelegram('test-recipient', text!)
    expect(d).toMatchObject({ dryRun: true, sent: false })
  })

  it('tags ACT NOW over a held-back at risk', () => {
    const snap = eth(at(0.02), { spot: 1990 })
    const r = evaluateBorrower(snap)
    const text = formatPositionAlert({
      alerts: r.push,
      snapshot: snap,
      metrics: r.evaluation.metrics,
      targetHf: 1.3,
    })
    expect(text!.split('\n')[0]).toBe('[ACT NOW] Test venue · pos-a')
    expect(text).not.toContain(AT_RISK_SUBTEXT.text)
  })
})
