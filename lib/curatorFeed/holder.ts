// YOUR CURATORS THIS WEEK — the curator feed filtered to one reader's own dependencies.
// Pure: the feed file and the list of vaults the address holds (shares > 0, read on chain
// by pages/api/curator-feed/holder.ts) in; what the Today Safety block prints out.
//
// Owner ruling (Q27 round 6): only the personal version of the "curator change pings"
// ripple map ships, no global map. So the filter is: actions EMITTED BY a vault the
// address holds (a Vault V2 adapter's events already carry its parent vault), inside the
// seven days that end at the feed's newest collected block. Those are, by construction,
// changes made by the curators of the vaults the reader holds, to the markets those
// vaults lend into. Other vaults' moves on the same markets are not counted: the line
// says "by the curators of the vaults you hold".
//
// A CUT is a cap lowered, a cap set to zero, a market removed (or its removal queued),
// a market taken out of the supply queue, or a Vault V2 write-off: the feed's `exits`
// group for vaults, plus cap_cut. Everything else (raises, additions, timelock, role
// and oracle-adjacent config) is a change, not a cut.

import { actionText, curatorLabel, targetLabel, vaultLabel } from './format'
import type { FeedFile } from './store'
import type { ActionKind, FeedAction, Protocol, Scope } from './types'

export const WEEK_S = 7 * 86_400
export const LATEST_N = 3

export const CUT_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'cap_cut',
  'cap_zero',
  'removal_submit',
  'market_removed',
  'supply_queue_remove',
  'writeoff_submit',
  'writeoff',
])

export const isCut = (a: Pick<FeedAction, 'kind'>): boolean => CUT_KINDS.has(a.kind)

/** The vault protocols whose shares an address can hold (Aave is not a curated vault). */
export const CURATED: ReadonlySet<Protocol> = new Set<Protocol>([
  'morpho-v1',
  'morpho-v2',
  'euler-earn',
])

/** Every curated vault the feed knows: the addresses the holder read checks. */
export function curatedVaults(feed: Pick<FeedFile, 'entities'>): string[] {
  return Object.entries(feed.entities.vaults)
    .filter(([, v]) => CURATED.has(v.protocol))
    .map(([addr]) => addr)
    .sort()
}

/** Scopes drawn as a market dot: a market, an Euler strategy, or a V2 collateral cap (a
 *  family of markets). An adapter cap or a vault-wide setting has no market of its own. */
const DOT_SCOPES: ReadonlySet<Scope> = new Set<Scope>(['market', 'strategy', 'collateral'])

/** One market (or V2 collateral cap / strategy) a held vault's curator touched this week. */
export interface HolderTarget {
  target: string
  name: string
  /** Any of its changes this week was a cut. */
  cut: boolean
  changes: number
}

export interface HolderVault {
  vault: string
  vaultName: string
  curatorName: string
  protocol: Protocol
  /** Cuts first, then the most recently touched. */
  targets: HolderTarget[]
  /** Vault-wide changes that are not cuts (timelock, roles, adapters, adapter cap
   *  raises): no market of their own. Drawn as one bar. */
  vaultWide: number
  /** Distinct vault-level targets cut (an adapter cap cut, a write-off): filled squares. */
  vaultWideCuts: number
  /** All actions this week. */
  changes: number
  /** Distinct (vault, target) pairs with a cut this week: the filled marks. */
  cuts: number
}

export interface HolderLatest {
  id: string
  ts: number
  tx: string
  vaultName: string
  curatorName: string
  text: string
  cut: boolean
}

export interface HolderView {
  /** The window: (from, to], unix s. `to` is the feed's newest collected block time. */
  from: number
  to: number
  collectedAt: string
  /** Curated vaults the address holds (all of them, touched or not). */
  held: number
  /** Held vaults with at least one change this week, most changes first. */
  vaults: HolderVault[]
  latest: HolderLatest[]
  /** Actions this week. */
  changes: number
  /** Distinct (vault, target) pairs cut this week: equals the filled dots and squares. */
  cuts: number
}

/**
 * The reader's curators this week, or null when the address holds no curated vault the
 * feed knows (the block then prints nothing, not an empty box).
 */
