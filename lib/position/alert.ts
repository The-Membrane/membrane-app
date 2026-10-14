/**
 * "Alert me at $P" (FORECAST_VISUALS.md, "Move your line"): the price the alert row
 * prefills, from the live position — halfway between the asset's price now and the price
 * at the reader's line, rounded toward risk (toward now) to three significant figures.
 *
 * The alert fires on the asset's Chainlink USD feed (lib/userAlerts: subjects asset:ETH,
 * asset:BTC), so P is in that asset's own price, not the collateral's: a wstETH position's
 * line is 18% away for wstETH and for ETH alike, but the alert is set on ETH/USD.
 */

import type { ProtocolPosition } from '@/lib/position-sim/types'

import { floorPct } from './touch'
import type { Direction, HistoryAsset } from './touchHistory'

/**
 * The token whose venue oracle price stands in for the alert asset's USD price, and the
 * symbols that already carry it in a read. Mainnet addresses as listed in
 * lib/position-sim/historyScan.ts.
 */
export const ALERT_REFERENCE: Record<HistoryAsset, { symbols: readonly string[]; token: `0x${string}`; symbol: string }> = {
  ETH: { symbols: ['WETH', 'ETH'], token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH' },
  BTC: { symbols: ['WBTC', 'BTC'], token: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC' },
}

/** The alert asset's price already in this read (its WETH / WBTC leg), or null. */
export function referencePriceFrom(p: ProtocolPosition, asset: HistoryAsset): number | null {
  const want = ALERT_REFERENCE[asset].symbols.map((s) => s.toLowerCase())
  const leg = [...p.collateral, ...p.debt].find((l) => want.includes(l.symbol.toLowerCase()) && l.priceUsd > 0)
  return leg ? leg.priceUsd : null
}

/** 10^(digits − 3): three significant figures. 1 / 10^k, not 10^−k, for exact steps. */
export function alertStep(price: number): number {
  if (!(price > 0)) throw new Error('alertStep: price must be positive')
  const e = Math.floor(Math.log10(price)) - 2
  return e >= 0 ? 10 ** e : 1 / 10 ** -e
}

export interface AlertPrefill {
  /** The prefilled alert price, rounded toward now. */
  price: number
  /** Decimals `price` carries: print it with these, so the row shows what the input holds. */
  decimals: number
  /** Whole % from now to P, floored. */
  movePct: number
  direction: Direction
}

/** 10^(e − extra): `alertStep` made `extra` digits finer. */
const finer = (step: number, extra: number): number => {
  const e = Math.round(Math.log10(step)) - extra
  return e >= 0 ? 10 ** e : 1 / 10 ** -e
}

/**
 * Halfway between now and the line. `distance` is the line's fraction from now (> 0);
 * a fall rounds P UP, a rise rounds it DOWN — both toward now — to three significant
 * figures, or finer when three would reach now or the line: P always sits strictly
 * between them, on the risk side of now. Null when there is no line ahead (past it,
 * unreachable, no debt), no live price, or no such P at up to six figures.
 */
export function alertHalfway(priceNow: number | null, distance: number, direction: Direction): AlertPrefill | null {
  if (priceNow === null || !(priceNow > 0) || !(distance > 0) || !Number.isFinite(distance)) return null
  if (direction === 'fall' && distance >= 1) return null
  const line = direction === 'fall' ? priceNow * (1 - distance) : priceNow * (1 + distance)
  const raw = direction === 'fall' ? priceNow * (1 - distance / 2) : priceNow * (1 + distance / 2)
  for (let extra = 0; extra <= 3; extra++) {
    const step = finer(alertStep(raw), extra)
    const k = direction === 'fall' ? Math.ceil(raw / step - 1e-9) : Math.floor(raw / step + 1e-9)
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9))
    const price = Number((k * step).toFixed(decimals))
    const between = direction === 'fall' ? price < priceNow && price > line : price > priceNow && price < line
    if (between) return { price, decimals, movePct: floorPct(Math.abs(price - priceNow) / priceNow), direction }
  }
  return null
}
