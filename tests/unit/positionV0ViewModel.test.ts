// components/PositionV0/viewModel.ts — every page state from adapter results, no React.

import { describe, expect, it } from 'vitest'

import {
  MEMBRANE_LINE,
  MODELLED_FOOTER,
  PROTOCOL_APP_URL,
  assumptionOf,
  buildPositionView,
  creditLine,
  forecastFooter,
  lineTag,
  pageState,
  priceSourceOf,
  readStatus,
  sortNearest,
  statusSentence,
  statusWord,
} from '@/components/PositionV0/viewModel'
import { ADAPTERS } from '@/lib/position-sim/adapters'
import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'
import type { AdapterResult, CollateralLeg, DebtLeg, ProtocolId, ProtocolPosition } from '@/lib/position-sim/types'
import { ALERT_REFERENCE, alertHalfway, alertStep, referencePriceFrom } from '@/lib/position/alert'
import { fmtMove } from '@/lib/position/format'
import { confidenceOf, floorPct, touchAtLevel } from '@/lib/position/touch'
import { HORIZON_IDS, TOUCH_TABLE } from '@/lib/position/touchHistory'

const coll = (symbol: string, amount: number, priceUsd: number, lt: number): CollateralLeg => ({
  symbol, address: `0x${symbol}`, decimals: 18, amount, priceUsd, valueUsd: amount * priceUsd,
  liquidationThreshold: lt, maxLtv: lt - 0.03, liquidationBonus: 0.05,
})
const debt = (symbol: string, amount: number, priceUsd: number): DebtLeg => ({
  symbol, address: `0x${symbol}`, decimals: 6, amount, priceUsd, valueUsd: amount * priceUsd, borrowApr: 0.05,
})
function pos(protocol: ProtocolId, c: CollateralLeg[], d: DebtLeg[], label = 'Aave V3', detail?: string): ProtocolPosition {
  const C = c.reduce((s, x) => s + x.valueUsd, 0)
  const D = d.reduce((s, x) => s + x.valueUsd, 0)
  const W = c.reduce((s, x) => s + x.valueUsd * x.liquidationThreshold, 0)
  return {
    protocol, label, collateral: c, debt: d, totalCollateralUsd: C, totalDebtUsd: D,
    ltv: C ? D / C : 0, liquidationLtv: C ? W / C : 0, healthFactor: D ? W / D : Infinity,
    provenance: { kind: 'onchain', label: 'x', at: 1_760_000_000_000, detail },
  }
}
const result = (protocol: ProtocolId, status: AdapterResult['status'], positions: ProtocolPosition[] = [], message?: string): AdapterResult => ({
  protocol, label: protocol, status, positions, message, fetchedAt: 1, tookMs: 1,
})
const ORDER = ADAPTERS.map((a) => ({ id: a.id, label: a.label }))

