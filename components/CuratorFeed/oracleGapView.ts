// §07's view logic, pure (no React), so the unit tests run it in node: whose address is
// read, which cards show, and what tag each card carries.

import {
  i3Points,
  thresholdText,
  type I3Constants,
  type I3State,
} from '@/lib/curatorFeed/oracleGap'
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
  if (unchecked.has(m.market.toLowerCase())) return { text: NOT_READ_TAG, style: 'unchecked' }
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
  /** Markets the viewer starred (lowercase ids): always in the grid. */
  starred?: ReadonlySet<string>
  /** The "Starred" filter: the grid holds only starred markets. */
  starredOnly?: boolean
  /** A market's colour state (cardState): a pale or warning card is in the default set,
   *  above OR below market. Without it, the default set is fired and building. */
  tone?: (m: T) => Tone
}): { above: T[]; held: T[]; unheld: T[]; unchecked: T[]; mine: number; uncheckedCount: number } {
  const { markets, minUsd } = p
  const starred = p.starred ?? new Set<string>()
  const isStarred = (m: T) => starred.has(m.market.toLowerCase())
  // Stale: the markets that were above the line at their last point. Otherwise the
  // markets ≥ the line from market now, either way (or, without `tone`, above it).
  const above = markets.filter((m) =>
    p.stale
      ? m.i3.hoursAboveConsecutive > 0
      : p.tone
        ? p.tone(m) !== 'neutral'
        : m.i3.state === 'fired' || m.i3.state === 'building',
  )
  const strong = (m: T) => !!m.relation && tieStyle(m.relation) !== 'dust'
  const isUnchecked = (m: T) => !m.relation && p.unchecked.has(m.market.toLowerCase())
  const base = p.all ? markets : above
  const listed = !p.hasViewer
    ? markets.filter((m) => base.includes(m) || isStarred(m))
    : p.only
      ? markets.filter((m) => m.relation)
      : markets.filter((m) => strong(m) || base.includes(m) || isStarred(m))
  const shown = p.starredOnly
    ? (p.hasViewer && p.only ? listed : markets).filter(isStarred)
    : listed
  // Under "Show only mine" the fold is the viewer's: a dust tie (its vaults supply under
  // the minimum) sits under it whatever the market's curated supply, as its tag says.
  // Otherwise the fold is the market's: under the minimum of curated supply. A starred
  // market is the viewer's choice: never folded.
  const held = shown.filter(
    (m) =>
      isStarred(m) ||
      (p.hasViewer && p.only ? strong(m) : (m.curatedUsd ?? 0) >= minUsd || strong(m)),
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

// ── a card's title ────────────────────────────────────────────────────────────

/**
 * Card titles, by market id. A name shared by two markets (same pair, same LLTV, another
 * oracle) gets the shortest market-id prefix that tells them apart: "weETH/USDC (86% LLTV)
 * · 0x8dc0…". A unique name stays as it is.
 */
export function cardTitles(
  markets: readonly { market: string; marketName: string }[],
): Map<string, string> {
  const byName = new Map<string, string[]>()
  for (const m of markets) byName.set(m.marketName, [...(byName.get(m.marketName) ?? []), m.market])
  const out = new Map<string, string>()
  for (const [name, ids] of byName) {
    if (ids.length === 1) {
      out.set(ids[0], name)
      continue
    }
    const hex = ids.map((id) => id.toLowerCase().replace(/^0x/, ''))
    let k = 4
    while (k < 64 && new Set(hex.map((h) => h.slice(0, k))).size < new Set(hex).size) k++
    ids.forEach((id, i) => out.set(id, `${name} · 0x${hex[i].slice(0, k)}…`))
  }
  return out
}

// ── a tie not read: one number, one meaning ──────────────────────────────────

/** A card whose tie the read could not settle: the read of whether the viewer's vaults or
 *  positions supply this market failed. */
export const NOT_READ_TAG = '░ tie not read'

/**
 * "░ 92 ties not read": markets with no tie whose tie the read could not settle. A market
 * the read could not check but that carries a tie (from the exposure snapshot) is tagged
 * by its tie instead, so it is not counted here. Printed once, on the not-read line.
 */
export const uncheckedNote = (n: number): string => `░ ${n} ${n === 1 ? 'tie' : 'ties'} not read`

/**
 * Why the tie was not read, in one line, from the read's own failures: "100 reads failed:
 * HttpRequestError" · "Morpho Blue positions: read failed (TimeoutError)". Undefined when
 * the read reports no failure.
 */
export function notReadReason(report: {
  results: readonly {
    label: string
    status: string
    failed: readonly { error: { name: string } }[]
    error?: { name: string }
  }[]
}): string | undefined {
  const failed = report.results.flatMap((r) => r.failed)
  if (failed.length) {
    const names = [...new Set(failed.map((f) => f.error.name))].join(', ')
    return `${failed.length} ${failed.length === 1 ? 'read' : 'reads'} failed: ${names}`
  }
  const errored = report.results.filter((r) => r.status === 'error')
  if (errored.length)
    return errored.map((r) => `${r.label}: read failed (${r.error?.name ?? 'Error'})`).join(' · ')
  return undefined
}

// ── a card's colour: oracle vs market, either way ────────────────────────────

export type Tone = 'neutral' | 'pale' | 'warning'
export type Direction = 'above' | 'below'

export interface CardState {
  /** neutral: within the line (or not measured now) · pale: ≥ the line from market now ·
   *  warning: ≥ the line, the same way, for `persistence` hourly points (fired). */
  tone: Tone
  dir?: Direction
  /** Consecutive hourly points at ≥ the line on this side, ending now. */
  hours: number
  persistence: number
}

export interface ToneMarket {
  i3: {
    state: I3State
    currentGap?: number
    hoursAboveConsecutive: number
    persistence: number
  }
  series: readonly { ts: number; gap: number | null }[]
}

/**
 * The card's colour state. Above market it is the I3 indicator itself (fired = warning,
 * building = pale). Below market is the same rule mirrored: the newest point ≤ −line is
 * pale, and `persistence` consecutive hourly points ≤ −line (the same hold rule, read on
 * the card's series) is warning. Stale or not measured now: neutral (the card is hatched).
 */
export function cardState(m: ToneMarket, c: I3Constants): CardState {
  const { i3 } = m
  const neutral: CardState = { tone: 'neutral', hours: 0, persistence: i3.persistence }
  if (i3.state === 'stale' || i3.state === 'unobserved' || i3.currentGap === undefined)
    return neutral
  const g = i3.currentGap
  if (g >= c.gap)
    return {
      tone: i3.state === 'fired' ? 'warning' : 'pale',
      dir: 'above',
      hours: i3.hoursAboveConsecutive,
      persistence: i3.persistence,
    }
  if (g <= -c.gap) {
    // The mirror: below market by ≥ the line is "above" on the negated series.
    const pts = i3Points(
      m.series.map((p) => ({ ts: p.ts, gap: p.gap === null ? null : -p.gap })),
      c,
    )
    const hours = Math.max(1, pts.at(-1)?.run ?? 0)
    return {
      tone: hours >= i3.persistence ? 'warning' : 'pale',
      dir: 'below',
      hours,
      persistence: i3.persistence,
    }
  }
  return neutral
}

/** The state line under the figure, in words, with its glyph (DESIGN_RULES §2: every
 *  colour carries one): "✖ fired · 30 h ≥ 2% above market", "▼ 3 of 24 h ≥ 2% below
 *  market", "within ±2% of market". */
export function stateLine(s: CardState, c: Pick<I3Constants, 'gap'>): string {
  const line = thresholdText(c)
  if (s.tone === 'neutral') return `within ±${line} of market`
  const side = `≥ ${line} ${s.dir} market`
  if (s.tone === 'warning') return `✖ fired · ${s.hours} h ${side}`
  return `${s.dir === 'above' ? '▲' : '▼'} ${s.hours} of ${s.persistence} h ${side}`
}

/** Severity for the sort: warning, then pale, then the rest. */
const TONE_RANK: Record<Tone, number> = { warning: 0, pale: 1, neutral: 2 }

/**
 * The grid's order: the highlighted cards (the viewer's live and snapshot ties, while
 * "Highlight mine" or a curator is on) first, then starred, then by severity (warning,
 * pale, the rest); inside each, the API's order (fired first, then by $ exposed).
 */
export function sortCards<T extends { market: string; relation?: Relation }>(
  cards: readonly T[],
  o: { highlight: boolean; starred: ReadonlySet<string>; tone: (m: T) => Tone },
): T[] {
  const key = (m: T, i: number) => [
    o.highlight && m.relation && tieStyle(m.relation) !== 'dust' ? 0 : 1,
    o.starred.has(m.market.toLowerCase()) ? 0 : 1,
    TONE_RANK[o.tone(m)],
    i,
  ]
  return cards
    .map((m, i) => ({ m, k: key(m, i) }))
    .sort((a, b) => {
      for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j]
      return 0
    })
    .map((x) => x.m)
}

// ── both prices, when the delta stops meaning much ───────────────────────────

/** Above this |gap| (100%) the delta alone misleads: a collapsed market price under an
 *  oracle still at par reads ">1,000%". The card prints both prices beside it. */
export const BOTH_PRICES_ABOVE = 1

/** A USD price at 5 significant digits: $83,357 · $1.0645 · $0.000015853. */
export const usdPrice = (x: number): string =>
  `$${Number(x.toPrecision(5)).toLocaleString('en-US', { maximumFractionDigits: 20 })}`

const hhmm = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16)

