/**
 * venueStressRules — the reading rules shared by the venue stress-history BUILDER
 * (scripts/position-sim/build-venue-stress-history.mjs) and the analog module
 * (venueStressAnalogs.ts). One implementation, so the episodes the builder publishes and the
 * windows the analogs re-derive cannot drift apart. Pure and import-free.
 *
 *  withdrawableFraction  f = cash / supply in [0, 1]; a PAUSED reserve (flags bit2) is 0;
 *                        unknown is null, never 0.
 *  utilClusters          a venue's stress EPISODES: readings at util = 1 − f ≥ its stress
 *                        level on a material supply, clustered while ≤ 72 h apart — after
 *                        dropping TRANSIENTS (below).
 *  metaMorphoCash        a MetaMorpho vault's cash two ways: first in line (MetaMorpho's own
 *                        maxWithdraw walk) and its PRO-RATA share of each market's idle cash.
 *
 * TRANSIENTS (review 2026-10-07, CONFIRMED-BUG: the daily drain). Aave Core USDC's cash goes to
 * ~0 for ~40 minutes around 00:00 UTC on most days of Q4-2024 and May-Oct 2026 (one supplier
 * withdraws every idle dollar and re-supplies; debt unchanged; re-read block by block on
 * 2026-10-06: 128.6M at 23:17, 37k at 23:37, 128.8M at 00:08). The 00:00 reading lands inside
 * the dip. Counted as stress, one such reading a day kept a 72 h-gap episode open for
 * months (2026-05-08 → 10-07, 3,649 h; 146 of its 162 stressed readings at 00 UTC). A stressed
 * reading is a TRANSIENT when the reading exactly one hour later is KNOWN and not stressed,
 * and the reading exactly one hour earlier is not stressed: one hourly reading, gone the next.
 * It is not a trigger — the mirror of the analogs' 'held' basis, where a dip that lasts one
 * hourly reading does not set the minimum because the keeper retries an hour later. A
 * stressed reading with no reading an hour later (a coarser grid, the data's end) is not a
 * transient: it cannot be told apart, so it counts.
 */

const HOUR = 3600
const PAUSED_BIT = 4

/** Stressed readings this close (hours) belong to one episode. */
export const UTIL_EPISODE_GAP_H = 72

/** The confirmation step: a stressed reading the reading this much later clears is a transient. */
export const TRANSIENT_CONFIRM_H = 1

/**
 * f = cash / supply, in [0, 1]. A paused reserve is 0. Unknown (missing, non-finite,
 * negative cash, supply ≤ 0) is null — never 0.
 */
export function withdrawableFraction(
  cash: number | null | undefined,
  supply: number | null | undefined,
  flags?: number | null,
): number | null {
  if (flags != null && (flags & PAUSED_BIT) !== 0) return 0
  if (cash == null || supply == null) return null
  if (!Number.isFinite(cash) || !Number.isFinite(supply) || cash < 0 || supply <= 0) return null
  return Math.min(1, cash / supply)
}

/** One venue's readings, the fields the util rule reads. */
export interface UtilSeries {
  /** Reading times, unix seconds, strictly ascending. */
  t: readonly number[]
  cash: readonly (number | null)[]
  supply: readonly (number | null)[]
  flags?: readonly (number | null)[]
  /** Supply (token units) under which a reading is not material. */
  minSize?: number
}

export interface UtilCluster {
  /** First and last counted stressed reading (unix s). */
  first: number
  last: number
  /** Counted stressed readings. */
  n: number
  /** Highest util among them, and when. */
  peak: number
  peakAt: number
}

export interface UtilClusterResult {
  clusters: UtilCluster[]
  /** Times (unix s) of the stressed readings dropped as transients. */
  transients: number[]
}

/** Per reading: stressed (util ≥ level on a material supply) and transient (module header). */
export function stressFlags(
  s: UtilSeries,
  stressUtil: number,
): { stressed: boolean[]; transient: boolean[]; util: (number | null)[] } {
  if (!(stressUtil > 0 && stressUtil <= 1))
    throw new Error(`venueStressRules: stressUtil ${stressUtil} outside (0, 1]`)
  const n = s.t.length
  const util: (number | null)[] = new Array(n)
  const stressed: boolean[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const f = withdrawableFraction(s.cash[i], s.supply[i], s.flags?.[i])
    util[i] = f === null ? null : 1 - f
    const material = s.minSize === undefined || (s.supply[i] ?? -Infinity) >= s.minSize
    stressed[i] = f !== null && 1 - f >= stressUtil && material
  }
  const step = TRANSIENT_CONFIRM_H * HOUR
  const transient: boolean[] = new Array(n).fill(false)
  for (let i = 0; i < n; i++) {
    if (!stressed[i]) continue
    const next = i + 1 < n && s.t[i + 1] - s.t[i] === step ? i + 1 : -1
    if (next < 0 || util[next] === null || stressed[next]) continue
    const prevStressed = i > 0 && s.t[i] - s.t[i - 1] === step && stressed[i - 1]
    if (!prevStressed) transient[i] = true
  }
  return { stressed, transient, util }
}

/**
 * The stress episodes of one venue: stressed, non-transient readings, clustered while
 * consecutive ones are ≤ UTIL_EPISODE_GAP_H apart.
 */
export function utilClusters(s: UtilSeries, stressUtil: number): UtilClusterResult {
  for (let i = 1; i < s.t.length; i++)
    if (!(s.t[i] > s.t[i - 1])) throw new Error(`venueStressRules: t not ascending at ${i}`)
  const { stressed, transient, util } = stressFlags(s, stressUtil)
  const clusters: UtilCluster[] = []
  const transients: number[] = []
  for (let i = 0; i < s.t.length; i++) {
    if (!stressed[i]) continue
    if (transient[i]) {
      transients.push(s.t[i])
      continue
    }
    const u = util[i] as number
    const c = clusters[clusters.length - 1]
    if (c && s.t[i] - c.last <= UTIL_EPISODE_GAP_H * HOUR) {
      c.last = s.t[i]
      c.n++
      if (u > c.peak) {
        c.peak = u
        c.peakAt = s.t[i]
      }
    } else clusters.push({ first: s.t[i], last: s.t[i], n: 1, peak: u, peakAt: s.t[i] })
  }
  return { clusters, transients }
}

/** One Morpho Blue market as a MetaMorpho vault sees it (asset units, raw). */
export interface MorphoMarketShare {
  /** The vault's supply in the market, in assets. */
  owned: bigint
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
}

/**
 * A MetaMorpho vault's withdrawable cash over its withdraw-queue markets.
 *   liquid   Σ min(owned, idle): the vault FIRST IN LINE in every market (MetaMorpho's own
 *            maxWithdraw walk, without accruing interest since each market's last update).
 *   proRata  Σ owned × idle / totalSupplyAssets: the vault's PRO-RATA share of each market's
 *            idle cash when every supplier of the market exits at once — the same race the
 *            Aave/Spark figure (pool cash / pool supply) assumes. Never above `liquid`.
 *   idle = totalSupplyAssets − totalBorrowAssets (≥ 0).
 */
export function metaMorphoCash(markets: readonly MorphoMarketShare[]): {
  liquid: bigint
  proRata: bigint
} {
  let liquid = 0n
  let proRata = 0n
  for (const m of markets) {
    const idle =
      m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0n
    const first = m.owned < idle ? m.owned : idle
    liquid += first
    if (m.totalSupplyAssets > 0n) {
      const share = (m.owned * idle) / m.totalSupplyAssets
      proRata += share < first ? share : first
    }
  }
  return { liquid, proRata }
}