describe('read status', () => {
  it('lists the five adapters in registry order, pending until each lands', () => {
    const items = readStatus(ORDER, {})
    expect(items.map((i) => i.label)).toEqual(['Aave V3', 'Spark', 'Morpho Blue', 'Compound V3', 'Fluid'])
    expect(items.every((i) => i.state === 'pending')).toBe(true)
    expect(statusWord(items[0])).toBe('Aave V3 reading…')
  })
  it('says Fluid is not supported yet, and names a failure', () => {
    const items = readStatus(ORDER, {
      'aave-v3': result('aave-v3', 'ok', [pos('aave-v3', [coll('WETH', 1, 4000, 0.83)], [debt('USDC', 1000, 1)])]),
      spark: result('spark', 'empty'),
      'morpho-blue': result('morpho-blue', 'error', [], 'morpho blue: HTTP 500'),
      'compound-v3': result('compound-v3', 'empty'),
      fluid: result('fluid', 'unsupported', [], 'Fluid is not implemented.'),
    })
    expect(items.map(statusWord)).toEqual([
      'Aave V3 read · 1 found',
      'Spark read',
      'Morpho Blue failed',
      'Compound V3 read',
      'Fluid not supported yet',
    ])
    expect(items[2].message).toBe('morpho blue: HTTP 500')
    expect(statusSentence(items)).toBe('Aave V3 / Spark / Compound V3 read · Morpho Blue failed · Fluid not supported yet')
    expect(statusSentence(readStatus(ORDER, {}))).toBe('Aave V3 / Spark / Morpho Blue / Compound V3 / Fluid reading…')
    // A Compound read that dropped one Comet on a sanity check names it in place.
    const partial = readStatus(ORDER, {
      'compound-v3': { ...result('compound-v3', 'ok', [pos('compound-v3', [coll('WETH', 1, 4000, 0.83)], [], 'Compound V3 · USDC')]), skipped: [{ market: 'cUSDTv3', reason: 'its base priced at 3 USD, outside 0.5–2' }] },
    })
    expect(partial.find((i) => i.protocol === 'compound-v3')?.skipped).toEqual([{ market: 'cUSDTv3', reason: 'its base priced at 3 USD, outside 0.5–2' }])
    expect(statusSentence(partial)).toBe('Compound V3 (cUSDTv3 skipped) read · Aave V3 / Spark / Morpho Blue / Fluid reading…')
  })
})

describe('page state', () => {
  const t = TOUCH_TABLE
  it('idle before a read', () => {
    expect(pageState(false, readStatus(ORDER, {}), {}, t)).toEqual({ kind: 'idle' })
  })
  it('reading until every adapter answers, unless a position already landed', () => {
    expect(pageState(true, readStatus(ORDER, {}), {}, t).kind).toBe('reading')
    const early = { 'aave-v3': result('aave-v3', 'ok', [pos('aave-v3', [coll('WETH', 1, 4000, 0.83)], [debt('USDC', 1000, 1)])]) }
    expect(pageState(true, readStatus(ORDER, early), early, t).kind).toBe('positions')
  })
  it('no positions found, with the unchecked venue named', () => {
    const r: Partial<Record<ProtocolId, AdapterResult>> = {
      'aave-v3': result('aave-v3', 'empty'), spark: result('spark', 'empty'), 'morpho-blue': result('morpho-blue', 'empty'),
      'compound-v3': result('compound-v3', 'empty'), fluid: result('fluid', 'unsupported'),
    }
    expect(pageState(true, readStatus(ORDER, r), r, t)).toEqual({ kind: 'none', unsupported: ['Fluid'], failed: [] })
  })
  it('one adapter error does not hide the others', () => {
    const r: Partial<Record<ProtocolId, AdapterResult>> = {
      'aave-v3': result('aave-v3', 'ok', [pos('aave-v3', [coll('WETH', 1, 4000, 0.83)], [debt('USDC', 1000, 1)])]),
      spark: result('spark', 'error', [], 'boom'), 'morpho-blue': result('morpho-blue', 'empty'),
      'compound-v3': result('compound-v3', 'empty'), fluid: result('fluid', 'unsupported'),
    }
    const s = pageState(true, readStatus(ORDER, r), r, t)
    expect(s.kind).toBe('positions')
    if (s.kind === 'positions') {
      expect(s.failed).toEqual(['Spark'])
      expect(s.views).toHaveLength(1)
    }
  })
})

