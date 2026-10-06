// View-model helpers for the oracle registry page: formatting, glyphs, grouping and the
// pure geometry behind the sparkline, the history strip and the basis bar. No React here,
// so every rule is unit-tested in tests/unit/oracleRegistryViewModel.test.ts.
//
// Imports only types and the colour codec from lib/oracleRegistry/apiTypes — never the
// catalog or the engine (those stay on the server).

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { countedColour, decodeColours } from '@/lib/oracleRegistry/apiTypes'
import type {
  AssetSummary,
  CardView,
  ChangeItem,
  Colour,
  EffectiveBand,
  HistorySummary,
  MechanismView,
  OracleClass,
  OracleProvider,
  UsedByView,
} from '@/lib/oracleRegistry/apiTypes'
import type { AssetConsensus, RiskClass } from '@/lib/oracleRegistry/types'

// ---- vocabulary ---------------------------------------------------------------------------

export const PROVIDER_LABEL: Record<OracleProvider, string> = {
  chainlink: 'Chainlink',
  chronicle: 'Chronicle',
  redstone: 'RedStone',
  pyth: 'Pyth',
  aave: 'Aave',
  spark: 'Spark',
  morpho: 'Morpho',
  liquity: 'Liquity',
  uniswap_v3: 'Uniswap v3',
  pendle: 'Pendle',
}

export const CLASS_LABEL: Record<OracleClass, string> = {
  market: 'market',
  exchange_rate: 'exchange rate',
  capped_exchange_rate: 'capped',
  fixed: 'fixed',
  composite: 'composite',
  twap: 'TWAP',
}

export const UPDATE_MODEL_LABEL: Record<MechanismView['updateModel'], string> = {
  push_deviation_heartbeat: 'push on deviation or heartbeat',
  pull: 'pull (pushed by users)',
  on_read_view: 'view, computed on read',
  on_interaction: 'cached, refreshed on interaction',
  twap: 'TWAP, computed on read',
}

export const HISTORY_SOURCE_LABEL: Record<string, string> = {
  chainlink_rounds: 'Chainlink rounds',
  events: 'update events',
  archive_sampling: 'hourly archive reads',
  none_public: 'no public history',
}

export type ColourMeta = { glyph: string; label: string; token: string }

/** Glyph + colour + words: the state never depends on colour alone. */
export const COLOUR_META: Record<Colour, ColourMeta> = {
  green: { glyph: '●', label: 'within band', token: SEMANTIC_COLORS.success },
  red: { glyph: '▼', label: 'below consensus', token: SEMANTIC_COLORS.danger },
  gold: { glyph: '▲', label: 'above consensus', token: SEMANTIC_COLORS.warning },
  stale: { glyph: '░', label: 'stale', token: SEMANTIC_COLORS.textTertiary },
  unavailable: { glyph: '×', label: 'unavailable', token: SEMANTIC_COLORS.textTertiary },
}

export const COLOUR_ORDER: readonly Colour[] = ['green', 'red', 'gold', 'stale', 'unavailable']

/** Basis cards measure a structural gap, so their words say "market", not "consensus". */
export function colourLabel(colour: Colour, tone: CardView['tone']): string {
  if (tone === 'basis') {
    if (colour === 'green') return 'at market'
    if (colour === 'red') return 'below market'
    if (colour === 'gold') return 'above market'
  }
  return COLOUR_META[colour].label
}

// ---- numbers ------------------------------------------------------------------------------

const MINUS = '−'

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fixed(v: number, decimals: number): string {
  const s = Math.abs(v).toFixed(decimals)
  const [i, d] = s.split('.')
  return `${v < 0 ? MINUS : ''}${group(i)}${d ? `.${d}` : ''}`
}

/** Decimals that resolve ~1 bp of the value: $86,084 · $2,716.12 · $1.2508 · $0.99973. */
export function priceDecimals(v: number): number {
  const a = Math.abs(v)
  if (!Number.isFinite(a)) return 2
  if (a >= 1e4) return 0
  if (a >= 10) return 2
  if (a >= 1) return 4
  if (a >= 0.01) return 5
  return 8
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `$${fixed(v, priceDecimals(v))}`
}

