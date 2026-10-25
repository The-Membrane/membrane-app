/**
 * ProtocolPosition (what an adapter read) → PositionSnapshot (what computeMetrics reads),
 * plus the asset families that decide which price history, if any, describes a position.
 *
 * THRESHOLDS MUST SPLIT EXACTLY. The line is computed per leg, so each leg must carry the
 * threshold the protocol actually applies to it (the Aave/Spark adapter reads e-mode per
 * asset). The mapper never rescales a leg to make sums agree: it CHECKS that the legs
 * reproduce the protocol's own aggregate threshold and health factor within
 * SPLIT_TOLERANCE, and when they do not, the page shows the protocol's health factor and
 * says the thresholds could not be split per asset — no line, no levers, no fake numbers.
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

/** The legs must reproduce the protocol's aggregate and health factor within this. */
export const SPLIT_TOLERANCE = 0.005

export interface ThresholdSplit {
  ok: boolean
  /** Σ amount·price·LT / debt from the legs; Infinity with no debt. */
  legsHealthFactor: number
  /** What the protocol reports. */
  protocolHealthFactor: number
  /** Why the split failed, for the panel. Null when ok. */
  reason: string | null
}

export interface MappedSnapshot {
  snapshot: PositionSnapshot
  split: ThresholdSplit
}

/** Σ amount × price × LT over the adapter's own legs. */
const legsWeighted = (p: ProtocolPosition): number =>
  p.collateral.reduce((s, c) => s + c.amount * c.priceUsd * c.liquidationThreshold, 0)

const off = (a: number, b: number) => Math.abs(a / b - 1) > SPLIT_TOLERANCE

/** Do the legs reproduce what the protocol says? Pure; see the header. */
export function checkSplit(p: ProtocolPosition): ThresholdSplit {
  const fromLegs = legsWeighted(p)
  const debt = p.debt.reduce((s, d) => s + d.amount * d.priceUsd, 0)
  const aggregate = p.totalCollateralUsd * p.liquidationLtv
  const legsHealthFactor = debt > 0 ? fromLegs / debt : Number.POSITIVE_INFINITY
  const out = (reason: string | null): ThresholdSplit => ({
    ok: reason === null,
    legsHealthFactor,
    protocolHealthFactor: p.healthFactor,
    reason,
  })
  if (p.collateral.some((c) => !(c.liquidationThreshold >= 0 && c.liquidationThreshold <= 1))) {
    return out('a leg threshold is outside 0–100%')
  }
  if (aggregate > 0 && !(fromLegs > 0)) return out('the legs carry no threshold the protocol applies')
  if (aggregate > 0 && off(fromLegs, aggregate)) return out('the legs do not sum to the protocol threshold')
  if (debt > 0 && Number.isFinite(p.healthFactor) && p.healthFactor > 0 && off(legsHealthFactor, p.healthFactor)) {
    return out('the legs do not reproduce the protocol health factor')
  }
  return out(null)
}

/**
 * Pure mapper. `ts` is epoch SECONDS (the positionAlerts convention) and defaults to the
 * adapter's own read time. Legs are mapped as read; `split` says whether they can be used.
 */
export function toSnapshot(p: ProtocolPosition, ts?: number): MappedSnapshot {
  const collateral: CollateralInput[] = p.collateral
    .filter((c) => c.amount > 0)
    .map((c) => ({
      symbol: c.symbol,
      amount: c.amount,
      oraclePriceUsd: c.priceUsd,
      liquidationThreshold: c.liquidationThreshold,
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
    split: checkSplit(p),
  }
}
