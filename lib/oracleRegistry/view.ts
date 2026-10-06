// Server-side payload builders for /api/oracles and /api/oracles/[asset].
//
// Pure: every input (catalog, snapshots, histories, governance log) arrives as an argument,
// so the same code serves the API, the page's getServerSideProps and the unit tests. File
// I/O and memoisation live in ./server.ts.
//
//   inputs ──buildModel──▶ model { board (latest snapshot), series (30-day replay), changes }
//   model  ──buildIndex──▶ OracleIndexResponse            (asset picker + per-asset summary)
//   model  ──buildAssetView(asset)──▶ AssetViewResponse    (cards + consensus + history)
//
// Missing pieces degrade instead of throwing: no snapshot → every card 'unavailable' with its
// mechanism still shown; no history → history.available = false; no governance log → only
// snapshot diffs in the change list.

import type { OracleCatalog, OracleEntry } from './catalog'
import { classifyParam, detectChangeSeries, type ChangeEvent, type ChangeKind } from './changes'
import {
  evaluateHistory,
  evaluateReadings,
  evaluateSnapshot,
  sampleGrid,
  type HistorySeries,
} from './classify'
import { DEFAULT_BANDS_BPS } from './consensus'
import {
  countedColour,
  encodeColours,
  type AssetHistoryView,
  type AssetSummary,
  type AssetViewResponse,
  type CardHistoryView,
  type CardView,
  type ChangeItem,
  type ColourCounts,
  type HistorySummary,
  type OracleIndexResponse,
  type SnapshotMeta,
} from './apiTypes'
import type {
  AssetBoard,
  CardVerdict,
  CollectedHistorySource,
  Colour,
  EntryHistory,
  OracleSnapshot,
  ParamValue,
  RegistryBoard,
} from './types'

// ---- input files --------------------------------------------------------------------------

export type HistoryIndexFile = {
  window: {
    startBlock?: number
    endBlock?: number
    startTs: number
    endTs: number
    days: number
    stepSeconds: number
  }
  entries: { id: string; source: CollectedHistorySource; points: number; note?: string }[]
}

export type GovernanceEvent = {
  block: number
  ts: number
  tx?: string
  logIndex?: number
  emitter: string
  event: string
  args: Record<string, string | number | boolean | null>
  entryIds: string[]
}

export type GovernanceFile = {
  window: { startBlock?: number; endBlock?: number; days: number; endTs?: number }
  events: GovernanceEvent[]
}

export type RegistryInputs = {
  catalog: OracleCatalog
  latest: OracleSnapshot | null
  /** Every readable snapshot, any order (diffed chronologically for the change list). */
  snapshots: OracleSnapshot[]
  histories: ReadonlyMap<string, EntryHistory>
  historyIndex: HistoryIndexFile | null
  governance: GovernanceFile | null
}

export type RegistryModel = {
  inputs: RegistryInputs
  /** Board at the latest snapshot; with no snapshot, an all-unavailable board (mechanisms only). */
  board: RegistryBoard
  series: HistorySeries | null
  /** Downsampling plan shared by every series: [start, endExclusive) grid indexes. */
  buckets: [number, number][]
  changes: ChangeItem[]
}

/** Sparkline resolution: 720 hourly samples → 240 three-hour buckets. */
export const MAX_HISTORY_BUCKETS = 240

const ROLE_ORDER: Record<CardVerdict['role'], number> = {
  member: 0,
  alternate: 1,
  derived: 2,
  basis: 3,
}

export const assetSlug = (key: string): string => key.toLowerCase()

export function findAssetKey(catalog: OracleCatalog, slug: string): string | null {
  const s = slug.toLowerCase()
  return catalog.assets.find((a) => assetSlug(a.key) === s)?.key ?? null
}

// ---- small aggregates ---------------------------------------------------------------------

export function colourCounts(
  cards: readonly (Pick<CardVerdict, 'colour'> & { tone?: CardVerdict['tone'] })[],
): ColourCounts {
  const out: ColourCounts = { green: 0, red: 0, gold: 0, stale: 0, unavailable: 0 }
  for (const c of cards) {
    const k = countedColour(c)
    if (k) out[k] += 1
  }
  return out
}

