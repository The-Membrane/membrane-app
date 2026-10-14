/**
 * The liquidation line of one position: which price moves it, how far that price is from
 * the line NOW, and the line as an absolute price for the hero.
 *
 * ONE MODEL FOR EVERY CASE. Split weighted collateral W = Σ amount·price·LT and debt D into
 * the part that moves with one price (Wm, Dm) and the part held at today's price. If the
 * moving price changes by a fraction x, health factor reaches 1 when
 *
 *     fall:  (W − D) = x · (Wm − Dm)          x = (W − D) / (Wm − Dm)
 *     rise:  (W − D) = x · (Dm − Wm)          x = (W − D) / (Dm − Wm)
 *
 * With all collateral in one family and stable debt this is the brief's
 * d = 1 − D / Σ(C_i·LT_i·P_i). With one moving collateral leg and everything else held,
 * it is computeMetrics' dominant-leg liquidation price (lib/positionAlerts/metrics.ts),
 * which the unit tests pin.
 *
 * ROUNDED TOWARD RISK. The hero price is rounded toward now (UP for a falling-price risk,
 * DOWN for a rising one) and the distance is floored to a whole percent.
 */

import type { PositionSnapshot } from '@/lib/positionAlerts/types'

import { assetClassOf } from './snapshot'
import { floorPct } from './touch'
import type { Direction, HistoryAsset } from './touchHistory'

// ------------------------------------------------------------------ basis

export type RiskBasis =
  /** One history family moves the line; the page shows that family's history. */
  | { kind: 'history'; asset: HistoryAsset; direction: Direction }
  /**
   * No single history series describes the position. The line is the largest collateral
   * leg's price with every other leg held. `reason` is ≤ 8 words, shown verbatim.
   */
  | { kind: 'dominant'; reason: string }
  /**
   * Collateral and debt are the SAME family and nothing else (wstETH against WETH, LBTC
   * against WBTC): an ETH move lifts or sinks both sides, so a USD line is the wrong axis.
   * The line is the collateral/debt price ratio, and no ETH-history forecast applies.
   */
  | { kind: 'ratio'; asset: HistoryAsset; base: string; quote: string; reason: string }

/**
 * A leg worth less than this share of the position's gross value (collateral + debt) is
 * dust: it is still in every sum, but it does not decide which history describes the
 * position and is not named in the assumption. A 0.00003 WBTC remnant next to 279 WETH
 * must not turn an ETH position into "ETH and BTC legs move separately".
 */
export const DUST_SHARE = 1e-3

interface NamedLeg {
  side: 'collateral' | 'debt'
  symbol: string
  usd: number
}

function namedLegs(s: PositionSnapshot): NamedLeg[] {
  const legs: NamedLeg[] = [
    ...s.collateral.map((c) => ({ side: 'collateral' as const, symbol: c.symbol, usd: c.amount * c.oraclePriceUsd })),
    ...s.debt.map((d) => ({ side: 'debt' as const, symbol: d.symbol, usd: d.amount * d.priceUsd })),
  ].filter((l) => l.usd > 0)
  const gross = legs.reduce((a, l) => a + l.usd, 0)
  return legs.filter((l) => l.usd >= DUST_SHARE * gross)
}

/** Collateral and debt symbols worth naming (dust excluded), in leg order, deduplicated. */
export function legSymbols(s: PositionSnapshot): { collateral: string[]; debt: string[] } {
  const legs = namedLegs(s)
  const pick = (side: NamedLeg['side']) => [...new Set(legs.filter((l) => l.side === side).map((l) => l.symbol))]
  return { collateral: pick('collateral'), debt: pick('debt') }
}

/**
 * Which price history, if any, describes this position's line. Dust legs are ignored.
 *   one family F on one side, stables elsewhere   history: a fall (collateral) or rise (debt) of F
 *   F on both sides plus stables                  history: the net F exposure's sign decides
 *   F on both sides and nothing else              ratio: the line is the collateral/debt ratio
 *   two families, an unknown asset, stables only  dominant leg, with the reason
 */