/** $15.7M / $940k / $312 — for borrow sizes, never for prices. */
export function fmtCompactUsd(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `$${Number((v / 1e9).toPrecision(3))}B`
  if (a >= 1e6) return `$${Number((v / 1e6).toPrecision(3))}M`
  if (a >= 1e3) return `$${Number((v / 1e3).toPrecision(3))}k`
  return `$${Math.round(v)}`
}

/** Six significant digits, trailing zeros trimmed: 1.1046 · 0.99975 · 31.684. */
export function fmtRatio(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const s = String(Number(v.toPrecision(6)))
  return s.startsWith('-') ? `${MINUS}${s.slice(1)}` : s
}

/** A fraction as a percent, two decimals at most: 0.0377 → "3.77%" · 0.088 → "8.8%". */
export function pctOf(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—'
  return `${Number((fraction * 100).toFixed(2))}%`
}

/** +4.2 bps · −66 bps · 0 bps · −2,679 bps. One decimal under 10 bps, whole bps above. */
export function fmtBps(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '— bps'
  const a = Math.abs(v)
  const body = a < 10 ? a.toFixed(1) : group(Math.round(a).toString())
  if (Number(body) === 0) return '0 bps'
  return `${v < 0 ? MINUS : '+'}${body} bps`
}

/** 45s · 21m · 3h 12m · 19d 4h · 244d. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d >= 30 || !h ? `${d}d` : `${d}d ${h}h`
}

/** 2026-10-05 13:17 UTC */
export function fmtUtc(ts: number): string {
  return `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Oct 01 14:00 (UTC) — compact, for the sparkline readout. */
export function fmtShortUtc(ts: number): string {
  const d = new Date(ts * 1000)
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const day = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${mon} ${day} ${hh}:${mm}`
}

/**
 * The card's own name without the provider it already shows in its eyebrow:
 * "Chainlink cbBTC / USD" → "cbBTC / USD", "Uniswap v3 cbBTC/WBTC 1 bp" → "cbBTC/WBTC 1 bp".
 * Labels that do not start with the provider are returned unchanged.
 */