/** The market-tone card furthest outside the band (basis cards are structural, not outliers). */
export function worstOutlier(
  cards: readonly (Pick<CardVerdict, 'id' | 'colour' | 'deviationBps' | 'tone'> & {
    label?: string
  })[],
): AssetSummary['worst'] {
  let worst: AssetSummary['worst'] = null
  for (const c of cards) {
    if (c.tone !== 'outlier' || (c.colour !== 'red' && c.colour !== 'gold')) continue
    if (c.deviationBps == null) continue
    if (!worst || Math.abs(c.deviationBps) > Math.abs(worst.deviationBps))
      worst = { id: c.id, label: c.label ?? c.id, colour: c.colour, deviationBps: c.deviationBps }
  }
  return worst
}

// ---- history downsampling -----------------------------------------------------------------

/** Contiguous [start, endExclusive) ranges covering `length` samples in ≤ maxBuckets buckets. */
export function bucketRanges(length: number, maxBuckets = MAX_HISTORY_BUCKETS): [number, number][] {
  if (length <= 0 || maxBuckets <= 0) return []
  const size = Math.max(1, Math.ceil(length / maxBuckets))
  const out: [number, number][] = []
  for (let s = 0; s < length; s += size) out.push([s, Math.min(length, s + size)])
  return out
}

/**
 * One colour for a bucket: an outlier anywhere in it wins (the larger |deviation| decides
 * red vs gold), then stale, then green; 'unavailable' only when nothing else is there.
 * A three-hour bucket must never hide a one-hour excursion.
 */
export function bucketColour(colours: readonly Colour[], devs: readonly (number | null)[]): Colour {
  let outlier: Colour | null = null
  let outlierAbs = -1
  let stale = false
  let green = false
  for (let i = 0; i < colours.length; i++) {
    const c = colours[i]
    if (c === 'red' || c === 'gold') {
      const abs = Math.abs(devs[i] ?? 0)
      if (abs > outlierAbs) {
        outlier = c
        outlierAbs = abs
      }
    } else if (c === 'stale') stale = true
    else if (c === 'green') green = true
  }
  if (outlier) return outlier
  if (stale) return 'stale'
  if (green) return 'green'
  return 'unavailable'
}

/** Last non-null value in [start, end): the bucket's value at its own end time. */
export function lastInRange(
  values: readonly (number | null)[],
  [start, end]: [number, number],
): number | null {
  for (let i = end - 1; i >= start; i--) {
    const v = values[i]
    if (v != null && Number.isFinite(v)) return v
  }
  return null
}

export function summarizeHistory(
  colours: readonly Colour[],
  devs: readonly (number | null)[],
  grid: readonly number[],
  stepSeconds: number,
): HistorySummary {
  let evaluable = 0
  let outOfBand = 0
  let stale = 0
  let worstBps: number | null = null
  let worstTs = 0
  for (let i = 0; i < colours.length; i++) {
    const c = colours[i]
    if (c === 'stale') stale += 1
    if (c !== 'green' && c !== 'red' && c !== 'gold') continue
    evaluable += 1
    if (c !== 'green') outOfBand += 1
    const d = devs[i]
    if (d != null && (worstBps == null || Math.abs(d) > Math.abs(worstBps))) {
      worstBps = d
      worstTs = grid[i]
    }
  }
  return {
    total: colours.length,
    evaluable,
    outOfBand,
    stale,
    worst: worstBps == null ? null : { bps: worstBps, ts: worstTs },
    stepSeconds,
  }
}

/** Rounds a USD value to 7 significant digits for transport. */
const sig = (v: number | null): number | null => (v == null ? null : Number(v.toPrecision(7)))

// ---- change list --------------------------------------------------------------------------

const shortAddr = (a: string): string =>
  /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a