export function buildHolderView(
  feed: Pick<FeedFile, 'entities' | 'actions' | 'meta'>,
  heldVaults: readonly string[],
  latestN = LATEST_N,
): HolderView | null {
  const e = feed.entities
  const held = new Set(
    heldVaults
      .map((v) => v.toLowerCase())
      .filter((v) => e.vaults[v] && CURATED.has(e.vaults[v].protocol)),
  )
  if (held.size === 0) return null
  const to = feed.meta.toTs
  const from = to - WEEK_S
  const mine = feed.actions
    .filter((a) => held.has(a.vault) && a.ts > from && a.ts <= to)
    .sort((x, y) => y.block - x.block || y.id.localeCompare(x.id))

  const byVault = new Map<string, FeedAction[]>()
  for (const a of mine) {
    const list = byVault.get(a.vault) ?? []
    list.push(a)
    byVault.set(a.vault, list)
  }
  const vaults: HolderVault[] = [...byVault.entries()].map(([vault, acts]) => {
    const targets = new Map<string, HolderTarget & { last: number }>()
    let vaultWide = 0
    // Vault-level marks cut (an adapter cap cut, a write-off with no market): one filled
    // square per distinct target, so the headline's cut count equals the filled marks.
    const vaultWideCut = new Set<string>()
    for (const a of acts) {
      if (!a.target || !DOT_SCOPES.has(a.scope)) {
        if (isCut(a)) vaultWideCut.add(a.target ?? '')
        else vaultWide++
        continue
      }
      const t = targets.get(a.target) ?? {
        target: a.target,
        name: targetLabel(e, a),
        cut: false,
        changes: 0,
        last: a.ts,
      }
      t.changes++
      t.cut = t.cut || isCut(a)
      t.last = Math.max(t.last, a.ts)
      targets.set(a.target, t)
    }
    return {
      vault,
      vaultName: vaultLabel(e, vault),
      curatorName: curatorLabel(e, vault),
      protocol: e.vaults[vault].protocol,
      targets: [...targets.values()]
        .sort(
          (x, y) =>
            Number(y.cut) - Number(x.cut) || y.last - x.last || x.target.localeCompare(y.target),
        )
        .map(({ last: _last, ...t }) => t),
      vaultWide,
      vaultWideCuts: vaultWideCut.size,
      changes: acts.length,
      cuts: [...targets.values()].filter((t) => t.cut).length + vaultWideCut.size,
    }
  })
  vaults.sort((x, y) => y.changes - x.changes || x.vaultName.localeCompare(y.vaultName))

  return {
    from,
    to,
    collectedAt: feed.meta.collectedAt,
    held: held.size,
    vaults,
    latest: mine.slice(0, latestN).map((a) => ({
      id: a.id,
      ts: a.ts,
      tx: a.tx,
      vaultName: vaultLabel(e, a.vault),
      curatorName: curatorLabel(e, a.vault),
      text: actionText(e, a),
      cut: isCut(a),
    })),
    changes: mine.length,
    cuts: vaults.reduce((n, v) => n + v.cuts, 0),
  }
}

// ── the holdings read: what counts as held, and when the read is trustworthy ─────

/** Below this a holding is dust and does not count as held (alertLogic DUST_USD, $1). */
export const DUST_USD = 1
/** With no price: shares below this fraction of one whole share are dust. */
export const DUST_SHARE_FRACTION = 1e-6
/** Per-call failures tolerated (verified vault contracts rarely revert; a burst of
 *  failures is an RPC problem, not "holds nothing"). */
export const MAX_FAILED_CALL_SHARE = 0.02

export interface HoldingProbe {
  vault: string
  shares: bigint
  shareDecimals: number
  /** convertToAssets(shares), in the asset's base units. */
  assets: bigint
  assetDecimals: number
  /** Collection-time USD price of the asset, when the feed has one. */
  priceUsd?: number
}

const toUnits = (x: bigint, decimals: number): number => Number(x) / 10 ** decimals

/** Held = worth ≥ $1 when the asset has a price, else ≥ 1e-6 of a whole share. */
export function aboveDust(p: HoldingProbe): boolean {
  if (p.shares <= 0n) return false
  if (p.priceUsd !== undefined && Number.isFinite(p.priceUsd) && p.priceUsd > 0)
    return toUnits(p.assets, p.assetDecimals) * p.priceUsd >= DUST_USD
  return toUnits(p.shares, p.shareDecimals) >= DUST_SHARE_FRACTION
}

/** One chunk of a batched read: rejected outright (an RPC error), or per-call results. */
export type ChunkResult<T> =
  | { ok: false }
  | { ok: true; calls: ({ ok: true; value: T } | { ok: false })[] }

export interface ReadVerdict {
  ok: boolean
  calls: number
  failedCalls: number
  rejectedChunks: number
}

/**
 * Trust a batched read only when no chunk was rejected and per-call failures stay under
 * MAX_FAILED_CALL_SHARE. Otherwise the caller answers 503 and caches nothing: an RPC
 * outage must never read as "holds nothing".
 */
export function judgeRead<T>(chunks: ChunkResult<T>[], expectedCalls: number): ReadVerdict {
  const rejectedChunks = chunks.filter((c) => !c.ok).length
  let calls = 0
  let failedCalls = 0
  for (const c of chunks) {
    if (!c.ok) continue
    calls += c.calls.length
    failedCalls += c.calls.filter((x) => !x.ok).length
  }
  const ok =
    rejectedChunks === 0 &&
    calls === expectedCalls &&
    failedCalls <= Math.floor(expectedCalls * MAX_FAILED_CALL_SHARE)
  return { ok, calls, failedCalls, rejectedChunks }
}