export function displayLabel(card: Pick<CardView, 'label' | 'provider'>): string {
  const p = PROVIDER_LABEL[card.provider]
  const l = card.label
  if (!p || l.length <= p.length || l.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return l
  const rest = l.slice(p.length).replace(/^[\s·:—–-]+/, '')
  return rest || l
}

export const shortAddr = (a: string): string =>
  /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a

export const etherscanAddress = (a: string): string => `https://etherscan.io/address/${a}`
export const etherscanTx = (tx: string): string => `https://etherscan.io/tx/${tx}`

// ---- card lines ---------------------------------------------------------------------------

/**
 * The second price line: the feed's own quote when it is not USD (weETH/ETH → "1.1046 ETH ×
 * $2,716.12"), or the peg a USD conversion assumed ("quoted in USDT · USDT = $1").
 */
export function nativeLine(
  card: Pick<CardView, 'price' | 'quoteUnit' | 'quoteAsset' | 'conversion' | 'pegAssumed'>,
): string | null {
  if (card.price == null) return null
  if (card.quoteUnit !== 'USD') {
    const unit =
      card.quoteUnit === 'underlying'
        ? (card.quoteAsset ?? 'underlying')
        : card.quoteUnit === 'rate'
          ? 'rate'
          : card.quoteUnit
    const base = `${fmtRatio(card.price)} ${unit}`
    return card.conversion ? `${base} × ${fmtUsd(card.conversion.rate)}` : base
  }
  if (card.pegAssumed) return `quoted in ${card.pegAssumed} · ${card.pegAssumed} = $1`
  return null
}

/** "AGE 21m · HB 1h" — the freshness facts in the card's footer. */
export function freshnessLine(card: Pick<CardView, 'freshness' | 'mechanism'>): {
  age: string
  limit: string
} {
  const f = card.freshness
  const m = card.mechanism
  const age =
    f.state === 'live'
      ? 'live'
      : f.ageSeconds == null
        ? 'no timestamp'
        : `${fmtDuration(f.ageSeconds)}${f.basis === 'components' ? ' (inputs)' : ''}`
  let limit: string
  if (m.updateModel === 'twap')
    limit = m.twapWindowSeconds ? `TWAP ${fmtDuration(m.twapWindowSeconds)}` : 'TWAP'
  else if (f.basis === 'pull') limit = `pull ≤${fmtDuration(f.limitSeconds)}`
  else if (f.basis === 'age_only') limit = `no HB · ≤${fmtDuration(f.limitSeconds)}`
  else if (m.heartbeatSeconds) limit = `HB ${fmtDuration(m.heartbeatSeconds)}`
  else if (f.limitSeconds) limit = `≤${fmtDuration(f.limitSeconds)}`
  else limit = 'HB —'
  return { age, limit }
}

/**
 * "OUT 270/700h · MAX +182 bps" from the full-resolution 30-day replay: hours outside the
 * band over the hours that could be MEASURED (green, red or gold). A stale or no-consensus
 * hour is not an in-band hour, so it is left out of the denominator — and a card with no
 * measurable hour says "not measured" rather than "0/720h", which reads as "in band all month".
 */
export function historyStat(summary: HistorySummary): {
  out: string
  max: string
  measured: boolean
} {
  const toHours = (n: number) => Math.round((n * summary.stepSeconds) / 3600)
  if (!summary.evaluable) return { out: 'not measured', max: '— bps', measured: false }
  return {
    out: `${toHours(summary.outOfBand)}/${toHours(summary.evaluable)}h`,
    max: summary.worst ? fmtBps(summary.worst.bps) : '— bps',
    measured: true,
  }
}

export function usedByLine(u: UsedByView): string {
  const parts = [u.protocol, u.market]
  if (u.borrowUsd != null) parts.push(`${fmtCompactUsd(u.borrowUsd)} borrowed`)
  if (u.kind === 'component') parts.push('via component')
  return parts.join(' · ')
}

/** Screen-reader sentence for a card; the visual card says the same with glyphs. */
export function describeCard(card: CardView): string {
  const provider = PROVIDER_LABEL[card.provider]
  const price = card.usd != null ? fmtUsd(card.usd) : 'no price'
  const state = colourLabel(card.colour, card.tone)
  const dev =
    card.deviationBps != null
      ? `${fmtBps(card.deviationBps).replace(MINUS, 'minus ')} versus ${card.tone === 'basis' ? 'market' : 'consensus'}`
      : ''
  return [`${provider}, ${displayLabel(card)}`, price, dev, state, CLASS_LABEL[card.class]]
    .filter(Boolean)
    .join(', ')
}

// ---- grouping & filtering -----------------------------------------------------------------

export type CardGroup = { key: string; title: string; note: string; cards: CardView[] }

/** Members vote; alternates and derived feeds are compared; basis feeds show a structural gap. */
export function groupCards(cards: readonly CardView[]): CardGroup[] {
  const groups: CardGroup[] = [
    { key: 'member', title: 'Market feeds', note: 'vote in the median', cards: [] },
    {
      key: 'compared',
      title: 'Alternates · derived',
      note: 'compared, do not vote',
      cards: [],
    },
    { key: 'basis', title: 'Basis feeds', note: 'structural gap to market', cards: [] },
  ]
  for (const c of cards) {
    if (c.role === 'member') groups[0].cards.push(c)
    else if (c.role === 'basis') groups[2].cards.push(c)
    else groups[1].cards.push(c)
  }
  return groups.filter((g) => g.cards.length)
}

/** Filter-button counts. A basis card's red/gold is a structural gap, not an outlier: see countedColour. */
export function colourCountsOf(
  cards: readonly Pick<CardView, 'colour' | 'tone'>[],
): Record<Colour, number> {
  const out: Record<Colour, number> = { green: 0, red: 0, gold: 0, stale: 0, unavailable: 0 }
  for (const c of cards) {
    const k = countedColour(c)
    if (k) out[k] += 1
  }
  return out
}

// A basis card's red/gold is left out of the counts above (it is not an outlier), so the
// header tallies it apart — otherwise "▲ 0 above consensus" sits over visible gold basis
// cards — and the tally doubles as a filter that reaches them.

export type BasisFilter = 'basis_above' | 'basis_below'
/** What the header's buttons filter by: an outlier-count colour or a basis direction. */
export type CardFilter = Colour | BasisFilter

export const BASIS_FILTERS: readonly BasisFilter[] = ['basis_above', 'basis_below']

export const BASIS_META: Record<BasisFilter, ColourMeta> = {
  basis_above: { glyph: '▲', label: 'above market', token: SEMANTIC_COLORS.warning },
  basis_below: { glyph: '▼', label: 'below market', token: SEMANTIC_COLORS.danger },
}

export const isBasisFilter = (f: CardFilter | null): f is BasisFilter =>
  f === 'basis_above' || f === 'basis_below'

/** The basis direction a card is tallied under: its uncounted red/gold, else null. */
export function basisSide(card: Pick<CardView, 'colour' | 'tone'>): BasisFilter | null {
  if (card.tone !== 'basis') return null
  if (card.colour === 'gold') return 'basis_above'
  if (card.colour === 'red') return 'basis_below'
  return null
}

/**
 * Basis cards outside the band, by direction to market. A green, stale or unavailable
 * basis card is already counted under its colour, so it is not tallied again here.
 */
export function basisTallyOf(
  cards: readonly Pick<CardView, 'colour' | 'tone'>[],
): Record<BasisFilter, number> {
  const out: Record<BasisFilter, number> = { basis_above: 0, basis_below: 0 }
  for (const c of cards) {
    const side = basisSide(c)
    if (side) out[side] += 1
  }
  return out
}

/** "basis: 2 above market / 0 below market" — the tally's spoken form. */
export function basisTallyLine(tally: Record<BasisFilter, number>): string {
  return `basis: ${tally.basis_above} ${BASIS_META.basis_above.label} / ${tally.basis_below} ${BASIS_META.basis_below.label}`
}

/**
 * The Method text's band rule (owner ruling 2026-10-05; the engine is
 * lib/oracleRegistry/consensus.ts effectiveBand/bandOf): the class bands are a floor; STABLE assets
 * only are widened to the sum of the two largest deviation thresholds their consensus members declare.
 */
export function bandsLine(bands: Record<RiskClass, number>): string {
  return `Class bands: ±${bands.stable} bps stables, ±${bands.major} bps majors, ±${bands.lst_lrt} bps LST/LRT, ±${bands.fixed_income} bps PTs. A stablecoin's band is the wider of its class band and d1 + d2, the two largest deviation thresholds its consensus members declare (feeds that declare none — TWAPs, Chronicle, pull oracles — add nothing; with only one declared, the wider of the class band and that one). Majors, LST/LRT and PTs use their class band only, so a feed lagging inside its own wide trigger still shows as an outlier.`
}

/**
 * Why the band widens: two feeds each inside its own deviation trigger can sit up to the SUM
 * of their triggers apart, and USDe/sUSDe's Chainlink 0.5% + RedStone 0.2% exceed twice the
 * stable class band — which flagged honest feeds before the effective band.
 */
export function honestGapLine(bands: Pick<Record<RiskClass, number>, 'stable'>): string {
  return `Why: two honest feeds can sit up to the sum of their deviation thresholds apart, each lagging spot the opposite way inside its own trigger — e.g. USDe/sUSDe: Chainlink 0.5% + RedStone 0.2% ⇒ up to 70 bps, against a ±${bands.stable} bps stable class band. The band widens to that sum, so such a gap stays ● within band instead of reading "feeds disagree" (two members more than two bands apart) or ▲/▼. Not covered: a feed that declares no threshold, or a composite's other legs, can still lag a fast market while working as designed.`
}

const bpsNum = (v: number): string => String(Number(v.toFixed(2)))

/**
 * The header's band, with where it came from:
 *   widened by the feeds — "±70 bps (feed thresholds 50+20; class 25)"
 *   class band in force  — "±75 bps (class band; feed thresholds 20+20)" / "±25 bps (class band)"
 */
export function bandLabel(band: EffectiveBand): string {
  const head = `±${bpsNum(band.bandBps)} bps`
  const feeds = band.thresholdsBps.length
    ? `feed threshold${band.thresholdsBps.length > 1 ? 's' : ''} ${band.thresholdsBps.map(bpsNum).join('+')}`
    : null
  if (band.bandBps > band.classBandBps && feeds)
    return `${head} (${feeds}; class ${bpsNum(band.classBandBps)})`
  return feeds ? `${head} (class band; ${feeds})` : `${head} (class band)`
}

export function filterCards(cards: readonly CardView[], filter: CardFilter | null): CardView[] {
  if (!filter) return [...cards]
  if (isBasisFilter(filter)) return cards.filter((c) => basisSide(c) === filter)
  return cards.filter((c) => countedColour(c) === filter)
}

/** Status marks for an asset tab: outlier counts, a single ● when calm, × with no consensus. */
export function tabMarks(a: Pick<AssetSummary, 'counts' | 'consensus'>): {
  glyph: string
  count: number | null
  colour: Colour
}[] {
  if (a.consensus.status !== 'ok') return [{ glyph: '×', count: null, colour: 'unavailable' }]
  const marks: { glyph: string; count: number | null; colour: Colour }[] = []
  if (a.counts.red) marks.push({ glyph: COLOUR_META.red.glyph, count: a.counts.red, colour: 'red' })
  if (a.counts.gold)
    marks.push({ glyph: COLOUR_META.gold.glyph, count: a.counts.gold, colour: 'gold' })
  if (!marks.length) marks.push({ glyph: COLOUR_META.green.glyph, count: null, colour: 'green' })
  return marks
}

/** Spoken form of a tab: "cbBTC: 2 below consensus". */
export function tabLabel(
  a: Pick<AssetSummary, 'symbol' | 'kind' | 'counts' | 'consensus'>,
): string {
  const parts: string[] = []
  if (a.consensus.status !== 'ok') parts.push('no consensus')
  else {
    if (a.counts.red) parts.push(`${a.counts.red} below consensus`)
    if (a.counts.gold) parts.push(`${a.counts.gold} above consensus`)
    if (!parts.length) parts.push('all within band')
  }
  if (a.counts.stale) parts.push(`${a.counts.stale} stale`)
  return `${a.symbol}${a.kind === 'reference' ? ' (reference)' : ''}: ${parts.join(', ')}`
}

const EXCLUSION_LABEL: Record<AssetConsensus['excluded'][number]['reason'], string> = {
  stale: 'stale',
  no_reading: 'no reading',
  no_conversion: 'no USD conversion',
  unsupported_quote: 'unsupported quote',
  unknown_freshness: 'no timestamp',
}

/**
 * Why a market member is not in this median, from the consensus's own exclusion list (the
 * card's colour reason can read "within band" for a member that has no timestamp).
 * null for non-members and for members that were counted.
 */
export function voteNote(
  card: Pick<CardView, 'id' | 'role' | 'countedInConsensus'>,
  consensus: Pick<AssetConsensus, 'status' | 'excluded' | 'reason'>,
): string | null {
  if (card.role !== 'member' || card.countedInConsensus) return null
  const ex = consensus.excluded.find((x) => x.id === card.id)
  if (ex) return EXCLUSION_LABEL[ex.reason] ?? ex.reason.replace(/_/g, ' ')
  if (consensus.status === 'ok') return 'not counted'
  return consensus.reason === 'members_disagree'
    ? 'two feeds disagree, no majority'
    : 'no consensus formed'
}

/**
 * Unix time of the newest update among the members that formed the median (snapshot time
 * minus the youngest counted age). null when no counted member carries an update clock
 * (TWAPs and on-read views are live, not updated).
 */
export function lastFeedUpdate(
  cards: readonly Pick<CardView, 'countedInConsensus' | 'freshness'>[],
  snapshotTs: number | null | undefined,
): number | null {
  if (snapshotTs == null) return null
  let youngest: number | null = null
  for (const c of cards) {
    if (!c.countedInConsensus || c.freshness.state !== 'fresh') continue
    const age = c.freshness.ageSeconds
    if (age == null || !Number.isFinite(age)) continue
    if (youngest == null || age < youngest) youngest = age
  }
  return youngest == null ? null : snapshotTs - youngest
}

export function changesForCard(changes: readonly ChangeItem[], card: CardView): ChangeItem[] {
  const ids = new Set(card.changeIds)
  return changes.filter((c) => ids.has(c.id))
}

// ---- geometry -----------------------------------------------------------------------------

export type SparkGeometry = {
  entryPath: string
  consensusPath: string
  min: number | null
  max: number | null
}

/** Finite min/max over every series; a flat series gets ±0.05% so it draws mid-height. */
export function seriesDomain(
  series: readonly (readonly (number | null)[])[],
): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const s of series)
    for (const v of s)
      if (v != null && Number.isFinite(v)) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
  if (lo === Infinity) return null
  if (hi - lo < Math.abs(hi) * 1e-9 || hi === lo) {
    const pad = Math.abs(hi) * 5e-4 || 1e-9
    return [lo - pad, hi + pad]
  }
  return [lo, hi]
}