/** A 1e18-scaled yearly rate as a percent: 37700000000000000 → "3.77%". */
export function pct1e18(raw: string | number): string {
  const v = Number(raw) / 1e16
  return Number.isFinite(v) ? `${Number(v.toFixed(2))}%` : String(raw)
}

const isoDay = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10)

const str = (v: unknown): string => (v == null ? '' : String(v))

/** Human title + detail for one governance log line from changes.json. */
export function describeGovernanceEvent(ev: GovernanceEvent): {
  title: string
  detail: string
  kind: ChangeItem['kind']
} {
  const a = ev.args ?? {}
  switch (ev.event) {
    case 'DiscountRatePerYearUpdated':
      return {
        title: 'Discount rate',
        detail: `${pct1e18(str(a.oldDiscountRatePerYear))} → ${pct1e18(str(a.newDiscountRatePerYear))} per year`,
        kind: 'discount',
      }
    case 'CapParametersUpdated': {
      const growth = Number(a.maxYearlyRatioGrowthPercent) / 100
      const ratio = Number(a.snapshotRatio) / 1e18
      const at = Number(a.snapshotTimestamp)
      const parts = [
        Number.isFinite(growth) ? `max growth ${Number(growth.toFixed(2))}%/yr` : null,
        Number.isFinite(ratio) ? `snapshot ratio ${ratio.toFixed(5)}` : null,
        Number.isFinite(at) && at > 0 ? `taken ${isoDay(at)}` : null,
      ].filter(Boolean)
      return { title: 'CAPO cap', detail: parts.join(' · '), kind: 'cap' }
    }
    case 'AssetSourceUpdated':
      return {
        title: 'Market oracle source',
        detail: `source set to ${shortAddr(str(a.source))}`,
        kind: 'market_source',
      }
    case 'Upgraded':
      return {
        title: 'Contract upgraded',
        detail: `implementation ${shortAddr(str(a.implementation))}`,
        kind: 'upgrade',
      }
    case 'TollGranted':
      return {
        title: 'Reader whitelisted',
        detail: `${shortAddr(str(a.who))} granted read access`,
        kind: 'access',
      }
    // The kinds below must match classifyParam's for the snapshot parameter each event
    // changes (priceCap → cap, bar → quorum, aggregator/phaseId → aggregator), or
    // buildChanges cannot tell that the event already explains the diff.
    case 'PriceCapUpdated': {
      // Aave's stable price-cap adapters answer in the market oracle's 8-decimal USD.
      const cap = Number(a.priceCap) / 1e8
      return {
        title: 'Price cap',
        detail: Number.isFinite(cap)
          ? `price cap set to $${Number(cap.toFixed(6))}`
          : `price cap set to ${str(a.priceCap)}`,
        kind: 'cap',
      }
    }
    case 'BarUpdated':
      return {
        title: 'Quorum (bar)',
        detail: `bar ${str(a.oldBar)} → ${str(a.newBar)} signatures`,
        kind: 'quorum',
      }
    case 'AggregatorConfirmed':
      return {
        title: 'Aggregator',
        detail: `aggregator ${shortAddr(str(a.previous))} → ${shortAddr(str(a.latest))}`,
        kind: 'aggregator',
      }
    default:
      return {
        title: ev.event,
        detail: Object.entries(a)
          .map(([k, v]) => `${k} ${shortAddr(str(v))}`)
          .join(' · '),
        kind: 'other',
      }
  }
}

const DIFF_TITLE: Record<ChangeKind, string> = {
  aggregator: 'Aggregator',
  heartbeat: 'Heartbeat',
  deviation_threshold: 'Deviation threshold',
  twap_window: 'TWAP window',
  cap: 'Cap parameter',
  discount: 'Discount rate',
  market_source: 'Market oracle source',
  wiring: 'Component wiring',
  quorum: 'Quorum (bar)',
  update_model: 'Update model',
  entry_added: 'Entry added',
  entry_removed: 'Entry removed',
  other: 'Parameter',
}

function fmtParam(param: string, v: ParamValue | undefined): string {
  if (v == null) return '—'
  const s = String(v)
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return shortAddr(s)
  if (/discount|rate/i.test(param) && /^\d{15,}$/.test(s)) return pct1e18(s)
  return s
}

