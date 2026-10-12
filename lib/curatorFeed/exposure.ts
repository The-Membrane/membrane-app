/**
 * Allocation exposure: which vaults / curators hold which collateral markets. Pure.
 *
 * The snapshot (collector, head block) is per vault → allocations. This module pivots
 * it to collateral → vaults and curator → collateral, and computes Morpho Blue supply
 * assets from shares the same way the contract does (SharesMathLib.toAssetsDown with
 * VIRTUAL_SHARES = 1e6, VIRTUAL_ASSETS = 1).
 *
 * Supply in a market whose supply is locked (flags.ts flag 5) is book value: it is kept
 * apart from live supply (`lockedUsd`), so a market that reads $9.9B on $7.4M of lent
 * principal does not rank the collateral or the vault.
 */

import type { ExposureVault, Protocol } from './types'

export const VIRTUAL_SHARES = 10n ** 6n
export const VIRTUAL_ASSETS = 1n

/** Morpho Blue SharesMathLib.toAssetsDown. */
export const toAssetsDown = (shares: bigint, totalAssets: bigint, totalShares: bigint): bigint =>
  (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES)

const WAD = 10n ** 18n

/** Morpho Blue MathLib.wTaylorCompounded: e^(x·n) − 1, three terms, WAD. */
export function wTaylorCompounded(x: bigint, n: bigint): bigint {
  const first = x * n
  const second = (first * first) / (2n * WAD)
  const third = (second * first) / (3n * WAD)
  return first + second + third
}

/**
 * market() as Morpho Blue would return it after accruing interest to `now` (its
 * _accrueInterest; MorphoBalancesLib.expectedMarketBalances): `w` is market()'s six words
 * (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate,
 * fee), `ratePerSec` the IRM's borrowRateView at the same block. MetaMorpho's totalAssets()
 * counts supply this way, so allocations read from stored totals fall short of it by the
 * interest since lastUpdate: $9M in Adpend USDC on 2026-10-11, in a market at 800 %/yr
 * last touched 19 h earlier.
 */
export function accrueMarket(w: bigint[], ratePerSec: bigint, now: number): bigint[] {
  const [supply, supplyShares, borrow, borrowShares, lastUpdate, fee] = w
  const elapsed = BigInt(now) - lastUpdate
  if (elapsed <= 0n || borrow === 0n) return w
  const interest = (borrow * wTaylorCompounded(ratePerSec, elapsed)) / WAD
  const s = supply + interest
  let ss = supplyShares
  if (fee !== 0n) {
    const feeAmount = (interest * fee) / WAD
    ss += (feeAmount * (supplyShares + VIRTUAL_SHARES)) / (s - feeAmount + VIRTUAL_ASSETS)
  }
  return [s, ss, borrow + interest, borrowShares, BigInt(now), fee]
}

export interface CollateralHolder {
  vault: string
  protocol: Protocol
  curator: string
  /** Loan-token base units, and the loan token, so mixed loan assets stay separate. */
  assets: string
  loan: string
  usd?: number
  /** Part of `usd` in markets whose supply is locked (book value). */
  lockedUsd?: number
  /** Fraction of the holder vault's total assets in this collateral, 0–1. */
  shareOfVault: number
}

export interface CollateralRow {
  collateral: string
  /** Sum of `usd` over holders that have a price (collection-time), book value excluded. */
  usd: number
  /** Sum of holders' `lockedUsd`: supply in markets whose supply is locked. */
  lockedUsd: number
  /** Holders with no USD price — their size is in `assets` only. */
  unpriced: number
  curators: string[]
  holders: CollateralHolder[]
}

/** collateral → holders, largest first. Idle (no collateral) is keyed '' and skipped. */
export function byCollateral(
  vaults: ExposureVault[],
  curatorOf: (vault: string) => string,
  loanOf: (vault: string) => string,
  opts: { minShare?: number; includeIdle?: boolean; isLocked?: (target: string) => boolean } = {},
): CollateralRow[] {
  const rows = new Map<string, CollateralRow>()
  for (const v of vaults) {
    // Several allocations of one vault can share a collateral (e.g. two LLTVs).
    const agg = new Map<
      string,
      { assets: bigint; usd?: number; lockedUsd?: number; share: number }
    >()
    for (const a of v.allocations) {
      const keys = a.collateral.length ? a.collateral : opts.includeIdle ? [''] : []
      // A multi-collateral Euler strategy appears under each of its collaterals; its
      // share is not split (the strategy's book decides that, not the vault).
      for (const c of keys) {
        const cur = agg.get(c) ?? { assets: 0n, usd: undefined, share: 0 }
        cur.assets += BigInt(a.assets)
        if (a.usd !== undefined) cur.usd = (cur.usd ?? 0) + a.usd
        if (a.usd !== undefined && opts.isLocked?.(a.target))
          cur.lockedUsd = (cur.lockedUsd ?? 0) + a.usd
        cur.share += a.share
        agg.set(c, cur)
      }
    }
    for (const [c, x] of agg) {
      if (x.share < (opts.minShare ?? 0)) continue
      const row = rows.get(c) ?? {
        collateral: c,
        usd: 0,
        lockedUsd: 0,
        unpriced: 0,
        curators: [],
        holders: [],
      }
      row.holders.push({
        vault: v.vault,
        protocol: v.protocol,
        curator: curatorOf(v.vault),
        assets: x.assets.toString(),
        loan: loanOf(v.vault),
        usd: x.usd,
        ...(x.lockedUsd !== undefined ? { lockedUsd: x.lockedUsd } : {}),
        shareOfVault: Math.min(1, x.share),
      })
      if (x.usd !== undefined) {
        row.usd += x.usd - (x.lockedUsd ?? 0)
        row.lockedUsd += x.lockedUsd ?? 0
      } else row.unpriced++
      rows.set(c, row)
    }
  }
  const live = (h: CollateralHolder) => (h.usd ?? 0) - (h.lockedUsd ?? 0)
  for (const r of rows.values()) {
    r.holders.sort(
      (a, b) => live(b) - live(a) || (b.usd ?? 0) - (a.usd ?? 0) || b.shareOfVault - a.shareOfVault,
    )
    r.curators = [...new Set(r.holders.map((h) => h.curator))]
  }
  return [...rows.values()].sort((a, b) => b.usd - a.usd || b.lockedUsd - a.lockedUsd)
}

export interface CuratorRow {
  curator: string
  vaults: number
  usd: number
  /** collateral → USD held across this curator's vaults. */
  collateral: Record<string, number>
}

export function byCurator(
  vaults: ExposureVault[],
  curatorOf: (vault: string) => string,
): CuratorRow[] {
  const m = new Map<string, CuratorRow>()
  for (const v of vaults) {
    const k = curatorOf(v.vault)
    const row = m.get(k) ?? { curator: k, vaults: 0, usd: 0, collateral: {} }
    row.vaults++
    for (const a of v.allocations) {
      if (a.usd === undefined) continue
      row.usd += a.usd
      for (const c of a.collateral) row.collateral[c] = (row.collateral[c] ?? 0) + a.usd
    }
    m.set(k, row)
  }
  return [...m.values()].sort((a, b) => b.usd - a.usd)
}
