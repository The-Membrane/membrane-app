// Classification: one colour per card, one board per asset, and the same verdicts replayed
// over a time grid for the history strip.
//
// Colour precedence (first match wins):
//   1. no price at all                         → unavailable (no_reading)
//   2. stale (age > heartbeat + grace)         → stale        — never green, whatever the price
//      no update clock on a push/pull feed     → unavailable (unknown_freshness) — never green
//   3. no USD path (conversion rate missing)   → unavailable (no_conversion)
//   4. asset has < 2 fresh members, or exactly
//      two that disagree by more than 2 bands  → unavailable (insufficient_consensus)
//   5. |dev| ≤ band → green;  dev < −band → red (dip);  dev > +band → gold (upside)
// Boundaries are inclusive for green: a deviation of exactly ±band is green.
// "band" is the asset's EFFECTIVE band everywhere — steps 4 and 5, the snapshot and every hour
// of the history replay: max(class band, d1 + d2) over its members' declared deviation
// thresholds (consensus.effectiveBand, owner ruling 2026-10-05).
//
// BASIS CARDS (consensus role 'basis': exchange-rate, CAPO-capped, fixed-discount and
// peg-assumed prices). They are measured against the MARKET consensus like everyone else
// and coloured on that deviation with the same band — the owner wants a large basis
// visible — but their tone is 'basis' and they carry a BasisInfo that names the direction
// and why it is structural. Their colour is therefore never a "this feed is broken" verdict:
//   - a healthy exchange-rate feed while the market trades at a DISCOUNT reads ABOVE the
//     market → gold + "redemption value above market", not red. It goes red only when the
//     market trades at a premium to redemption value — itself rare and worth seeing.
//   - a CAPO feed reading below market by more than the band → red + "cap may be binding".
// They never vote in the consensus, so a basis can never drag the market price.
//
// Pure: no Date.now; the clock is the snapshot's block timestamp or the grid point.

import type { OracleCatalog, OracleEntry } from './catalog'
import { bandOf, resolveConsensus, riskClassOf, type ConsensusOptions } from './consensus'
import type {
  AssetBoard,
  AssetConsensus,
  BasisInfo,
  CardVerdict,
  Colour,
  EntryHistory,
  Freshness,
  NormalizedPrice,
  OracleReading,
  OracleSnapshot,
  RegistryBoard,
  VerdictReason,
} from './types'

/** Deviation in bps, rounded to 1e-4 bps so exact boundaries are not lost to float noise. */
export function deviationBps(usd: number, consensus: number): number {
  return Math.round((usd / consensus - 1) * 1e8) / 1e4
}

export function colourForDeviation(dev: number, bandBps: number): Colour {
  if (Math.abs(dev) <= bandBps) return 'green'
  return dev < 0 ? 'red' : 'gold'
}

export function classifyColour(input: {
  price: number | null
  normalized: NormalizedPrice
  freshness: Freshness
  consensus: AssetConsensus | undefined
  bandBps: number
}): { colour: Colour; reason: VerdictReason; deviationBps: number | null } {
  const { price, normalized, freshness, consensus, bandBps } = input
  const dev =
    normalized.usd != null && consensus?.status === 'ok' && consensus.price
      ? deviationBps(normalized.usd, consensus.price)
      : null
  if (price == null || normalized.reason === 'no_reading')
    return { colour: 'unavailable', reason: 'no_reading', deviationBps: null }
  if (freshness.state === 'stale') return { colour: 'stale', reason: 'stale', deviationBps: dev }
  // No update clock on a feed that should have one: it cannot be vouched for, so it is never
  // green (and never votes — see consensus.exclusionFor).
  if (freshness.state === 'unknown')
    return { colour: 'unavailable', reason: 'unknown_freshness', deviationBps: dev }
  if (normalized.usd == null)
    return { colour: 'unavailable', reason: 'no_conversion', deviationBps: null }
  if (dev == null)
    return { colour: 'unavailable', reason: 'insufficient_consensus', deviationBps: null }
  const colour = colourForDeviation(dev, bandBps)
  const reason: VerdictReason =
    colour === 'green' ? 'within_band' : colour === 'red' ? 'downside_outlier' : 'upside_outlier'
  return { colour, reason, deviationBps: dev }
}