export function describeDiff(ev: ChangeEvent): ChangeItem {
  const label = ev.param.startsWith('source:')
    ? ev.param.slice('source:'.length)
    : ev.param.startsWith('component:')
      ? ev.param.slice('component:'.length)
      : ev.param
  return {
    id: `diff:${ev.entryId}:${ev.param}:${ev.toBlock}`,
    origin: 'diff',
    kind: ev.kind,
    ts: ev.toTs,
    block: ev.toBlock,
    fromTs: ev.fromTs,
    fromBlock: ev.fromBlock,
    entryIds: [ev.entryId],
    title: DIFF_TITLE[ev.kind] ?? 'Parameter',
    detail:
      ev.origin === 'entry'
        ? ev.kind === 'entry_added'
          ? 'first seen in this snapshot'
          : 'missing from this snapshot'
        : `${label}: ${fmtParam(ev.param, ev.from)} → ${fmtParam(ev.param, ev.to)}${ev.origin === 'catalog' ? ' (catalog)' : ''}`,
  }
}

/**
 * Is the governance item inside the diff's interval? By timestamp when the event has one,
 * else by block (the collector leaves ts null when the block header could not be read).
 */
function insideInterval(g: ChangeItem, ev: ChangeEvent): boolean {
  if (g.ts != null && Number.isFinite(g.ts)) return g.ts > ev.fromTs && g.ts <= ev.toTs
  return g.block > ev.fromBlock && g.block <= ev.toBlock
}

/**
 * Governance events + snapshot diffs, newest first. A diff that a governance event already
 * explains (same entry, same kind, event inside the diff's interval) is dropped, so a CAPO
 * update shows once with its exact block rather than twice. Diffs come from the whole
 * snapshot series with the last read value carried over unreadable snapshots.
 */
export function buildChanges(
  governance: GovernanceFile | null,
  snapshots: readonly OracleSnapshot[],
): ChangeItem[] {
  const events: ChangeItem[] = (governance?.events ?? []).map((ev) => {
    const d = describeGovernanceEvent(ev)
    return {
      id: `event:${ev.block}:${ev.logIndex ?? 0}:${ev.emitter}`,
      origin: 'event',
      kind: d.kind,
      ts: ev.ts,
      block: ev.block,
      entryIds: ev.entryIds ?? [],
      title: d.title,
      detail: d.detail,
      event: ev.event,
      ...(ev.tx ? { tx: ev.tx } : {}),
      emitter: ev.emitter,
    }
  })
  const diffs: ChangeItem[] = []
  for (const ev of detectChangeSeries(snapshots)) {
    const explained = events.some(
      (g) =>
        g.kind === classifyParam(ev.param) &&
        g.entryIds.includes(ev.entryId) &&
        insideInterval(g, ev),
    )
    if (!explained) diffs.push(describeDiff(ev))
  }
  // Newest first by block (always present); ts breaks ties and can be null on an event.
  return [...events, ...diffs].sort((a, b) => b.block - a.block || (b.ts ?? 0) - (a.ts ?? 0))
}

// ---- model --------------------------------------------------------------------------------

export function buildModel(inputs: RegistryInputs): RegistryModel {
  const { catalog, latest, histories } = inputs
  const board = latest
    ? evaluateSnapshot(catalog, latest)
    : evaluateReadings(catalog, [], inputs.historyIndex?.window.endTs ?? 0)
  let series: HistorySeries | null = null
  if (histories.size) {
    const grid = sampleGrid(
      histories,
      inputs.historyIndex
        ? {
            from: inputs.historyIndex.window.startTs,
            to: inputs.historyIndex.window.endTs,
            stepSeconds: inputs.historyIndex.window.stepSeconds,
          }
        : undefined,
    )
    if (grid.length) series = evaluateHistory(catalog, histories, grid)
  }
  const buckets = series ? bucketRanges(series.grid.length) : []
  const snapshots = latest ? [...inputs.snapshots, latest] : inputs.snapshots
  return { inputs, board, series, buckets, changes: buildChanges(inputs.governance, snapshots) }
}