export function classifyRisk(s: PositionSnapshot): RiskBasis {
  const legs = namedLegs(s)
  const other = legs.find((l) => assetClassOf(l.symbol) === 'other')
  if (other) return { kind: 'dominant', reason: `No price history for ${other.symbol} yet.` }

  const families = new Set<HistoryAsset>()
  for (const l of legs) {
    const c = assetClassOf(l.symbol)
    if (c === 'ETH' || c === 'BTC') families.add(c)
  }
  if (families.size === 0) return { kind: 'dominant', reason: 'Every leg is a USD stablecoin.' }
  if (families.size > 1) return { kind: 'dominant', reason: 'ETH and BTC legs move separately.' }

  const asset = [...families][0]
  const inF = (sym: string) => assetClassOf(sym) === asset
  const inCollateral = legs.some((l) => l.side === 'collateral' && inF(l.symbol))
  const inDebt = legs.some((l) => l.side === 'debt' && inF(l.symbol))
  if (!(inCollateral && inDebt)) return { kind: 'history', asset, direction: inCollateral ? 'fall' : 'rise' }

  const largest = (side: NamedLeg['side']) =>
    [...legs].filter((l) => l.side === side && inF(l.symbol)).sort((a, b) => b.usd - a.usd)[0].symbol
  const ratio = (): RiskBasis => {
    const base = largest('collateral')
    return {
      kind: 'ratio',
      asset,
      base,
      quote: largest('debt'),
      reason: `The line moves with the ${base}/${asset} ratio, not the ${asset} price.`,
    }
  }
  if (legs.every((l) => inF(l.symbol))) return ratio()
  // F on both sides with stables beside it: the F legs move together; the net exposure
  // (weighted F collateral − F debt) says which way an F move hurts.
  const Wf = s.collateral
    .filter((c) => inF(c.symbol))
    .reduce((a, c) => a + c.amount * c.oraclePriceUsd * c.liquidationThreshold, 0)
  const Df = s.debt.filter((d) => inF(d.symbol)).reduce((a, d) => a + d.amount * d.priceUsd, 0)
  const E = Wf - Df
  if (Math.abs(E) <= DUST_SHARE * (Wf + Df)) return ratio()
  return { kind: 'history', asset, direction: E > 0 ? 'fall' : 'rise' }
}

// ------------------------------------------------------------------ model

/** What the line is quoted in: dollars of one asset, or the collateral/debt price ratio. */
export type LineUnit = { kind: 'usd' } | { kind: 'ratio'; base: string; quote: string }

export interface LineModel {
  unit: LineUnit
  direction: Direction
  /** The leg the hero quotes: the largest moving leg. */
  symbol: string
  /** Its oracle price now. */
  priceNow: number
  /** Weighted collateral, all and moving. */
  W: number
  Wm: number
  /** Debt, all and moving. */
  D: number
  Dm: number
  /** Legs that move with the price, and legs held at today's price. */
  moving: string[]
  held: string[]
}

const value = (amount: number, price: number) => amount * price

/** The model for a snapshot under a basis. Null when there is no collateral to price. */
export function lineModel(s: PositionSnapshot, basis: RiskBasis): LineModel | null {
  const coll = s.collateral.filter((c) => c.amount > 0)
  const debt = s.debt.filter((d) => d.amount > 0)
  if (coll.length === 0) return null

  const W = coll.reduce((a, c) => a + value(c.amount, c.oraclePriceUsd) * c.liquidationThreshold, 0)
  const D = debt.reduce((a, d) => a + value(d.amount, d.priceUsd), 0)

  // Names for the assumption line: dust legs are summed but not named.
  const named = new Set(namedLegs(s).map((l) => `${l.side}:${l.symbol}`))
  const nameC = (sym: string) => named.has(`collateral:${sym}`)
  const nameD = (sym: string) => named.has(`debt:${sym}`)

  if (basis.kind === 'history') {
    const inFamily = (sym: string) => assetClassOf(sym) === basis.asset
    const mc = coll.filter((c) => inFamily(c.symbol))
    const md = debt.filter((d) => inFamily(d.symbol))
    const Wm = mc.reduce((a, c) => a + value(c.amount, c.oraclePriceUsd) * c.liquidationThreshold, 0)
    const Dm = md.reduce((a, d) => a + value(d.amount, d.priceUsd), 0)
    const quoted =
      basis.direction === 'fall'
        ? [...mc].sort((a, b) => value(b.amount, b.oraclePriceUsd) - value(a.amount, a.oraclePriceUsd))[0]
        : null
    const quotedDebt =
      basis.direction === 'rise'
        ? [...md].sort((a, b) => value(b.amount, b.priceUsd) - value(a.amount, a.priceUsd))[0]
        : null
    const symbol = quoted?.symbol ?? quotedDebt?.symbol
    const priceNow = quoted?.oraclePriceUsd ?? quotedDebt?.priceUsd
    if (symbol === undefined || priceNow === undefined) return null
    const movingSyms = [
      ...mc.filter((c) => nameC(c.symbol)).map((c) => c.symbol),
      ...md.filter((d) => nameD(d.symbol)).map((d) => d.symbol),
    ]
    const all = [
      ...coll.filter((c) => nameC(c.symbol)).map((c) => c.symbol),
      ...debt.filter((d) => nameD(d.symbol)).map((d) => d.symbol),
    ]
    return {
      unit: { kind: 'usd' },
      direction: basis.direction,
      symbol,
      priceNow,
      W,
      Wm,
      D,
      Dm,
      moving: uniq(movingSyms),
      held: uniq(all.filter((x) => !movingSyms.includes(x))),
    }
  }

  if (basis.kind === 'ratio') {
    // Every collateral leg moves against the debt: the line is the base/quote price ratio
    // at which W·(1 − x) = D, quoted from the protocol's own oracle prices.
    const base = coll.find((c) => c.symbol === basis.base)
    const quote = debt.find((d) => d.symbol === basis.quote)
    if (!base || !quote || !(quote.priceUsd > 0)) return null
    return {
      unit: { kind: 'ratio', base: basis.base, quote: basis.quote },
      direction: 'fall',
      symbol: basis.base,
      priceNow: base.oraclePriceUsd / quote.priceUsd,
      W,
      Wm: W,
      D,
      Dm: 0,
      moving: uniq(coll.filter((c) => nameC(c.symbol)).map((c) => c.symbol)),
      held: uniq(debt.filter((d) => nameD(d.symbol)).map((d) => d.symbol)),
    }
  }

  // Dominant leg: the largest collateral leg by oracle value moves; everything else held.
  // Same selection as computeMetrics (first of equal values wins).
  let dom = coll[0]
  for (const c of coll) {
    if (value(c.amount, c.oraclePriceUsd) > value(dom.amount, dom.oraclePriceUsd)) dom = c
  }
  const Wm = value(dom.amount, dom.oraclePriceUsd) * dom.liquidationThreshold
  return {
    unit: { kind: 'usd' },
    direction: 'fall',
    symbol: dom.symbol,
    priceNow: dom.oraclePriceUsd,
    W,
    Wm,
    D,
    Dm: 0,
    moving: [dom.symbol],
    held: uniq([
      ...coll.filter((c) => c !== dom && nameC(c.symbol)).map((c) => c.symbol),
      ...debt.filter((d) => nameD(d.symbol)).map((d) => d.symbol),
    ]),
  }
}