/**
 * An SVG path through the points; a null breaks the line (a gap, never an interpolation).
 * One decimal: the chart is 240 × 40 user units, so 0.1 is below a device pixel, and the
 * path is server-rendered twice per card.
 */
export function linePath(
  values: readonly (number | null)[],
  domain: [number, number],
  width: number,
  height: number,
  pad = 2,
): string {
  const n = values.length
  if (!n) return ''
  const [lo, hi] = domain
  const span = hi - lo || 1
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width)
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - 2 * pad)
  let d = ''
  let pen = false
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (v == null || !Number.isFinite(v)) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`
    pen = true
  }
  return d
}

export function sparkGeometry(
  usd: readonly (number | null)[],
  consensus: readonly (number | null)[],
  width: number,
  height: number,
): SparkGeometry {
  const domain = seriesDomain(consensus.length ? [usd, consensus] : [usd])
  if (!domain) return { entryPath: '', consensusPath: '', min: null, max: null }
  return {
    entryPath: linePath(usd, domain, width, height),
    consensusPath: consensus.length ? linePath(consensus, domain, width, height) : '',
    min: domain[0],
    max: domain[1],
  }
}

export type StripCell = { x: number; w: number; y: number; h: number; colour: Colour }

/**
 * The 30-day verdict strip as rectangles. Direction is in the SHAPE, not only the colour:
 * gold fills the upper half, red the lower half, green a thin centre band, stale the full
 * height (drawn hatched), unavailable nothing. Runs of one colour merge into one rectangle,
 * so a calm month is one element rather than 240 (it is server-rendered on every card).
 */
export function stripCells(colours: string, width: number, height: number): StripCell[] {
  const cs = decodeColours(colours)
  const n = cs.length
  if (!n) return []
  const w = width / n
  const shape = (colour: Colour): { y: number; h: number } | null =>
    colour === 'gold'
      ? { y: 0, h: height / 2 }
      : colour === 'red'
        ? { y: height / 2, h: height / 2 }
        : colour === 'green'
          ? { y: height * 0.4, h: height * 0.2 }
          : colour === 'stale'
            ? { y: 0, h: height }
            : null
  const out: StripCell[] = []
  let i = 0
  while (i < n) {
    let j = i + 1
    while (j < n && cs[j] === cs[i]) j++
    const s = shape(cs[i])
    if (s) out.push({ x: i * w, w: (j - i) * w, y: s.y, h: s.h, colour: cs[i] })
    i = j
  }
  return out
}

/** Grid index under a pointer at `offsetX` of a `width`-wide chart with n points. */
export function indexAt(offsetX: number, width: number, n: number): number {
  if (n <= 1 || width <= 0) return 0
  return Math.min(n - 1, Math.max(0, Math.round((offsetX / width) * (n - 1))))
}

export type BasisBar = {
  /** Half-width of the scale in bps (the bar spans −scale … +scale). */
  scale: number
  bandLeftPct: number
  bandWidthPct: number
  markerPct: number
}

/**
 * The basis bar: market consensus at the centre, the asset's band shaded around it, a
 * marker at the basis. The scale always contains the marker (≥ 3 bands, ≥ 1.25 × |basis|),
 * so a large basis widens the bar instead of being clipped.
 */
export function basisBar(bps: number, bandBps: number): BasisBar {
  const scale = Math.max(bandBps * 3, Math.abs(bps) * 1.25, 1)
  const pct = (v: number) => 50 + (v / scale) * 50
  return {
    scale,
    bandLeftPct: pct(-bandBps),
    bandWidthPct: (bandBps / scale) * 100,
    markerPct: pct(bps),
  }
}

/** Seconds since `ts` at clock `now` (both unix s), never negative. */
export const ageAt = (ts: number, now: number): number => Math.max(0, now - ts)