function snapshotMeta(s: OracleSnapshot | null): SnapshotMeta | null {
  return s ? { block: s.block, ts: s.ts, catalogGeneratedAt: s.catalogGeneratedAt ?? null } : null
}

function labelOf(catalog: OracleCatalog, id: string): string {
  return catalog.entries.find((e) => e.id === id)?.label ?? id
}

function sortCards<T extends Pick<CardVerdict, 'role'>>(cards: readonly T[]): T[] {
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => ROLE_ORDER[a.c.role] - ROLE_ORDER[b.c.role] || a.i - b.i)
    .map((x) => x.c)
}

export function buildIndex(model: RegistryModel): OracleIndexResponse {
  const { catalog, latest } = model.inputs
  const assets: AssetSummary[] = []
  for (const a of model.board.assets) {
    const meta = catalog.assets.find((x) => x.key === a.asset)
    if (!meta) continue
    const cards = a.cards.map((c) => ({ ...c, label: labelOf(catalog, c.id) }))
    assets.push({
      key: a.asset,
      slug: assetSlug(a.asset),
      symbol: meta.symbol,
      kind: meta.kind,
      riskClass: a.riskClass,
      bandBps: a.bandBps,
      consensus: {
        status: a.consensus.status,
        price: a.consensus.price,
        members: a.consensus.status === 'ok' ? a.consensus.memberIds.length : 0,
        spreadBps: a.consensus.spreadBps,
        referenceUsd: a.consensus.reference?.usd ?? null,
      },
      counts: colourCounts(a.cards),
      cards: a.cards.length,
      worst: worstOutlier(cards),
    })
  }
  // MVP assets in catalog order, reference assets (BTC) after them.
  assets.sort((x, y) => Number(x.kind === 'reference') - Number(y.kind === 'reference'))
  return {
    available: latest != null,
    ...(latest ? {} : { reason: 'no snapshot collected yet' }),
    snapshot: snapshotMeta(latest),
    assets,
  }
}

function cardHistory(model: RegistryModel, id: string): CardHistoryView | null {
  const h = model.inputs.histories.get(id)
  const s = model.series?.entries[id]
  if (!h || h.source === 'none_public' || !s || !model.series) return null
  const step = model.inputs.historyIndex?.window.stepSeconds ?? h.stepSeconds ?? 3600
  const indexNote = model.inputs.historyIndex?.entries.find((e) => e.id === id)?.note
  const note = indexNote ?? h.note
  return {
    source: h.source,
    rawPoints: h.points.length,
    ...(note ? { note } : {}),
    usd: model.buckets.map((r) => sig(lastInRange(s.usd, r))),
    colours: encodeColours(
      model.buckets.map(([a, b]) => bucketColour(s.colour.slice(a, b), s.deviationBps.slice(a, b))),
    ),
    summary: summarizeHistory(s.colour, s.deviationBps, model.series.grid, step),
  }
}

