/**
 * Client-side ranking at the selected size (the scan stores ranks at the $100K default).
 * Rank on (a); tie-breaks: (a) base-only, then history `count`, then TVL. Only a row whose
 * (a) is POSITIVE at this size gets a rank (design §1 "Positive": (a) > 0 at the ranking size;
 * the scan only checks it at $100K). A row with (a) <= 0 here, or unpriced at this size
 * ("size > 5% of TVL"), follows the ranked ones, unranked.
 */

import type { ScoutRow, SizeKey } from './types'

export function rankAtSize(
  rows: readonly ScoutRow[],
  k: SizeKey,
): { row: ScoutRow; rank: number | null }[] {
  const positive = (r: ScoutRow) => {
    const v = r.carryA[k]?.apy
    return typeof v === 'number' && Number.isFinite(v) && v > 0
  }
  const priced = rows.filter(positive)
  const unpriced = rows.filter((r) => !positive(r))
  const a = (r: ScoutRow) => r.carryA[k]?.apy ?? -Infinity
  const base = (r: ScoutRow) => r.carryABase[k]?.apy ?? -Infinity
  priced.sort(
    (x, y) => a(y) - a(x) || base(y) - base(x) || y.count - x.count || y.tvlUsd - x.tvlUsd,
  )
  return [
    ...priced.map((row, i) => ({ row, rank: i + 1 })),
    ...unpriced.map((row) => ({ row, rank: null })),
  ]
}