const BASIS_TEXT: Record<string, { label: string; above: string; below: string }> = {
  exchange_rate: {
    label: 'exchange rate, not a market price',
    above:
      'redemption value above the market: the token trades at a discount, and a market priced by this oracle does not liquidate on that discount',
    below:
      'redemption value below the market: the token trades at a premium to what it redeems for',
  },
  capped_exchange_rate: {
    label: 'exchange rate with a growth cap (CAPO)',
    above:
      'capped exchange rate above the market: the token trades at a discount to its capped redemption value',
    below:
      'capped rate below the market: the growth cap may be binding, so this market values the collateral below where it trades',
  },
  fixed: {
    label: 'deterministic discount schedule, not a market price',
    above:
      'schedule above the market: the market discounts this token more steeply than the schedule',
    below: 'schedule below the market: the market prices this token richer than the schedule',
  },
  composite: {
    label: 'priced as another asset (peg assumed)',
    above: 'reference asset above this token’s market price: the peg assumption is generous',
    below: 'reference asset below this token’s market price',
  },
}

/** The structural basis of a basis-role card vs the market consensus. */
export function basisInfo(entry: OracleEntry, dev: number | null): BasisInfo | undefined {
  if (entry.consensus.role !== 'basis' || dev == null) return undefined
  const text = BASIS_TEXT[entry.class] ?? BASIS_TEXT.composite
  const direction = dev > 0 ? 'above_market' : dev < 0 ? 'below_market' : 'at_market'
  return {
    bps: dev,
    direction,
    label: text.label,
    explanation:
      direction === 'above_market'
        ? text.above
        : direction === 'below_market'
          ? text.below
          : 'at the market',
  }
}

export type EvaluateOptions = ConsensusOptions

/** Every MVP + reference asset's board at one moment. */
export function evaluateReadings(
  catalog: OracleCatalog,
  readings: readonly OracleReading[],
  now: number,
  opts: EvaluateOptions = {},
): RegistryBoard {
  const map = new Map(readings.map((r) => [r.id, r]))
  const { byAsset, bands, entries } = resolveConsensus(catalog, map, now, opts)
  const assets: AssetBoard[] = catalog.assets.map((a) => {
    const consensus = byAsset.get(a.key) as AssetConsensus
    // The same effective band the consensus test used, so colour and agreement never diverge.
    const band = bands.get(a.key) ?? bandOf(catalog, a.key, opts)
    const bandBps = band.bandBps
    const counted = new Set(consensus.status === 'ok' ? consensus.memberIds : [])
    const cards: CardVerdict[] = []
    for (const ev of entries.values()) {
      if (ev.entry.asset !== a.key) continue
      const { entry, reading, freshness, normalized } = ev
      const price = reading?.price ?? null
      const verdict = classifyColour({ price, normalized, freshness, consensus, bandBps })
      const basis = basisInfo(entry, verdict.deviationBps)
      cards.push({
        id: entry.id,
        asset: entry.asset,
        provider: entry.provider,
        class: entry.class,
        role: entry.consensus.role,
        colour: verdict.colour,
        reason: verdict.reason,
        tone: entry.consensus.role === 'basis' ? 'basis' : 'outlier',
        price,
        quoteUnit: entry.quoteUnit,
        usd: normalized.usd,
        derived: normalized.derived,
        ...(normalized.conversion ? { conversion: normalized.conversion } : {}),
        ...(normalized.pegAssumed ? { pegAssumed: normalized.pegAssumed } : {}),
        deviationBps: verdict.deviationBps,
        bandBps,
        freshness,
        countedInConsensus: counted.has(entry.id),
        ...(basis ? { basis } : {}),
        warnings: [...(reading?.warnings ?? []), ...(reading?.error ? [reading.error] : [])],
      })
    }
    return { asset: a.key, riskClass: riskClassOf(a.key), bandBps, band, consensus, cards }
  })
  return { ts: now, assets }
}

export function evaluateSnapshot(
  catalog: OracleCatalog,
  snapshot: OracleSnapshot,
  opts: EvaluateOptions = {},
): RegistryBoard {
  return {
    ...evaluateReadings(catalog, snapshot.entries, snapshot.ts, opts),
    block: snapshot.block,
  }
}

// ---- history ----------------------------------------------------------------------------

/** Evenly spaced timestamps from `from` to `to` inclusive of both ends' grid cells. */
export function timeGrid(from: number, to: number, stepSeconds: number): number[] {
  if (!(stepSeconds > 0) || to < from) return []
  const out: number[] = []
  for (let t = from; t <= to; t += stepSeconds) out.push(t)
  return out
}

