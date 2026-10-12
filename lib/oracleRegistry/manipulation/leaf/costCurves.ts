/**
 * Build the cost side for a leaf: the per-direction impact curves and the free moves,
 * dispatched on the leaf kind. The ratio stage consumes the result directly.
 *
 *  pendle-market → Pendle AMM curves (up/down), TWAP window from the leaf meta.
 *  univ3-pool    → tick-walk curves from on-chain liquidityNet.
 *  curve-pool    → get_dy curves (needs the priced coin pair + USD, from the seed).
 *  erc4626-vault → donation curve up IF the vault tracks its asset balance.
 *  curve-lp      → hard-red (read-only reentrancy), no cost curve.
 *  push-feed     → deviation-band free move (threshold from the directory).
 *  pull-feed     → pull-selection free move (staleness window × volatility).
 *  linear-discount / fixed / unknown → inert.
 */

import type { CostCurves } from '../ratio'
import type { FreeMove, Leaf } from '../types'
import type { BlockTag, Rpc } from '../chain/rpc'
import type { UsdPrices } from '../chain/directory'
import { readPendleMarket, pendleImpactCurve, withoutLp } from '../cost/pendle'
import { readV3Pool, v3ImpactCurve } from '../cost/univ3'
import { readCurvePool, curveImpactCurve, curveEmaHalfLife } from '../cost/curve'
import { readVault, donationCurve } from '../cost/vault'
import { deviationBand, pullSelection, clampMove, DEFAULT_VOL } from '../cost/freeMoves'

export interface CostResult {
  cost: CostCurves
  freeMoves: FreeMove[]
  hardRed: { reason: string } | null
  /** Extra per-leaf facts for the JSON (pool size, vault class, EMA half-life, …). */
  facts: Record<string, string | number | boolean | null>
  notes: string[]
}

const empty = (): CostResult => ({ cost: { full: {} }, freeMoves: [], hardRed: null, facts: {}, notes: [] })

export async function buildCostSide(
  rpc: Rpc,
  leaf: Leaf,
  block: BlockTag,
  prices: UsdPrices,
  opts: { volClass?: keyof typeof DEFAULT_VOL; pullStalenessSec?: number; curvePair?: { i: number; j: number } } = {},
): Promise<CostResult> {
  switch (leaf.kind) {
    case 'pendle-market':
      return pendleCost(rpc, leaf, block, prices)
    case 'univ3-pool':
      return univ3Cost(rpc, leaf, block, prices)
    case 'curve-pool':
      return curveCost(rpc, leaf, block, prices, opts.curvePair)
    case 'curve-lp':
      return { ...empty(), hardRed: { reason: `Curve LP share price (get_virtual_price) at ${leaf.address} — read-only reentrancy surface` }, notes: ['read-only reentrancy: hard-red per owner ruling'] }
    case 'erc4626-vault':
      return vaultCost(rpc, leaf, block, prices)
    case 'push-feed':
      return feedCost(leaf)
    case 'pull-feed':
      return pullCost(leaf, opts)
    default:
      return { ...empty(), notes: [`${leaf.kind}: treated as non-manipulable (no on-chain trade moves it)`] }
  }
}

async function pendleCost(rpc: Rpc, leaf: Leaf, block: BlockTag, prices: UsdPrices): Promise<CostResult> {
  const info = await readPendleMarket(rpc, leaf.address, block)
  if (info.state.expiry <= info.state.now) {
    return { ...empty(), facts: { asset: info.asset, expiry: info.state.expiry, expired: true }, notes: ['Pendle market has expired: PT redeems 1:1, the AMM no longer prices it, no cost curve'] }
  }
  const assetUsd = prices.get(info.asset, 1)
  const full = { up: pendleImpactCurve(info.state, 'up', assetUsd), down: pendleImpactCurve(info.state, 'down', assetUsd) }
  // top-k LP removal: the attacker withdraws half the LP first (a large LP's share),
  // which thins the AMM and lowers the move cost. Modelled as a 50% LP withdrawal.
  const thin = withoutLp(info.state, 0.5)
  const topKRemoved = { up: pendleImpactCurve(thin, 'up', assetUsd, 'Pendle with 50% of LP withdrawn'), down: pendleImpactCurve(thin, 'down', assetUsd, 'Pendle with 50% of LP withdrawn') }
  return {
    cost: { full, topKRemoved },
    freeMoves: [],
    hardRed: null,
    facts: {
      asset: info.asset,
      assetUsd,
      totalPt: info.state.totalPt / Math.pow(10, info.assetDecimals),
      totalAssetUsd: (info.state.totalSy * info.state.pyIndex * assetUsd) / Math.pow(10, info.assetDecimals),
      twapWindowSec: Number(leaf.meta.twapDuration ?? 0),
      twapCardinalityOk: info.cardinality * 12 >= Number(leaf.meta.twapDuration ?? 0),
      expiry: info.state.expiry,
    },
    notes: ['Pendle cost is AMM-only; limit orders add depth and would raise the true cost'],
  }
}