function cardView(model: RegistryModel, card: CardVerdict, entry: OracleEntry): CardView {
  const snap = model.inputs.latest?.entries.find((e) => e.id === card.id)
  const m = entry.mechanism
  return {
    ...card,
    label: entry.label,
    address: entry.address,
    readMethod: entry.readMethod,
    decimals: entry.decimals,
    ...(entry.quoteAsset ? { quoteAsset: entry.quoteAsset } : {}),
    consensusNote: entry.consensus.note,
    mechanism: {
      source: m.source,
      aggregation: m.aggregation,
      updateModel: m.updateModel,
      heartbeatSeconds: m.heartbeatSeconds,
      deviationThresholdBps: m.deviationThresholdBps,
      ...(m.twapWindowSeconds != null ? { twapWindowSeconds: m.twapWindowSeconds } : {}),
      ...(m.fallback ? { fallback: m.fallback } : {}),
      ...(m.pegAssumption ? { pegAssumption: m.pegAssumption } : {}),
      ...(m.cap ? { cap: m.cap } : {}),
      ...(m.discount ? { discount: m.discount } : {}),
      ...(m.access ? { access: m.access } : {}),
      ...(m.publicRead ? { publicRead: m.publicRead } : {}),
      ...(m.dataFeedId ? { dataFeedId: m.dataFeedId } : {}),
      ...(m.notes ? { notes: m.notes } : {}),
      governance: m.governance,
      components: m.components.map((c) => ({
        role: c.role,
        label: c.label,
        address: c.address,
        ...(c.ref ? { ref: c.ref } : {}),
      })),
    },
    usedBy: entry.usedBy.map((u) => ({
      protocol: u.protocol,
      market: u.market,
      kind: u.kind,
      ...(u.borrowUsd != null ? { borrowUsd: u.borrowUsd } : {}),
    })),
    docsUrl: entry.docsUrl,
    historyPlanned: entry.historySource,
    history: cardHistory(model, card.id),
    onchain: snap?.params ?? {},
    extras: snap?.extras ?? {},
    changeIds: model.changes.filter((c) => c.entryIds.includes(card.id)).map((c) => c.id),
  }
}

function historyView(model: RegistryModel, asset: string): AssetHistoryView {
  const s = model.series
  const idx = model.inputs.historyIndex
  if (!s || !s.grid.length)
    return {
      available: false,
      from: null,
      to: null,
      days: null,
      bucketSeconds: 0,
      ts: [],
      consensus: [],
    }
  const step = idx?.window.stepSeconds ?? 3600
  const size = model.buckets.length ? model.buckets[0][1] - model.buckets[0][0] : 1
  const series = s.consensus[asset] ?? []
  return {
    available: true,
    from: s.grid[0],
    to: s.grid[s.grid.length - 1],
    days: idx?.window.days ?? Math.round((s.grid[s.grid.length - 1] - s.grid[0]) / 86400),
    bucketSeconds: size * step,
    ts: model.buckets.map(([, b]) => s.grid[b - 1]),
    consensus: model.buckets.map((r) => sig(lastInRange(series, r))),
  }
}

export function buildAssetView(model: RegistryModel, assetKey: string): AssetViewResponse | null {
  const { catalog, latest, governance } = model.inputs
  const meta = catalog.assets.find((a) => a.key === assetKey)
  const board: AssetBoard | undefined = model.board.assets.find((a) => a.asset === assetKey)
  if (!meta || !board) return null
  const byId = new Map(catalog.entries.map((e) => [e.id, e]))
  const cards = sortCards(
    board.cards.flatMap((c) => {
      const e = byId.get(c.id)
      return e ? [cardView(model, c, e)] : []
    }),
  )
  const ids = new Set(cards.map((c) => c.id))
  return {
    available: latest != null,
    ...(latest ? {} : { reason: 'no snapshot collected yet' }),
    asset: {
      key: meta.key,
      slug: assetSlug(meta.key),
      symbol: meta.symbol,
      kind: meta.kind,
      ...(meta.maturity ? { maturity: meta.maturity } : {}),
      ...(meta.note ? { note: meta.note } : {}),
    },
    snapshot: snapshotMeta(latest),
    riskClass: board.riskClass,
    // The effective band the board was coloured with, and where it came from (the header).
    bandBps: board.bandBps,
    band: board.band,
    consensus: board.consensus,
    cards,
    history: historyView(model, assetKey),
    changes: model.changes.filter((c) => c.entryIds.some((id) => ids.has(id))),
    changesWindow: {
      days: governance?.window.days ?? null,
      endTs: governance?.window.endTs ?? null,
    },
    policies: {
      consensus: catalog.consensusPolicy,
      staleness: catalog.stalenessPolicy,
      // Class bands (the floor); the effective band per asset is `band` above.
      bands: { ...DEFAULT_BANDS_BPS },
    },
    excluded: catalog.excluded
      .filter((x) => x.asset === assetKey)
      .map((x) => ({ provider: x.provider, reason: x.reason })),
  }
}
