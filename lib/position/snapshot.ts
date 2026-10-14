/**
 * ProtocolPosition (what an adapter read) → PositionSnapshot (what computeMetrics reads),
 * plus the asset families that decide which price history, if any, describes a position.
 *
 * THRESHOLDS FOLLOW THE PROTOCOL. An adapter's legs carry each reserve's own liquidation
 * threshold, but Aave applies e-mode at the ACCOUNT level, so a WETH/wstETH borrower in
 * the ETH-correlated category is liquidated at the category threshold, not the reserve's.
 * The adapter's aggregate (totalCollateralUsd × liquidationLtv) is authoritative because
 * it is what the protocol checks. When the legs disagree with it by more than 0.1%, every
 * leg's threshold is scaled by the same factor so the legs sum to the aggregate. That is
 * exact for a single collateral asset and an approximation when e-mode covers only some
 * legs; the snapshot says so (`thresholdsScaled`) and the page prints it.
 */

import type { CollateralInput, DebtInput, PositionSnapshot } from '@/lib/positionAlerts/types'
import type { ProtocolPosition } from '@/lib/position-sim/types'

import type { HistoryAsset } from './touchHistory'

// ------------------------------------------------------------------ families

/** Assets priced, for history purposes, on the ETH/USD series. LSTs and LRTs included:
 *  their USD price is an exchange rate times ETH/USD. Lowercased. */
const ETH_FAMILY = new Set(
  [
    'ETH', 'WETH', 'stETH', 'wstETH', 'weETH', 'eETH', 'rETH', 'cbETH', 'osETH', 'ezETH',
    'rsETH', 'ETHx', 'sfrxETH', 'frxETH', 'mETH', 'cmETH', 'swETH', 'rswETH', 'pufETH',
    'OETH', 'wOETH', 'tETH', 'LsETH', 'ankrETH', 'wBETH', 'ETH+',
  ].map((s) => s.toLowerCase()),
)

/** Assets priced, for history purposes, on the BTC/USD series. Lowercased. */
const BTC_FAMILY = new Set(
  [
    'BTC', 'WBTC', 'cbBTC', 'tBTC', 'LBTC', 'FBTC', 'eBTC', 'SolvBTC', 'xSolvBTC', 'uniBTC',
    'pumpBTC', 'BTCB', 'enzoBTC', 'lBTC',
  ].map((s) => s.toLowerCase()),
)

/** USD stablecoins and their savings wrappers. Their price is not ETH or BTC history,
 *  and none of them has a history series here. Euro stables (EURC, EURCV) are NOT here:
 *  they carry FX risk against USD debt, so they classify as 'other'. Lowercased. */
const USD_STABLES = new Set(
  [
    'USDC', 'USDT', 'DAI', 'USDS', 'sDAI', 'sUSDS', 'USDe', 'sUSDe', 'GHO', 'sGHO', 'PYUSD',
    'FRAX', 'sFRAX', 'frxUSD', 'sfrxUSD', 'crvUSD', 'scrvUSD', 'LUSD', 'USDtb', 'RLUSD',
    'USD0', 'USD0++', 'USDM', 'wUSDM', 'USDA', 'USR', 'wstUSR', 'DOLA', 'sDOLA', 'USDf',
    'sUSDf', 'USDL', 'syrupUSDC', 'syrupUSDT', 'USDQ', 'BOLD', 'FDUSD', 'TUSD', 'USDP',
    'GUSD',
  ].map((s) => s.toLowerCase()),
)

export type AssetClass = HistoryAsset | 'stable' | 'other'

export function assetClassOf(symbol: string): AssetClass {
  const s = symbol.trim().toLowerCase()
  if (ETH_FAMILY.has(s)) return 'ETH'
  if (BTC_FAMILY.has(s)) return 'BTC'
  if (USD_STABLES.has(s)) return 'stable'
  return 'other'
}

/** The history series an asset is priced on, or null (stables, unknown symbols). */
export function historyAssetFor(symbol: string): HistoryAsset | null {
  const c = assetClassOf(symbol)
  return c === 'ETH' || c === 'BTC' ? c : null
}

export const isUsdStable = (symbol: string): boolean => assetClassOf(symbol) === 'stable'

/** How the page labels a leg priced on a history series. */
export const HISTORY_LABEL: Record<HistoryAsset, string> = {
  ETH: 'priced on ETH/USD history',
  BTC: 'priced on BTC/USD history',
}

// ------------------------------------------------------------------ snapshot

/** Legs within this relative gap of the protocol's aggregate are used as read. */
export const THRESHOLD_TOLERANCE = 1e-3

export interface MappedSnapshot {
  snapshot: PositionSnapshot
  /** Factor applied to every leg threshold (1 when the legs already matched). */
  thresholdScale: number
  /** True when the legs disagreed with the protocol aggregate and were scaled. */
  thresholdsScaled: boolean
}

/** Σ amount × price × LT over the adapter's own legs. */
const legsWeighted = (p: ProtocolPosition): number =>
  p.collateral.reduce((s, c) => s + c.amount * c.priceUsd * c.liquidationThreshold, 0)

/**
 * Pure mapper. `ts` is epoch SECONDS (the positionAlerts convention) and defaults to the
 * adapter's own read time.
 */
export function toSnapshot(p: ProtocolPosition, ts?: number): MappedSnapshot {
  const fromLegs = legsWeighted(p)
  const aggregate = p.totalCollateralUsd * p.liquidationLtv
  let scale = 1
  if (fromLegs > 0 && aggregate > 0 && Math.abs(aggregate / fromLegs - 1) > THRESHOLD_TOLERANCE) {
    scale = aggregate / fromLegs
  }
  const collateral: CollateralInput[] = p.collateral
    .filter((c) => c.amount > 0)
    .map((c) => ({
      symbol: c.symbol,
      amount: c.amount,
      oraclePriceUsd: c.priceUsd,
      liquidationThreshold: Math.min(1, c.liquidationThreshold * scale),
    }))
  const debt: DebtInput[] = p.debt
    .filter((d) => d.amount > 0)
    .map((d) => ({ symbol: d.symbol, amount: d.amount, priceUsd: d.priceUsd }))
  return {
    snapshot: {
      id: `${p.protocol}:${p.marketId ?? p.label}`,
      ts: Math.floor(ts ?? p.provenance.at / 1000),
      venue: p.label,
      collateral,
      debt,
    },
    thresholdScale: scale,
    thresholdsScaled: scale !== 1,
  }
}
