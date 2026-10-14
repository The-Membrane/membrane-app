// components/PositionV0/viewModel.ts — every page state from adapter results, no React.

import { describe, expect, it } from 'vitest'

import {
  MEMBRANE_LINE,
  MODELLED_FOOTER,
  PROTOCOL_APP_URL,
  buildPositionView,
  creditLine,
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
import { TOUCH_TABLE } from '@/lib/position/touchHistory'

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
  it('ETH collateral, USDC debt: hero, history at the floored distance, actions, protocol link', () => {
    const v = buildPositionView(pos('aave-v3', [coll('WETH', 10, 4000, 0.83)], [debt('USDC', 24_000, 1)]), t)
    expect(v.hero.kind).toBe('line')
    if (v.hero.kind !== 'line') return
    expect(v.hero.distancePct).toBe(27) // 1 − 24000/33200 = 27.7%
    expect(v.hero.priceShown).toBe(2892) // 4000 × 0.72289 = 2891.57 → up
    expect(v.priceSource).toBe('Aave V3 oracle')
    expect(v.appUrl).toBe('https://app.aave.com/')
    expect(v.title).toBe('Aave V3 · WETH / USDC')
    expect(v.history?.level).toBe(27)
    expect(v.history?.rows.map((r) => r.horizon)).toEqual(['1d', '3d', '7d', '14d', '30d'])
    expect(v.history?.rows.every((r) => r.level === 27 && r.confidence === null)).toBe(true)
    expect(v.history?.label).toBe('priced on ETH/USD history')
    expect(v.history?.credit).toMatch(/^Chainlink ETH\/USD hourly lows · membrane-datasets price-history · [0-9a-f]{7}$/)
    expect(v.history?.years).toBe('2020–26')
    expect(v.actions.length).toBeGreaterThan(0)
    expect(v.actions.every((a) => /^(Repay \$[\d,]+|Add [\d.,]+ WETH) → line at −\d+% → 7d: (<1|\d+)%$/.test(a.text))).toBe(true)
    expect(v.assumption).toBe("USDC held at today's price")
    expect(v.historyAbsent).toBeNull()
  })

  it('no debt: no line, no history, no actions', () => {
    const v = buildPositionView(pos('aave-v3', [coll('WETH', 1, 4000, 0.83)], []), t)
    expect(v.hero).toEqual({ kind: 'no-debt' })
    expect(v.history).toBeNull()
    expect(v.historyAbsent).toBeNull()
    expect(v.actions).toEqual([])
  })

  it('past the line: no history surface, actions still solve', () => {
    const v = buildPositionView(pos('aave-v3', [coll('WETH', 1, 4000, 0.83)], [debt('USDC', 3400, 1)]), t)
    expect(v.hero.kind).toBe('past')
    expect(v.history).toBeNull()
    expect(v.actions.length).toBeGreaterThan(0)
  })

  it('stables only: the history surface is omitted and says why', () => {
    const v = buildPositionView(
      pos('morpho-blue', [coll('sUSDe', 10_000, 1.19, 0.915)], [debt('USDC', 9_000, 1)], 'Morpho · sUSDe/USDC 91.5%',
        'ASSUMPTION: loan token USDC treated as exactly $1.00 — Morpho provides no USD price and we did not read one.'),
      t,
    )
    expect(v.history).toBeNull()
    expect(v.historyAbsent).toBe('Every leg is a USD stablecoin.')
    expect(v.actions).toEqual([])
    expect(v.priceSource).toBe('Morpho market oracle, USDC taken as $1')
    expect(v.hero.kind).toBe('line')
  })

  it('unknown collateral: omitted with the symbol named', () => {
    const v = buildPositionView(pos('compound-v3', [coll('LINK', 1000, 20, 0.79)], [debt('USDC', 8000, 1)], 'Compound V3 · USDC'), t)
    expect(v.historyAbsent).toBe('No price history for LINK yet.')
    expect(v.title).toBe('Compound V3 · USDC · LINK')
    expect(v.priceSource).toBe('Compound V3 price feed')
    expect(v.appUrl).toBe('https://app.compound.finance/')
  })

  it('a rise risk reads the highs table', () => {
    const v = buildPositionView(pos('aave-v3', [coll('USDC', 10_000, 1, 0.78)], [debt('WETH', 1.5, 4000)]), t)
    expect(v.history?.direction).toBe('rise')
    expect(v.history?.credit).toMatch(/hourly highs/)
    expect(creditLine(t, 'BTC', 'fall')).toMatch(/^Chainlink BTC\/USD hourly lows/)
  })

  it('sorts nearest the line first, no-debt last', () => {
    const far = buildPositionView(pos('aave-v3', [coll('WETH', 10, 4000, 0.83)], [debt('USDC', 5000, 1)]), t)
    const near = buildPositionView(pos('spark', [coll('WETH', 10, 4000, 0.83)], [debt('USDC', 30_000, 1)], 'Spark'), t)
    const none = buildPositionView(pos('compound-v3', [coll('WETH', 1, 4000, 0.83)], [], 'Compound V3 · USDC'), t)
    const past = buildPositionView(pos('morpho-blue', [coll('WETH', 1, 4000, 0.83)], [debt('USDC', 3400, 1)], 'Morpho · WETH/USDC'), t)
    expect(sortNearest([none, far, near, past]).map((v) => v.protocol)).toEqual(['morpho-blue', 'spark', 'aave-v3', 'compound-v3'])
  })

  it('links only to protocol app roots; Fluid has none', () => {
    for (const u of Object.values(PROTOCOL_APP_URL)) if (u) expect(u).toMatch(/^https:\/\/app\.[a-z]+\.[a-z]+\/$/)
    expect(PROTOCOL_APP_URL.fluid).toBeNull()
    expect(priceSourceOf(pos('spark', [], [], 'Spark'))).toBe('Spark oracle')
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