describe('one position view', () => {
  const t = TOUCH_TABLE
  it('ETH collateral, USDC debt: hero, forecast at the floored distance per horizon, levers, alert inputs', () => {
    const v = buildPositionView(pos('aave-v3', [coll('WETH', 10, 4000, 0.83)], [debt('USDC', 24_000, 1)]), t)
    expect(v.hero.kind).toBe('line')
    if (v.hero.kind !== 'line') return
    expect(v.hero.distancePct).toBe(27) // 1 − 24000/33200 = 27.7%
    expect(v.hero.priceShown).toBe(2892) // 4000 × 0.72289 = 2891.57 → up
    expect(v.priceSource).toBe('Aave V3 oracle')
    expect(v.appUrl).toBe('https://app.aave.com/')
    expect(v.title).toBe('Aave V3 · WETH / USDC')
    const f = v.forecast!
    expect(f.level).toBe(27)
    expect(f.lookup).toBe('row')
    expect(f.label).toBe('priced on ETH/USD history')
    expect(f.credit).toMatch(/^Chainlink ETH\/USD hourly lows · membrane-datasets validation\/t1 rows · [0-9a-f]{7}$/)
    expect(f.years).toBe('2021–26')
    expect(f.footer).toBe('† forecast from ETH history 2021–26 (n ≈ 2,000 per horizon), not a guarantee')
    for (const h of HORIZON_IDS) {
      const hf = f.byHorizon[h]
      expect(hf.at).toEqual(touchAtLevel(t, 'ETH', 'fall', h, 27))
      expect(hf.confidence).toEqual(confidenceOf(t, 'ETH', 'fall', h))
      // −5 … −30 shown, widened to every lever's new line.
      expect(hf.range.from).toBe(5)
      expect(hf.range.to).toBe(Math.max(30, ...hf.actions.map((a) => a.newDistancePct)))
      expect(hf.curve.map((c) => c.level)).toEqual(Array.from({ length: hf.range.to - hf.range.from + 1 }, (_, i) => i + 5))
      expect(hf.actions.every((a) => a.horizon === h)).toBe(true)
    }
    const week = f.byHorizon['7d'].actions
    expect(week.length).toBeGreaterThan(0)
    expect(week.every((a) => /^(Repay [\d,]+ USDC|Add [\d.,]+ WETH) · line −\d+% · (<1|\d+)% \((up to \d+|\d+(–\d+)?)%\)$/.test(a.text))).toBe(true)
    expect(f.byHorizon['7d'].solve.reason).toBe('ok')
    expect(v.alert).toEqual({ asset: 'ETH', direction: 'fall', distance: v.hero.distance, referencePrice: 4000, referenceSource: 'Aave V3 oracle' })
    expect(v.assumption).toBe("USDC held at today's price")
    expect(v.forecastAbsent).toBeNull()
  })

  it('a wstETH position needs a read for the ETH price its alert is set on', () => {
    const v = buildPositionView(pos('aave-v3', [coll('wstETH', 10, 4800, 0.81)], [debt('USDC', 24_000, 1)]), t)
    expect(v.alert).toMatchObject({ asset: 'ETH', referencePrice: null, referenceSource: 'Aave V3 oracle' })
  })

  it('a line deeper than −30% widens the curve to it', () => {
    const v = buildPositionView(pos('aave-v3', [coll('WETH', 10, 4000, 0.83)], [debt('USDC', 15_000, 1)]), t) // 54.8%
    const hf = v.forecast!.byHorizon['7d']
    expect(v.forecast!.level).toBe(54)
    expect(hf.range).toEqual({ from: 5, to: 54 })
    expect(hf.at?.level).toBe(54)
  })

  it('no debt: no line, no forecast, no alert', () => {
    const v = buildPositionView(pos('aave-v3', [coll('WETH', 1, 4000, 0.83)], []), t)
    expect(v.hero).toEqual({ kind: 'no-debt' })
    expect(v.forecast).toBeNull()
    expect(v.forecastAbsent).toBeNull()
    expect(v.alert).toBeNull()
  })

  it('past the line: no chance at the line, the levers still solve, no alert', () => {
    const v = buildPositionView(pos('aave-v3', [coll('WETH', 1, 4000, 0.83)], [debt('USDC', 3400, 1)]), t)
    expect(v.hero.kind).toBe('past')
    expect(v.forecast?.byHorizon['7d'].at).toBeNull()
    expect(v.forecast?.byHorizon['7d'].actions.length).toBeGreaterThan(0)
    expect(v.alert).toBeNull()
  })

  it('a line under 1% away has no row to quote', () => {
    const v = buildPositionView(pos('aave-v3', [coll('WETH', 1, 4000, 0.8)], [debt('USDC', 3180, 1)]), t)
    expect(v.forecast?.lookup).toBe('within')
    expect(v.forecast?.byHorizon['7d'].at).toBeNull()
  })

  it('stables only: no forecast, and it says why', () => {
    const v = buildPositionView(
      pos('morpho-blue', [coll('sUSDe', 10_000, 1.19, 0.915)], [debt('USDC', 9_000, 1)], 'Morpho · sUSDe/USDC 91.5%',
        'ASSUMPTION: loan token USDC treated as exactly $1.00 — Morpho provides no USD price and we did not read one.'),
      t,
    )
    expect(v.forecast).toBeNull()
    expect(v.forecastAbsent).toBe('Every leg is a USD stablecoin.')
    expect(v.alert).toBeNull()
    expect(v.priceSource).toBe('Morpho market oracle, USDC taken as $1')
    expect(v.hero.kind).toBe('line')
  })

  it('unknown collateral: omitted with the symbol named', () => {
    const v = buildPositionView(pos('compound-v3', [coll('LINK', 1000, 20, 0.79)], [debt('USDC', 8000, 1)], 'Compound V3 · USDC'), t)
    expect(v.forecastAbsent).toBe('No price history for LINK yet.')
    expect(v.title).toBe('Compound V3 · USDC · LINK')
    expect(v.priceSource).toBe('Compound V3 price feed')
    expect(v.appUrl).toBe('https://app.compound.finance/')
  })

  it('legs that do not reproduce the protocol give no line, no forecast, no levers', () => {
    // An e-mode account whose legs still carry reserve thresholds (0 here).
    const p = pos('aave-v3', [coll('PT-srUSDe', 1000, 1, 0)], [debt('USDC', 800, 1)])
    const v = buildPositionView({ ...p, liquidationLtv: 0.92, healthFactor: 1.15 }, t)
    expect(v.hero).toEqual({ kind: 'unsplit', healthFactor: 1.15, reason: 'the legs carry no threshold the protocol applies' })
    expect(v.forecast).toBeNull()
    expect(v.forecastAbsent).toBe('Thresholds could not be split per asset.')
    expect(v.alert).toBeNull()
    expect(lineTag(v)).toBe('HF 1.15')
  })

  it('same-family collateral and debt: a ratio line, no ETH forecast, no alert', () => {
    const v = buildPositionView(pos('morpho-blue', [coll('wstETH', 10, 3000, 0.945)], [debt('WETH', 10, 2500)], 'Morpho · wstETH/WETH 94.5%',
      'Loan token WETH priced at $2500 from the Aave V3 oracle (no assumed peg).'), t)
    expect(v.basis).toMatchObject({ kind: 'ratio', base: 'wstETH', quote: 'WETH' })
    expect(v.hero.kind === 'line' && v.hero.unit).toEqual({ kind: 'ratio', base: 'wstETH', quote: 'WETH' })
    expect(v.forecast).toBeNull()
    expect(v.forecastAbsent).toBe('The line moves with the wstETH/WETH ratio, not the ETH price.')
    expect(v.assumption).toBe('wstETH moves against WETH')
    expect(v.alert).toBeNull()
    expect(v.priceSource).toBe('Morpho market oracle, WETH priced by the Aave V3 oracle')
  })

  it('a rise risk reads the highs table and alerts above', () => {
    const v = buildPositionView(pos('aave-v3', [coll('USDC', 10_000, 1, 0.78)], [debt('WETH', 1.6, 4000)]), t) // +21.9%
    expect(v.forecast?.direction).toBe('rise')
    expect(v.forecast?.credit).toMatch(/^Chainlink ETH\/USD hourly highs · membrane-datasets price-history, t1's origins · [0-9a-f]{7}$/)
    expect(v.forecast?.credit).not.toMatch(/validation\/t1/)
    expect(v.alert).toMatchObject({ direction: 'rise', referencePrice: 4000 })
    expect(creditLine(t, 'BTC', 'fall')).toMatch(/^Chainlink BTC\/USD hourly lows/)
    expect(forecastFooter(t, ['ETH', 'BTC'], 'fall')).toBe('† forecast from ETH and BTC history 2021–26 (n ≈ 2,000 per horizon), not a guarantee')
  })

  it('sorts nearest the line first, no-debt last', () => {
    const far = buildPositionView(pos('aave-v3', [coll('WETH', 10, 4000, 0.83)], [debt('USDC', 5000, 1)]), t)
    const near = buildPositionView(pos('spark', [coll('WETH', 10, 4000, 0.83)], [debt('USDC', 30_000, 1)], 'Spark'), t)
    const none = buildPositionView(pos('compound-v3', [coll('WETH', 1, 4000, 0.83)], [], 'Compound V3 · USDC'), t)
    const past = buildPositionView(pos('morpho-blue', [coll('WETH', 1, 4000, 0.83)], [debt('USDC', 3400, 1)], 'Morpho · WETH/USDC'), t)
    expect(sortNearest([none, far, near, past]).map((v) => v.protocol)).toEqual(['morpho-blue', 'spark', 'aave-v3', 'compound-v3'])
    // A line no price reaches sorts after every line, before no debt — even when its
    // exact "distance" (here 100%) is smaller than a far line's.
    const same = buildPositionView(pos('aave-v3', [coll('wstETH', 27, 3127, 0.81)], [debt('wstETH', 7.4, 3127)]), t)
    const veryFar = buildPositionView(pos('spark', [coll('WETH', 100, 4000, 0.83)], [debt('USDC', 100, 1)], 'Spark'), t)
    expect(same.hero).toMatchObject({ kind: 'unreachable', cause: 'interest' })
    expect(sortNearest([same, none, veryFar, near]).map((v) => v.hero.kind)).toEqual(['line', 'line', 'unreachable', 'no-debt'])
  })

  it('same asset on both sides: no line, no forecast, no levers; the tag says only interest moves it', () => {
    const v = buildPositionView(pos('aave-v3', [coll('wstETH', 27.34, 3127.46, 0.81)], [debt('wstETH', 7.43, 3127.46)]), t)
    expect(v.hero).toMatchObject({ kind: 'unreachable', cause: 'interest', symbol: 'wstETH' })
    expect(lineTag(v)).toBe('only interest moves the line')
    expect(v.forecast).toBeNull()
    expect(v.alert).toBeNull()
    expect(v.assumption).toBeNull()
    expect(v.forecastAbsent).toBe('Both sides are wstETH: only interest moves the line.')
  })

  it('names every leg the model moves, and every leg it holds', () => {
    const ratio = buildPositionView(pos('aave-v3', [coll('wstETH', 40, 3000, 0.95)], [debt('WETH', 20, 2500), debt('wstETH', 10, 3000)]), t)
    expect(ratio.assumption).toBe('wstETH collateral and debt move against WETH')
    const three = buildPositionView(pos('aave-v3', [coll('wstETH', 2464, 3127, 0.95), coll('weETH', 1716, 2775, 0.95)], [debt('WETH', 4617, 2509.5)]), t)
    expect(three.assumption).toBe("wstETH moves against WETH; weETH held at today's price")
    const dom = buildPositionView(pos('aave-v3', [coll('USDe', 96_546, 0.9987, 0.93)], [debt('USDC', 53_505, 0.9999), debt('USDT', 17_841, 0.9987), debt('USDe', 7036, 0.9987)]), t)
    expect(dom.assumption).toBe("USDe collateral and debt move; USDC, USDT held at today's price")
    expect(assumptionOf(null, dom.basis)).toBeNull()
  })

  it('links only to protocol app roots; Fluid has none', () => {
    for (const u of Object.values(PROTOCOL_APP_URL)) if (u) expect(u).toMatch(/^https:\/\/app\.[a-z]+\.[a-z]+\/$/)
    expect(PROTOCOL_APP_URL.fluid).toBeNull()
    expect(priceSourceOf(pos('spark', [], [], 'Spark'))).toBe('Spark oracle')
  })
})

describe('the alert prefill', () => {
  it('is halfway to the line, three significant figures, rounded toward now', () => {
    // 2,499.20 × (1 − 0.1831/2) = 2,270.4 → up → 2,280 (fall: toward now)
    expect(alertHalfway(2499.2, 0.1831344, 'fall')).toEqual({ price: 2280, decimals: 0, movePct: 8, direction: 'fall' })
    // rise: 4000 × 1.1 = 4,400 exactly stays; 4,401.2 → down → 4,400
    expect(alertHalfway(4000, 0.2, 'rise')).toEqual({ price: 4400, decimals: 0, movePct: 10, direction: 'rise' })
    expect(alertHalfway(4000, 0.20060, 'rise')?.price).toBe(4400)
    expect(alertHalfway(83_076.82, 0.1464, 'fall')?.price).toBe(77_000) // 76,995.8 → up to 77,000
    expect(alertStep(2270)).toBe(10)
    expect(alertStep(76_995)).toBe(100)
    expect(alertStep(0.987)).toBe(0.001)
  })
  it('stays strictly between now and the line, on the risk side, however close the line is', () => {
    // The line 0.6% below $2,509.52: three figures would round 2,502 up to 2,510, ABOVE
    // now. A finer step keeps it below: $2,502.
    expect(alertHalfway(2509.52, 0.006, 'fall')).toEqual({ price: 2502, decimals: 0, movePct: 0, direction: 'fall' })
    expect(alertHalfway(2509.52, 0.0004, 'fall')).toMatchObject({ price: 2509.1, decimals: 1 })
    for (const dir of ['fall', 'rise'] as const)
      for (const d of [0.0002, 0.0004, 0.004, 0.006, 0.009, 0.012, 0.05, 0.3]) {
        const p = alertHalfway(2509.52, d, dir)!
        const line = dir === 'fall' ? 2509.52 * (1 - d) : 2509.52 * (1 + d)
        if (dir === 'fall') expect(p.price < 2509.52 && p.price > line).toBe(true)
        else expect(p.price > 2509.52 && p.price < line).toBe(true)
      }
    // Under 1% to the line reads "<1%", never "0%".
    expect(fmtMove(floorPct(0.006), 'fall')).toBe('−<1%')
    expect(fmtMove(floorPct(0.006), 'rise')).toBe('+<1%')
  })

  it('has nothing to say without a line ahead or a price', () => {
    expect(alertHalfway(null, 0.2, 'fall')).toBeNull()
    expect(alertHalfway(2500, 0, 'fall')).toBeNull()
    expect(alertHalfway(2500, Infinity, 'rise')).toBeNull()
    expect(alertHalfway(2500, 1.2, 'fall')).toBeNull()
  })
  it('takes the asset price from a WETH / WBTC leg, never from an LST', () => {
    expect(referencePriceFrom(pos('aave-v3', [coll('WETH', 1, 2499.2, 0.83)], [debt('USDC', 1, 1)]), 'ETH')).toBe(2499.2)
    expect(referencePriceFrom(pos('aave-v3', [coll('wstETH', 1, 3114.6, 0.81)], [debt('USDC', 1, 1)]), 'ETH')).toBeNull()
    expect(referencePriceFrom(pos('aave-v3', [coll('WBTC', 1, 83_000, 0.78)], [debt('USDT', 1, 1)]), 'BTC')).toBe(83_000)
    expect(ALERT_REFERENCE.ETH.token).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  })
})

describe('the conditional Membrane line', () => {
  it('is built from the contract constants and stays conditional', () => {
    expect(MEMBRANE_LINE).toBe(
      `On Membrane: within ${(MAX_THRESHOLD_TO_DELAY * 100).toFixed(0)}% of the line, liquidation waits ${CURE_WINDOW_HOURS} hours.`,
    )
    expect(MEMBRANE_LINE).not.toMatch(/before liquidation/)
    expect(MODELLED_FOOTER).toBe('† modelled, not a guarantee')
  })
})
