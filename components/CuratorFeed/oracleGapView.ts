// §07's view logic, pure (no React), so the unit tests run it in node: whose address is
// read, which cards show, and what tag each card carries.

import type { I3State } from '@/lib/curatorFeed/oracleGap'
import {
  parseViewerAddress,
  relationTag,
  tieStyle,
  type Address,
  type Relation,
  type TieStyle,
} from '@/lib/exposure'

// ── whose address ─────────────────────────────────────────────────────────────

export const ADDRESS_HINT = 'Not an address: 0x and 40 hex characters, with a valid checksum.'

/** What the viewer typed: null = nothing typed, follow the connected wallet. An invalid
 *  entry reads no address (so the last one's highlights clear) and says why. */
export type Typed = { address: Address | null; error: string | null } | null

export function commitTyped(raw: string): Typed {
  const s = raw.trim()
  if (!s) return null
  const address = parseViewerAddress(s)
  return address ? { address, error: null } : { address: null, error: ADDRESS_HINT }
}

/**
 * The address read: what the viewer typed, else the connected account. A wallet switch is
 * followed (A → B reads B) unless an address was typed.
 */
export function viewerOf(
  wallet: string | undefined,
  typed: Typed,
): { address: Address | null; fromWallet: boolean; error: string | null } {
  if (typed) return { address: typed.address, fromWallet: false, error: typed.error }
  const w = wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet) ? (wallet.toLowerCase() as Address) : null
  return { address: w, fromWallet: !!w, error: null }
}

// ── a card's tag ──────────────────────────────────────────────────────────────

export interface CardTag {
  text: string
  style: TieStyle | 'unchecked'
}

/** The viewer's tie, or "░ unchecked" when the read could not say; else none. */
export function cardTag(
  m: { market: string; relation?: Relation },
  unchecked: ReadonlySet<string>,
): CardTag | undefined {
  if (m.relation) return { text: relationTag(m.relation), style: tieStyle(m.relation) }
  if (unchecked.has(m.market.toLowerCase())) return { text: '░ unchecked', style: 'unchecked' }
  return undefined
}

// ── which cards ───────────────────────────────────────────────────────────────

export interface PickMarket {
  market: string
  curatedUsd?: number
  relation?: Relation
  i3: { state: I3State; hoursAboveConsecutive: number }
}

/**
 * held     cards in the grid
 * unheld   under the fold: "Show only mine": the dust ties; otherwise the markets with
 *          under $1 of curated exposure
 * unchecked  only under "Show only mine": markets the read could not check, behind their
 *          own fold, so a failed read never looks like "none"
 * mine     live and snapshot ties (dust excluded); uncheckedCount: markets unchecked
 */
export function pickCards<T extends PickMarket>(p: {
  markets: readonly T[]
  stale: boolean
  all: boolean
  hasViewer: boolean
  only: boolean
  unchecked: ReadonlySet<string>
  minUsd: number
}): { above: T[]; held: T[]; unheld: T[]; unchecked: T[]; mine: number; uncheckedCount: number } {
  const { markets, minUsd } = p
  // Stale: the markets that were above the line at their last point.
  const above = markets.filter((m) =>
    p.stale ? m.i3.hoursAboveConsecutive > 0 : m.i3.state === 'fired' || m.i3.state === 'building',
  )
  const strong = (m: T) => !!m.relation && tieStyle(m.relation) !== 'dust'
  const isUnchecked = (m: T) => !m.relation && p.unchecked.has(m.market.toLowerCase())
  const base = p.all ? markets : above
  const shown = !p.hasViewer
    ? base
    : p.only
      ? markets.filter((m) => m.relation)
      : markets.filter((m) => strong(m) || base.includes(m))
  // Under "Show only mine" the fold is the viewer's: a dust tie (its vaults supply under
  // the minimum) sits under it whatever the market's curated supply, as its tag says.
  // Otherwise the fold is the market's: under the minimum of curated supply.
  const held = shown.filter((m) =>
    p.hasViewer && p.only ? strong(m) : (m.curatedUsd ?? 0) >= minUsd || strong(m),
  )
  return {
    above,
    held,
    unheld: shown.filter((m) => !held.includes(m)),
    unchecked: p.hasViewer && p.only ? markets.filter(isUnchecked) : [],
    mine: markets.filter(strong).length,
    uncheckedCount: markets.filter(isUnchecked).length,
  }
}
