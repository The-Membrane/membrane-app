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
//                              a dot strip per held vault (one dot per market touched,
//                              filled = cut), the latest three with dates
// The week is the seven days ending at the feed's newest collected block, and the
// credit says so; holdings are read on chain at request time and the credit says when.

import { utcClock } from '@/components/Weather/weatherView'
import type { HolderResponse } from '@/pages/api/curator-feed/holder'

export const CURATORS_COPY = {
  kicker: 'Your curators this week',
  none: 'No changes by your curators this week',
  unavailable: 'Your curators: reading unavailable',
  cta: "Alert me when a curator cuts a market I'm in",
  /** The alert flow on this branch routes venue alarms only; curator cuts have no delivery
   *  path yet, so the CTA is drawn but not live. */
  ctaPending: 'Not live yet: curator alerts have no delivery route.',
  legendCut: 'cut',
  legendChange: 'other change',
  legendVault: 'vault setting',
  latest: 'Latest',
} as const

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "6 Oct" (UTC). */
export const dayMonth = (s: number): string => {
  const d = new Date(s * 1000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "N changes by the curators of the vaults you hold · M were cuts" / the no-change line. */
export function curatorsHeadline(changes: number, cuts: number): string {
  if (changes === 0) return CURATORS_COPY.none
  const cutText = cuts === 0 ? 'none were cuts' : cuts === 1 ? '1 was a cut' : `${cuts} were cuts`
  return `${plural(changes, 'change', 'changes')} by the curators of the vaults you hold · ${cutText}`
}

/** Vault rows drawn (most changes first) before the rest fold into one line. */
export const MAX_VAULT_ROWS = 6

/** Dots drawn per vault before the rest fold into "+n". */
export const MAX_DOTS = 24

export interface DotView {
  key: string
  /** Filled (a cut) or hollow (any other change to that market). */
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
  /** Vault-wide settings changed (timelock, roles, adapters): drawn as one square. */
  vaultWide: number
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
    const marketCuts = x.targets.filter((t) => t.cut).length
    const parts: string[] = []
    if (markets > 0) parts.push(plural(markets, 'market', 'markets'))
    if (marketCuts > 0) parts.push(plural(marketCuts, 'cut', 'cuts'))
    if (x.vaultWide > 0) parts.push(plural(x.vaultWide, 'vault setting', 'vault settings'))
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
      summary: parts.join(' · '),
    }
  })
  const credit = [
    `7 days to ${utcClock(v.to * 1000, nowMs)}`,
    'curator feed',
    `${plural(v.held, 'vault', 'vaults')} held, read ${utcClock(Date.parse(data.readAt), nowMs)}`,
  ].join(' · ')
  return {
    state: v.changes === 0 ? 'none' : 'changes',
    headline: curatorsHeadline(v.changes, v.cuts),
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