/** Index of the last point with ts ≤ t (points sorted by ts), or −1. */
function lastAtOrBefore(points: EntryHistory['points'], t: number): number {
  let lo = 0
  let hi = points.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid][0] <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/**
 * The reading an entry showed at time t, from its history:
 *   event series   — the last update at or before t (its ts IS the update time → age);
 *   sampled series — the NEAREST sample within `toleranceSeconds` (default half a step), so
 *                    a grid built from the sample times (see sampleGrid) reads every sampled
 *                    view at exactly the block the event series are evaluated at. Reading
 *                    the previous sample instead would compare an hour-old view against
 *                    current pushes and paint fast markets red/gold for no reason.
 *                    A third element carries the feed's own updatedAt, a fourth the
 *                    updatedAt of each recorded component (so a view keeps its legs' ages).
 */
export function readingAt(
  history: EntryHistory | undefined,
  t: number,
  toleranceSeconds?: number,
): OracleReading | undefined {
  if (!history || history.source === 'none_public' || !history.points.length) return undefined
  const pts = history.points
  const i = lastAtOrBefore(pts, t)
  if (history.source === 'archive_sampling') {
    const tol = toleranceSeconds ?? (history.stepSeconds ?? 3600) / 2
    let best = -1
    for (const k of [i, i + 1]) {
      if (k < 0 || k >= pts.length || Math.abs(pts[k][0] - t) > tol) continue
      if (best < 0 || Math.abs(pts[k][0] - t) < Math.abs(pts[best][0] - t)) best = k
    }
    if (best < 0) return { id: history.id, price: null, updatedAt: null }
    const p = pts[best]
    const out: OracleReading = {
      id: history.id,
      price: p[1],
      updatedAt: p.length === 2 ? null : p[2],
    }
    const legs = p.length === 4 ? p[3] : null
    if (legs && history.components) {
      const components = history.components.flatMap((c, k) =>
        legs[k] != null && (legs[k] as number) > 0
          ? [{ role: c.role, address: c.address, updatedAt: legs[k] as number }]
          : [],
      )
      if (components.length) out.components = components
    }
    return out
  }
  if (i < 0) return { id: history.id, price: null, updatedAt: null }
  return { id: history.id, price: pts[i][1], updatedAt: pts[i][0] }
}

/**
 * The evaluation grid for a history strip: the archive sample times (every sampled series
 * shares the collector's block grid), falling back to an even grid when nothing was sampled.
 */
export function sampleGrid(
  histories: ReadonlyMap<string, EntryHistory>,
  fallback?: { from: number; to: number; stepSeconds: number },
): number[] {
  const ts = new Set<number>()
  for (const h of histories.values())
    if (h.source === 'archive_sampling') for (const p of h.points) ts.add(p[0])
  if (ts.size) return [...ts].sort((a, b) => a - b)
  return fallback ? timeGrid(fallback.from, fallback.to, fallback.stepSeconds) : []
}

export type HistorySeries = {
  grid: number[]
  consensus: Record<string, (number | null)[]>
  entries: Record<
    string,
    { usd: (number | null)[]; deviationBps: (number | null)[]; colour: Colour[] }
  >
}

/**
 * Replays the board at every grid time from per-entry histories, so each card's history
 * strip uses exactly the snapshot rules (conversion at the same moment, same staleness,
 * same effective bands — so the '30D OUT' hours count against the band the card shows). Entries with no public history are simply 'unavailable' on the strip.
 */
export function evaluateHistory(
  catalog: OracleCatalog,
  histories: ReadonlyMap<string, EntryHistory>,
  grid: readonly number[],
  opts: EvaluateOptions = {},
): HistorySeries {
  const out: HistorySeries = { grid: [...grid], consensus: {}, entries: {} }
  for (const a of catalog.assets) out.consensus[a.key] = []
  for (const t of grid) {
    const readings: OracleReading[] = []
    for (const e of catalog.entries) {
      const r = readingAt(histories.get(e.id), t)
      if (r) readings.push(r)
    }
    const board = evaluateReadings(catalog, readings, t, opts)
    for (const a of board.assets) {
      out.consensus[a.asset].push(a.consensus.price)
      for (const c of a.cards) {
        const s = (out.entries[c.id] ??= { usd: [], deviationBps: [], colour: [] })
        s.usd.push(c.usd)
        s.deviationBps.push(c.deviationBps)
        s.colour.push(c.colour)
      }
    }
  }
  return out
}
