/**
 * Four flags, from the msY / AZND write-offs of 2026 (docs/CURATOR_ACTION_FEED.md "Flags").
 * Pure: the collector reads the chain, this file decides.
 *
 * 1. ORACLE KIND. A Morpho Blue oracle that has no market price in its path cannot see a
 *    collateral's market price fall: msY/USDC priced msY from "RedStone Price Feed for
 *    MSY_FUNDAMENTAL/USD" (a reported NAV) while msUSD traded at $0.06–0.27; AZND/USDC
 *    had no feed at all (price() a constant 1.00). Flagged: kind 'fixed' or 'reported'.
 * 2. ORACLE REVERTING OR STALE. When price() reverts, Morpho Blue cannot liquidate, lend
 *    against the collateral, or release collateral from a position with debt; repaying is
 *    the only way out. The msY feed stopped on 2026-06-20 11:49 UTC and reverted 30 h
 *    later. Flagged: price() reverts at the head, or a feed's last update is older than
 *    `staleHours`.
 * 3. CURATOR SHIFT. On 2026-06-12 one curator's vaults moved a market position between
 *    each other (two vaults out, one vault in, the same UTC day), and the vaults that gave
 *    it up then set that collateral's caps to 0. Flagged: same curator, same market, same
 *    UTC day, at least one vault net out and one net in by ≥ `shiftMinUsd` each, and an
 *    exit (cap to 0, removal, write-off) on that collateral by an out-vault from that day
 *    to `shiftCutDays` later.
 * 4. ONE BORROWER. AZND/USDC was lent almost entirely to one address. Flagged: the
 *    largest borrower holds ≥ `borrowerShare` of a market's borrows (market ≥
 *    `minBorrowUsd`); per vault, ≥ `vaultBorrowerShare` of the vault is lent to that
 *    borrower (allocation share × the borrower's part of the market's supply).
 *
 * Every text built from these is a statement of what the chain shows, never a judgement.
 */

import type { UnitFlow } from './flows'
import type { CuratorShift, FeedAction, MarketFlags, OracleKind, OraclePart } from './types'
import { EXIT_KINDS } from './types'

export const FLAG_DEFAULTS = {
  staleHours: 72,
  borrowerShare: 0.5,
  vaultBorrowerShare: 0.25,
  minBorrowUsd: 1_000_000,
  shiftMinUsd: 1_000_000,
  shiftCutDays: 7,
}
export type FlagThresholds = typeof FLAG_DEFAULTS

/** A feed description that names a reported value rather than a market price. */
export const REPORTED_RE =
  /fundamental|exchange ?rate|\bnav\b|net asset|redemption|fair ?value|proof of reserve|\bpor\b|backing|conversion/i

export const isReportedFeed = (description: string | undefined): boolean =>
  description !== undefined && REPORTED_RE.test(description)

const isFeed = (p: OraclePart) => p.role.endsWith('Feed1') || p.role.endsWith('Feed2')

/**
 * `parts` null = the oracle is not a MorphoChainlinkOracleV2 (its getters revert).
 * A feed whose description cannot be read makes the kind 'unknown' unless another feed
 * is a market price.
 */
export function classifyOracle(parts: OraclePart[] | null, loan: string): OracleKind {
  if (parts === null) return 'unknown'
  if (parts.length === 0) return 'fixed'
  const feeds = parts.filter(isFeed)
  const vaults = parts.filter((p) => !isFeed(p))
  if (feeds.some((f) => f.description !== undefined && !isReportedFeed(f.description)))
    return 'market'
  if (feeds.some((f) => f.description === undefined)) return 'unknown'
  if (
    feeds.length === 0 &&
    vaults.length === 1 &&
    vaults[0].role === 'baseVault' &&
    vaults[0].asset?.toLowerCase() === loan.toLowerCase()
  )
    return 'vault-rate'
  if (vaults.some((v) => v.asset === undefined)) return 'unknown'
  return 'reported'
}

export const oracleKindFlagged = (k: OracleKind): boolean => k === 'fixed' || k === 'reported'

export const isStale = (m: Pick<MarketFlags, 'staleSeconds'>, t = FLAG_DEFAULTS): boolean =>
  m.staleSeconds !== undefined && m.staleSeconds > t.staleHours * 3600

/** Largest borrower's part of the market's borrows, 0–1 (undefined: not read). */
export function topBorrowerShare(m: Pick<MarketFlags, 'borrowers'>): number | undefined {
  const b = m.borrowers
  if (!b || BigInt(b.totalBorrow) === 0n) return undefined
  return Number((BigInt(b.topAssets) * 1_000_000n) / BigInt(b.totalBorrow)) / 1e6
}

/** Part of a vault lent to the market's largest borrower: allocation share × that
 *  borrower's debt ÷ the market's supply (capped at the allocation). */
export function vaultBorrowerShare(
  allocShare: number,
  m: Pick<MarketFlags, 'borrowers'>,
): number | undefined {
  const b = m.borrowers
  if (!b || BigInt(b.totalSupply) === 0n) return undefined
  const part = Number((BigInt(b.topAssets) * 1_000_000n) / BigInt(b.totalSupply)) / 1e6
  return allocShare * Math.min(1, part)
}

