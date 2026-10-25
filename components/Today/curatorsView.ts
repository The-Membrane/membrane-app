// YOUR CURATORS THIS WEEK — view model for the Safety block's personal curator module.
// Pure: the /api/curator-feed/holder response (or its loading/error state) in; every
// string and dot the module prints out. No React, so the unit tests run it in node.
//
// Owner ruling (Q27 round 6): only the personal version of the curator ripple map
// ships, filtered to the reader's own dependencies; no global map. The filter itself is
// lib/curatorFeed/holder.ts buildHolderView (server side).
//
// What prints:
//   no curated vault held      nothing at all (not an empty box)
//   held, nothing this week    "No changes by your curators this week"
//   held, changes              "N changes by the curators of the vaults you hold · M were cuts",
//                              a mark strip per held vault (one mark per market touched:
//                              a filled circle = cut, a diamond = any other change), the
//                              latest three with dates
// The week is the seven days ending at the feed's newest collected block, and the
// credit says so; holdings are read on chain at request time and the credit says when.

import { utcClock } from '@/components/Weather/weatherView'
import type { HolderResponse } from '@/pages/api/curator-feed/holder'

/**
 * The address this module reads when the reader has entered none (demo-first), marked
 * "Example — not yours" like the Radar's. Not the Radar's example (the Uniswap v4
 * PoolManager holds dust in ~200 vaults, nobody's typical book): a public mainnet EOA
 * that the Morpho public API (userByAddress, 2026-10-18) and our own chain read both show
 * holding two curated vaults, Gauntlet WETH Prime and Gauntlet LRT Core. Its holdings are
 * read live like any other address; nothing here is a holding.
 */
export const CURATORS_EXAMPLE_ADDRESS = '0x28a55C4b4f9615FDE3CDAdDf6cc01FcF2E38A6b0'

/** Past this, the feed's week is not "this week": the kicker dates it instead. */
export const FEED_STALE_S = 86_400