const uniq = (xs: string[]) => [...new Set(xs)]

/**
 * Fraction the moving price can change before health factor reaches 1, measured from now.
 * ≤ 0: already at or past the line. Infinity: no debt, or the move never reaches the line.
 */
export function lineDistance(m: Pick<LineModel, 'direction' | 'W' | 'Wm' | 'D' | 'Dm'>): number {
  if (!(m.D > 0)) return Number.POSITIVE_INFINITY
  const B = m.W - m.D
  const E = m.direction === 'fall' ? m.Wm - m.Dm : m.Dm - m.Wm
  // The move never pushes toward the line: past it already (0) or never reaching it.
  if (!(E > 0)) return B <= 0 ? 0 : Number.POSITIVE_INFINITY
  return B / E
}

// ------------------------------------------------------------------ hero

export type Hero =
  | { kind: 'no-debt' }
  /**
   * The legs do not reproduce the protocol's thresholds (snapshot.ts checkSplit): there is
   * no per-asset line to draw, only the protocol's own health factor.
   */
  | { kind: 'unsplit'; healthFactor: number; reason: string }
  | {
      kind: 'past'
      symbol: string
      direction: Direction
      priceNow: number
      /** Health factor from the legs (≤ 1). */
      healthFactor: number
    }
  | {
      /** A fall that would need the price to reach $0 or below: no price reaches the line. */
      kind: 'unreachable'
      symbol: string
      direction: Direction
      priceNow: number
    }
  | {
      kind: 'line'
      /** Dollars of `symbol`, or the base/quote price ratio. */
      unit: LineUnit
      symbol: string
      direction: Direction
      priceNow: number
      /** Exact line price. */
      priceLine: number
      /** Rounded toward risk (toward now) at `decimals`. */
      priceShown: number
      decimals: number
      /** Exact fraction from now. */
      distance: number
      /** Whole percent, floored. 0 means under 1%. */
      distancePct: number
    }

/** At least four significant figures, never fewer than 0 decimals. */
export function priceDecimals(price: number): number {
  if (!(price > 0)) return 2
  return Math.min(8, Math.max(0, 3 - Math.floor(Math.log10(price))))
}

/** Rounds a line price toward now: up for a fall risk, down for a rise risk. */
export function roundTowardRisk(price: number, direction: Direction, decimals = priceDecimals(price)): number {
  const f = 10 ** decimals
  const scaled = price * f
  const r = direction === 'fall' ? Math.ceil(scaled - 1e-7) : Math.floor(scaled + 1e-7)
  return r / f
}

export function heroOf(m: LineModel | null): Hero {
  if (!m || !(m.D > 0)) return { kind: 'no-debt' }
  const x = lineDistance(m)
  if (x <= 0) {
    return {
      kind: 'past',
      symbol: m.symbol,
      direction: m.direction,
      priceNow: m.priceNow,
      healthFactor: m.W / m.D,
    }
  }
  if (!Number.isFinite(x) || (m.direction === 'fall' && x >= 1)) {
    return { kind: 'unreachable', symbol: m.symbol, direction: m.direction, priceNow: m.priceNow }
  }
  const priceLine = m.direction === 'fall' ? m.priceNow * (1 - x) : m.priceNow * (1 + x)
  const decimals = priceDecimals(priceLine)
  return {
    kind: 'line',
    unit: m.unit,
    symbol: m.symbol,
    direction: m.direction,
    priceNow: m.priceNow,
    priceLine,
    priceShown: roundTowardRisk(priceLine, m.direction, decimals),
    decimals,
    distance: x,
    distancePct: floorPct(x),
  }
}