async function univ3Cost(rpc: Rpc, leaf: Leaf, block: BlockTag, prices: UsdPrices): Promise<CostResult> {
  const info = await readV3Pool(rpc, leaf.address, block)
  const usd0 = prices.get(info.token0, 0)
  const usd1 = prices.get(info.token1, 0)
  if (usd0 <= 0 || usd1 <= 0) return { ...empty(), notes: [`univ3 ${leaf.address}: missing USD price for a pool token; cost not computed`] }
  const full = { up: v3ImpactCurve(info.state, 'up', usd0, usd1), down: v3ImpactCurve(info.state, 'down', usd0, usd1) }
  return {
    cost: { full },
    freeMoves: [],
    hardRed: null,
    facts: { token0: info.token0, token1: info.token1, fee: info.state.fee, tick: info.state.tick, initializedTicks: info.state.ticks.length },
    notes: ['top-k LP removal for v3 needs position (mint) data; not modelled in v1'],
  }
}

async function curveCost(rpc: Rpc, leaf: Leaf, block: BlockTag, prices: UsdPrices, pair?: { i: number; j: number }): Promise<CostResult> {
  const info = await readCurvePool(rpc, leaf.address, block)
  const i = pair?.i ?? 0
  const j = pair?.j ?? 1
  const usdI = prices.get(info.coins[i], 0)
  const usdJ = prices.get(info.coins[j], 0)
  if (usdI <= 0 || usdJ <= 0) return { ...empty(), notes: [`curve ${leaf.address}: missing USD price for coin ${i} or ${j}; cost not computed`] }
  const down = await curveImpactCurve(rpc, info, i, j, 'down', block, usdI, usdJ)
  const up = await curveImpactCurve(rpc, info, i, j, 'up', block, usdI, usdJ)
  const emaHalf = curveEmaHalfLife(info)
  return {
    cost: { full: { up, down } },
    freeMoves: [],
    hardRed: null,
    facts: { coins: info.coins.join(','), feeRate: info.feeRate, emaHalfLifeSec: emaHalf, hasPriceOracle: info.hasPriceOracle, virtualPrice: info.virtualPrice },
    notes: info.hasPriceOracle ? [`Curve EMA price_oracle present (half-life ≈ ${emaHalf?.toFixed(0)}s); a reader using price_oracle sees an EMA, not spot`] : [],
  }
}

async function vaultCost(rpc: Rpc, leaf: Leaf, block: BlockTag, prices: UsdPrices): Promise<CostResult> {
  const info = await readVault(rpc, leaf.address, block)
  const notes: string[] = []
  const facts: Record<string, string | number | boolean | null> = { class: info.cls, asset: info.asset, totalAssets: info.totalAssets ? Number(info.totalAssets) : null }
  if (info.cls !== 'balance-tracking') {
    notes.push(`vault ${leaf.address}: ${info.cls} accounting; a share-rate donation does not move it`)
    return { ...empty(), facts, notes }
  }
  const assetUsd = info.asset ? prices.get(info.asset, 1) : 1
  const taUsd = info.totalAssets ? (Number(info.totalAssets) / Math.pow(10, info.assetDecimals)) * assetUsd : 0
  facts.totalAssetsUsd = taUsd
  notes.push('balance-tracking vault: donation raises the share rate; CANDIDATE — confirm against source before a public claim (README gaps)')
  return { cost: { full: { up: donationCurve(taUsd) } }, freeMoves: [], hardRed: null, facts, notes }
}

function feedCost(leaf: Leaf): CostResult {
  const dev = leaf.meta.deviationPct as number | null
  const min = leaf.meta.minAnswer as number | null
  const max = leaf.meta.maxAnswer as number | null
  const moves: FreeMove[] = []
  const notes: string[] = []
  if (dev) {
    const fm = deviationBand(dev, leaf.label)
    if (fm) moves.push(fm)
  } else {
    notes.push(`push-feed ${leaf.address}: deviation threshold unknown (not in the directory); free move not quantified`)
  }
  if (min !== null || max !== null) {
    const { move } = clampMove(1, min, max, leaf.label) // value normalised; bound detection is relative
    if (move) moves.push(move)
  }
  return { cost: { full: {} }, freeMoves: moves, hardRed: null, facts: { deviationPct: dev, minAnswer: min, maxAnswer: max }, notes }
}

function pullCost(leaf: Leaf, opts: { volClass?: keyof typeof DEFAULT_VOL; pullStalenessSec?: number }): CostResult {
  if (leaf.meta.deterministic) {
    return { ...empty(), facts: { vendor: leaf.meta.vendor ?? null, deterministic: true }, notes: [`${leaf.meta.vendor} fundamental/NAV feed: not moved by a market trade`] }
  }
  const staleness = opts.pullStalenessSec ?? 60
  const vol = DEFAULT_VOL[opts.volClass ?? 'major']
  const fm = pullSelection(staleness, vol, leaf.label)
  return {
    cost: { full: {} },
    freeMoves: fm ? [fm] : [],
    hardRed: null,
    facts: { vendor: leaf.meta.vendor ?? null, assumedStalenessSec: staleness, assumedVol: vol },
    notes: [`${leaf.meta.vendor} pull feed: free move = caller-chosen price within the staleness window (assumed ${staleness}s, vol ${(vol * 100).toFixed(0)}%/yr)`],
  }
}