export const CURATORS_COPY = {
  kicker: 'Your curators this week',
  /** Kicker when the feed's window ended more than FEED_STALE_S ago. */
  kickerDated: 'Your curators',
  none: 'No changes by your curators this week',
  /** The no-change line when the window is not this week. */
  noneDated: 'No changes by your curators',
  /** Always in the credit: what balanceOf cannot see. */
  notCounted: 'shares posted as collateral or wrapped elsewhere not counted',
  /** In the credit when the window is dated. */
  readNow: 'holdings read now; changes from that window',
  unavailable: 'Your curators: reading unavailable',
  /** "Changes the composition", not "cuts": a cut removes the market from the vault, not
   *  the reader from the market (owner feedback, PR #107). */
  cta: "Alert me when a curator changes the composition of a market I'm in",
  /** The alert flow on this branch routes venue alarms only; curator changes have no
   *  delivery path yet, so the CTA is drawn but not live. */
  ctaPending: 'Not live yet: curator alerts have no delivery route.',
  legendCut: 'cut (market · vault-level)',
  legendChange: 'other market change (add, raise)',
  legendVault: 'vault setting changed',
  latest: 'Latest',
} as const

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "6 Oct" (UTC). */
export const dayMonth = (s: number): string => {
  const d = new Date(s * 1000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "4–11 Oct" / "28 Sep–5 Oct" (UTC). */
export function dayRange(fromS: number, toS: number): string {
  const a = new Date(fromS * 1000)
  const b = new Date(toS * 1000)
  return a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()
    ? `${a.getUTCDate()}–${dayMonth(toS)}`
    : `${dayMonth(fromS)}–${dayMonth(toS)}`
}

/** "N changes by the curators of the vaults you hold · M were cuts" / the no-change line
 *  ("this week" dropped when the window is dated). */
export function curatorsHeadline(changes: number, cuts: number, dated = false): string {
  if (changes === 0) return dated ? CURATORS_COPY.noneDated : CURATORS_COPY.none
  const cutText = cuts === 0 ? 'none were cuts' : cuts === 1 ? '1 was a cut' : `${cuts} were cuts`
  return `${plural(changes, 'change', 'changes')} by the curators of the vaults you hold · ${cutText}`
}

/** Vault rows drawn (most changes first) before the rest fold into one line. */
export const MAX_VAULT_ROWS = 6

/** Dots drawn per vault before the rest fold into "+n". */
export const MAX_DOTS = 24

export interface DotView {
  key: string
  /** A cut (filled circle) or any other change to that market (a diamond: a different
   *  shape, not a hollow cut, so the two read apart without colour). */
  cut: boolean
  /** "weETH/WETH (94.5% LLTV) · cut · 1 change": the dot's accessible name and tooltip. */
  label: string
}

export interface VaultRowView {
  key: string
  vaultName: string
  curatorName: string
  dots: DotView[]
  /** Dots beyond MAX_DOTS. */
  more: number
  /** Vault-wide settings changed that are not cuts: drawn as one bar (not a
   *  hollow square, which would read as a vault-level cut toggled off). */
  vaultWide: number
  /** Distinct vault-level cuts (an adapter cap cut, a write-off): one filled square each. */
  vaultWideCuts: number
  /** "2 markets · 1 cut", "1 vault setting". */
  summary: string
}

export interface LatestRowView {
  key: string
  date: string
  vaultName: string
  text: string
  cut: boolean
  tx: string
}

export type CuratorsView =
  | { state: 'hidden' }
  | { state: 'unavailable'; headline: string }
  | {
      state: 'none' | 'changes'
      /** "Your curators this week", or "Your curators · 4–11 Oct (feed 7 days old)". */
      kicker: string
      headline: string
      rows: VaultRowView[]
      /** "+14 more vaults with changes", or null. */
      moreVaults: string | null
      latest: LatestRowView[]
      /** "7 days to 11 Oct 17:52 UTC · curator feed · 5 vaults held, read 14:05 UTC". */
      credit: string
    }

/**
 * The module for one address. `loading` and a missing response render nothing (the
 * module appears with its data; it sits below the fold under the Radar lead).
 */
export function curatorsView(input: {
  data: HolderResponse | undefined
  error: boolean
  nowMs: number
}): CuratorsView {
  const { data, error, nowMs } = input
  if (error) return { state: 'unavailable', headline: CURATORS_COPY.unavailable }
  if (!data || !data.view) return { state: 'hidden' }
  const v = data.view
  const rows: VaultRowView[] = v.vaults.slice(0, MAX_VAULT_ROWS).map((x) => {
    const markets = x.targets.length
    const parts: string[] = []
    if (markets > 0) parts.push(plural(markets, 'market', 'markets'))
    if (x.cuts > 0) parts.push(plural(x.cuts, 'cut', 'cuts'))
    const settings = x.vaultWide + x.vaultWideCuts
    if (x.vaultWideCuts > 0 || x.vaultWide > 0)
      parts.push(plural(settings, 'vault setting', 'vault settings'))
    return {
      key: x.vault,
      vaultName: x.vaultName,
      curatorName: x.curatorName,
      dots: x.targets.slice(0, MAX_DOTS).map((t) => ({
        key: t.target,
        cut: t.cut,
        label: `${t.name} · ${t.cut ? 'cut' : 'changed'} · ${plural(t.changes, 'change', 'changes')}`,
      })),
      more: Math.max(0, markets - MAX_DOTS),
      vaultWide: x.vaultWide,
      vaultWideCuts: x.vaultWideCuts,
      summary: parts.join(' · '),
    }
  })
  const ageS = nowMs / 1000 - v.to
  const dated = ageS > FEED_STALE_S
  const kicker = dated
    ? `${CURATORS_COPY.kickerDated} · ${dayRange(v.from, v.to)} (feed ${plural(Math.floor(ageS / 86_400), 'day', 'days')} old)`
    : CURATORS_COPY.kicker
  const credit = [
    `7 days to ${utcClock(v.to * 1000, nowMs)}`,
    'curator feed',
    `${plural(v.held, 'vault', 'vaults')} held, read ${utcClock(Date.parse(data.readAt), nowMs)}`,
    ...(dated ? [CURATORS_COPY.readNow] : []),
    CURATORS_COPY.notCounted,
  ].join(' · ')
  return {
    state: v.changes === 0 ? 'none' : 'changes',
    kicker,
    headline: curatorsHeadline(v.changes, v.cuts, dated),
    rows,
    moreVaults:
      v.vaults.length > MAX_VAULT_ROWS
        ? `+${plural(v.vaults.length - MAX_VAULT_ROWS, 'more vault', 'more vaults')} with changes`
        : null,
    // One event can yield two actions (a supply-queue rewrite: one out, one in), so the
    // action id is not unique; the index makes the key so.
    latest: v.latest.map((l, i) => ({
      key: `${l.id}#${i}`,
      date: dayMonth(l.ts),
      vaultName: l.vaultName,
      text: l.text,
      cut: l.cut,
      tx: l.tx,
    })),
    credit,
  }
}
