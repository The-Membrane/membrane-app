/**
 * Clustered exits: the same collateral asset exited by ≥ minCurators DISTINCT curators
 * inside a window. Pure.
 *
 * An exit is a cap set to 0, a submitted forced removal, or a market taken out of the
 * withdraw queue (types.ts EXIT_KINDS) — counted only when the vault kept no other open
 * cap on that collateral and it is not a PT maturity roll-off (isClusterExit). Distinct means distinct curator ENTITIES — one
 * curator running five vaults that all cut rsETH is one curator, not five. Aave
 * freezes / LTV-zero on the same asset (PROTOCOL_EXIT_KINDS) are attached to a cluster
 * as context and never counted as a curator.
 *
 * Only exits whose target maps to exactly one collateral count (a Morpho market, a V2
 * collateral/market cap). An Euler Earn strategy can accept many collaterals; its exits
 * list them but stay out of clusters, so a cluster never claims an exit that was not
 * specific to the asset.
 */

import { EXIT_KINDS, PROTOCOL_EXIT_KINDS, type ExitCluster, type FeedAction } from './types'

export interface ClusterOptions {
  windowHours: number
  minCurators: number
  /** PT maturity per collateral token (unix s); exits near or after it are routine roll-offs. */
  expiryOf?: (token: string) => number | undefined
}
export const DEFAULT_CLUSTER: ClusterOptions = { windowHours: 72, minCurators: 2 }

const H = 3600
/** An exit this close to (or after) a PT's maturity is a roll-off, not a signal. */
export const MATURITY_GRACE_S = 14 * 86_400

export const isDirectExit = (a: FeedAction): boolean =>
  EXIT_KINDS.has(a.kind) && a.collateral.length === 1 && a.protocol !== 'aave-v3'

export const nearMaturity = (
  a: FeedAction,
  expiryOf?: (token: string) => number | undefined,
): boolean => {
  const exp = expiryOf?.(a.collateral[0])
  return exp !== undefined && a.ts >= exp - MATURITY_GRACE_S
}

/**
 * Counts toward a cluster: a direct exit after which the vault had no other open cap
 * on that collateral (`stillCapped` false or unread), outside a PT's maturity roll-off.
 * A cap set to 0 on one rsETH market while another rsETH market stays capped is a
 * migration (new oracle / LLTV), and does not count.
 */
export const isClusterExit = (
  a: FeedAction,
  expiryOf?: (token: string) => number | undefined,
): boolean => isDirectExit(a) && a.stillCapped !== true && !nearMaturity(a, expiryOf)

/** Shortest span (hours) of a sub-window holding ≥ k distinct curators. */
export function tightestSpanHours(exits: { ts: number; curator: string }[], k: number): number {
  const xs = [...exits].sort((a, b) => a.ts - b.ts)
  let best = Infinity
  const count = new Map<string, number>()
  let lo = 0
  for (let hi = 0; hi < xs.length; hi++) {
    count.set(xs[hi].curator, (count.get(xs[hi].curator) ?? 0) + 1)
    while (count.size >= k) {
      best = Math.min(best, xs[hi].ts - xs[lo].ts)
      const c = count.get(xs[lo].curator)! - 1
      if (c === 0) count.delete(xs[lo].curator)
      else count.set(xs[lo].curator, c)
      lo++
    }
  }
  return best === Infinity ? Infinity : best / H
}

export function detectExitClusters(
  actions: FeedAction[],
  curatorOf: (vault: string) => string,
  opts: ClusterOptions = DEFAULT_CLUSTER,
): ExitCluster[] {
  const W = opts.windowHours * H
  const byAsset = new Map<string, FeedAction[]>()
  for (const a of actions) {
    if (!isClusterExit(a, opts.expiryOf)) continue
    const k = a.collateral[0]
    byAsset.set(k, [...(byAsset.get(k) ?? []), a])
  }
  const protocolByAsset = new Map<string, FeedAction[]>()
  for (const a of actions) {
    if (!PROTOCOL_EXIT_KINDS.has(a.kind)) continue
    for (const c of a.collateral) protocolByAsset.set(c, [...(protocolByAsset.get(c) ?? []), a])
  }

  const out: ExitCluster[] = []
  for (const [asset, list] of byAsset) {
    const xs = [...list].sort((a, b) => a.ts - b.ts || a.block - b.block)
    // Mark every exit that sits in some W-window holding ≥ minCurators distinct curators.
    const member = new Array<boolean>(xs.length).fill(false)
    let lo = 0
    const count = new Map<string, number>()
    for (let hi = 0; hi < xs.length; hi++) {
      const c = curatorOf(xs[hi].vault)
      count.set(c, (count.get(c) ?? 0) + 1)
      while (xs[hi].ts - xs[lo].ts > W) {
        const lc = curatorOf(xs[lo].vault)
        const n = count.get(lc)! - 1
        if (n === 0) count.delete(lc)
        else count.set(lc, n)
        lo++
      }
      if (count.size >= opts.minCurators) for (let i = lo; i <= hi; i++) member[i] = true
    }
    // Contiguous members (gaps ≤ W) form one cluster.
    let cur: FeedAction[] = []
    const flush = () => {
      if (cur.length === 0) return
      const curators = [...new Set(cur.map((a) => curatorOf(a.vault)))]
      if (curators.length >= opts.minCurators) {
        const start = cur[0].ts
        const end = cur[cur.length - 1].ts
        const prot = (protocolByAsset.get(asset) ?? []).filter(
          (p) => p.ts >= start - W && p.ts <= end + W,
        )
        out.push({
          collateral: asset,
          start,
          end,
          tightestHours: tightestSpanHours(
            cur.map((a) => ({ ts: a.ts, curator: curatorOf(a.vault) })),
            opts.minCurators,
          ),
          curators,
          vaults: [...new Set(cur.map((a) => a.vault))],
          actionIds: cur.map((a) => a.id),
          protocolActionIds: prot.map((p) => p.id),
        })
      }
      cur = []
    }
    for (let i = 0; i < xs.length; i++) {
      if (!member[i]) {
        flush()
        continue
      }
      if (cur.length && xs[i].ts - cur[cur.length - 1].ts > W) flush()
      cur.push(xs[i])
    }
    flush()
  }
  return out.sort((a, b) => b.end - a.end)
}

/** Every action id that belongs to some cluster (for red highlighting). */
export const clusteredIds = (clusters: ExitCluster[]): Set<string> =>
  new Set(clusters.flatMap((c) => c.actionIds))