/**
 * The line under the figure when |gap| > 100%: "oracle $0.9998 · market $0.083711 · spot
 * at 06:00 UTC, no average". The market price is DefiLlama's current price, sampled once
 * an hour; nothing is averaged, and the line says so. A missing price is named. Undefined
 * at |gap| ≤ 100%, or with no current gap.
 */
export function bothPricesLine(m: {
  i3: { currentGap?: number; state: I3State }
  latest?: { ts: number; oracleUsd?: number; marketUsd?: number }
}): string | undefined {
  const g = m.i3.currentGap
  if (g === undefined || Math.abs(g) <= BOTH_PRICES_ABOVE) return undefined
  if (m.i3.state === 'stale' || m.i3.state === 'unobserved') return undefined
  const l = m.latest
  if (!l) return 'oracle and market prices not stored for this point'
  const ok = (x?: number): x is number => x !== undefined && Number.isFinite(x)
  const oracle = ok(l.oracleUsd) ? `oracle ${usdPrice(l.oracleUsd)}` : 'oracle price missing'
  const market = ok(l.marketUsd) ? `market ${usdPrice(l.marketUsd)}` : 'market price missing'
  return `${oracle} · ${market} · spot at ${hhmm(l.ts)} UTC, no average`
}

// ── starred markets: per viewer, in this browser ──────────────────────────────

export const STARRED_KEY = 'membrane.oracleGap.starred'

/** The stored list, read defensively: anything but an array of strings is no stars. */
export function parseStarred(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v)
      ? new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()))
      : new Set()
  } catch {
    return new Set()
  }
}

export function toggleStar(s: ReadonlySet<string>, market: string): Set<string> {
  const id = market.toLowerCase()
  const out = new Set(s)
  if (out.has(id)) out.delete(id)
  else out.add(id)
  return out
}