export type MarketFlagKind =
  | 'oracle-fixed'
  | 'oracle-reported'
  | 'oracle-reverting'
  | 'oracle-stale'
  | 'one-borrower'

/** The flags a market carries. `borrowUsd`: the market's borrows in USD (for the floor). */
export function marketFlagKinds(
  m: MarketFlags,
  borrowUsd: number | undefined,
  t = FLAG_DEFAULTS,
): MarketFlagKind[] {
  const out: MarketFlagKind[] = []
  if (m.oracleKind === 'fixed') out.push('oracle-fixed')
  if (m.oracleKind === 'reported') out.push('oracle-reported')
  if (m.reverting) out.push('oracle-reverting')
  else if (isStale(m, t)) out.push('oracle-stale')
  const share = topBorrowerShare(m)
  if (share !== undefined && share >= t.borrowerShare && (borrowUsd ?? 0) >= t.minBorrowUsd)
    out.push('one-borrower')
  return out
}

/** Stored only when it carries a flag (the collector keeps the rest in state). */
export const hasMarketFlag = (m: MarketFlags, borrowUsd: number | undefined, t = FLAG_DEFAULTS) =>
  marketFlagKinds(m, borrowUsd, t).length > 0

/**
 * First block of the CURRENT run of reverts, given price() reverts at `head`. Not monotonic
 * over the window (an oracle can revert before its feed exists, work, then revert again),
 * so: step back from the head, doubling from 300 blocks, to the newest block where price()
 * answers; then binary-search between it and the reverting block above. `beforeWindow`
 * when every probe back to `floor` reverts.
 */
export async function revertOnset(
  revertsAt: (block: number) => Promise<boolean>,
  head: number,
  floor: number,
): Promise<{ since: number; beforeWindow?: true }> {
  let hi = head
  let lo = -1
  for (let step = 300; ; step *= 2) {
    const b = Math.max(floor, hi - step)
    if (!(await revertsAt(b))) {
      lo = b
      break
    }
    hi = b
    if (b === floor) return { since: floor, beforeWindow: true }
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (await revertsAt(mid)) hi = mid
    else lo = mid
  }
  return { since: hi }
}

// ── curator shifts ────────────────────────────────────────────────────────────

export interface ShiftContext {
  curatorOf(vault: string): string
  /** Collateral token of a Morpho market id (lowercase), undefined for non-markets. */
  collateralOf(target: string): string | undefined
  /** USD value of `amount` whole loan-token units of the target's loan token. */
  usd(target: string, amount: number): number | undefined
}

const DAY = 86_400

/** See the file header (flag 3). Flows are daily rows; actions any order. */
export function detectShifts(
  flows: UnitFlow[],
  actions: FeedAction[],
  ctx: ShiftContext,
  t = FLAG_DEFAULTS,
): CuratorShift[] {
  // Net change per vault, grouped by curator × market × day.
  const groups = new Map<string, Map<string, number>>()
  for (const f of flows) {
    if (!ctx.collateralOf(f.target)) continue
    const key = `${ctx.curatorOf(f.vault)}|${f.target}|${f.day}`
    const g = groups.get(key) ?? new Map<string, number>()
    g.set(f.vault, (g.get(f.vault) ?? 0) + f.in - f.out)
    groups.set(key, g)
  }
  const exits = actions.filter((a) => EXIT_KINDS.has(a.kind))
  const out: CuratorShift[] = []
  for (const [key, g] of groups) {
    const [curator, market, day] = key.split('|')
    const big = (amount: number) => Math.abs(ctx.usd(market, amount) ?? 0) >= t.shiftMinUsd
    const from = [...g].filter(([, n]) => n < 0 && big(n))
    const to = [...g].filter(([, n]) => n > 0 && big(n))
    if (!from.length || !to.length) continue
    const coll = ctx.collateralOf(market)!
    const start = Date.parse(`${day}T00:00:00Z`) / 1000
    const end = start + DAY + t.shiftCutDays * DAY
    const fromSet = new Set(from.map(([v]) => v))
    const cuts = new Map<string, { vault: string; actionId: string; ts: number }>()
    for (const a of exits.filter(
      (x) =>
        fromSet.has(x.vault) &&
        x.ts >= start &&
        x.ts < end &&
        x.collateral.some((c) => c.toLowerCase() === coll),
    )) {
      const cur = cuts.get(a.vault)
      if (!cur || a.ts < cur.ts) cuts.set(a.vault, { vault: a.vault, actionId: a.id, ts: a.ts })
    }
    if (!cuts.size) continue
    const sum = (xs: [string, number][]) => xs.reduce((s, [, n]) => s + Math.abs(n), 0)
    const moved = Math.min(sum(from), sum(to))
    out.push({
      curator,
      market,
      day,
      from: from.map(([vault, n]) => ({ vault, amount: -n })).sort((a, b) => b.amount - a.amount),
      to: to.map(([vault, amount]) => ({ vault, amount })).sort((a, b) => b.amount - a.amount),
      usd: ctx.usd(market, moved),
      cuts: [...cuts.values()].sort((a, b) => a.ts - b.ts),
    })
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}
