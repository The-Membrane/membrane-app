// Payload shapes for /api/oracles and /api/oracles/[asset], shared by the server builders
// (lib/oracleRegistry/view.ts) and the client page (components/OracleRegistry/*).
//
// This module carries NO runtime imports from the catalog/engine: the client imports it,
// and anything that pulled in catalog.ts would ship the 200 KB catalog JSON to the browser.
// Type-only imports are erased at compile time.

import type {
  Address,
  ConsensusRole,
  GovernanceParam,
  HistorySource,
  OracleClass,
  OracleProvider,
  QuoteUnit,
  UpdateModel,
} from './catalog'
import type { ChangeKind } from './changes'
import type {
  AssetConsensus,
  CardVerdict,
  CollectedHistorySource,
  Colour,
  EffectiveBand,
  ParamValue,
  RiskClass,
} from './types'

export type SnapshotMeta = { block: number; ts: number; catalogGeneratedAt: string | null }

export type ColourCounts = Record<Colour, number>

export type AssetSummary = {
  key: string
  slug: string
  symbol: string
  kind: 'mvp' | 'reference'
  riskClass: RiskClass
  /** The asset's effective band (AssetBoard.bandBps). */
  bandBps: number
  consensus: {
    status: AssetConsensus['status']
    price: number | null
    /** Fresh members that formed the median. */
    members: number
    spreadBps: number | null
    referenceUsd: number | null
  }
  counts: ColourCounts
  cards: number
  /** The market-tone card furthest outside the band, if any card is red or gold. */
  worst: { id: string; label: string; colour: Colour; deviationBps: number } | null
}

export type OracleIndexResponse = {
  available: boolean
  reason?: string
  snapshot: SnapshotMeta | null
  assets: AssetSummary[]
}

/** One character per history bucket (see encodeColours). */
export type ColourString = string

export type HistorySummary = {
  /** Samples on the full-resolution grid. */
  total: number
  /** Samples with a usable verdict (green / red / gold). */
  evaluable: number
  /** Samples outside the band (red + gold). */
  outOfBand: number
  stale: number
  /** Largest |deviation| among evaluable samples, signed. */
  worst: { bps: number; ts: number } | null
  stepSeconds: number
}

export type CardHistoryView = {
  /** Where the series actually came from (collector verdict, not the catalog plan). */
  source: CollectedHistorySource
  rawPoints: number
  note?: string
  /** USD value per bucket, aligned to AssetViewResponse.history.ts. */
  usd: (number | null)[]
  colours: ColourString
  summary: HistorySummary
}

export type MechanismView = {
  source: string
  aggregation: string
  updateModel: UpdateModel
  heartbeatSeconds: number | null
  deviationThresholdBps: number | null
  twapWindowSeconds?: number
  fallback?: string
  pegAssumption?: string
  cap?: Record<string, string | number>
  discount?: Record<string, string | number>
  access?: string
  publicRead?: 'open' | 'zero_address_only'
  dataFeedId?: string
  notes?: string
  governance: GovernanceParam[]
  components: { role: string; label: string; address: Address; ref?: string }[]
}

export type UsedByView = {
  protocol: string
  market: string
  kind: 'direct' | 'component'
  borrowUsd?: number
}

export type CardView = CardVerdict & {
  label: string
  address: Address
  readMethod: string
  decimals: number | null
  quoteAsset?: string
  consensusNote: string
  mechanism: MechanismView
  usedBy: UsedByView[]
  docsUrl: string
  historyPlanned: HistorySource
  history: CardHistoryView | null
  /** Mechanism parameters read on-chain at the snapshot block. */
  onchain: Record<string, ParamValue>
  /** Collector extras: Pyth conf, Liquity lastGoodPrice, TWAP tick. */
  extras: Record<string, ParamValue>
  /** Change-list items that name this entry. */
  changeIds: string[]
}

export type ChangeItem = {
  id: string
  /** event = a governance log; diff = a parameter that differs between two snapshots. */
  origin: 'event' | 'diff'
  kind: ChangeKind | 'access' | 'upgrade'
  ts: number
  block: number
  /** For a diff: the earlier snapshot; the change happened somewhere in (fromTs, ts]. */
  fromTs?: number
  fromBlock?: number
  entryIds: string[]
  title: string
  detail: string
  event?: string
  tx?: string
  emitter?: string
}

export type AssetHistoryView = {
  available: boolean
  from: number | null
  to: number | null
  days: number | null
  /** Seconds per bucket after downsampling; the grid underneath is the collector step. */
  bucketSeconds: number
  /** Bucket end times (unix s). */
  ts: number[]
  consensus: (number | null)[]
}

export type AssetViewResponse = {
  available: boolean
  reason?: string
  asset: {
    key: string
    slug: string
    symbol: string
    kind: 'mvp' | 'reference'
    maturity?: number
    note?: string
  }
  snapshot: SnapshotMeta | null
  riskClass: RiskClass
  /** The effective band every verdict on this asset uses (= band.bandBps). */
  bandBps: number
  /** How the band was set: max(class band, d1 + d2 of the members' declared thresholds). */
  band: EffectiveBand
  consensus: AssetConsensus
  cards: CardView[]
  history: AssetHistoryView
  changes: ChangeItem[]
  changesWindow: { days: number | null; endTs: number | null }
  policies: { consensus: string; staleness: string; bands: Record<RiskClass, number> }
  excluded: { provider: string; reason: string }[]
}

// ---- colour codec ---------------------------------------------------------------------

export const COLOUR_CODE: Readonly<Record<Colour, string>> = {
  green: 'g',
  red: 'r',
  gold: 'o',
  stale: 's',
  unavailable: 'x',
}

const DECODE: Readonly<Record<string, Colour>> = {
  g: 'green',
  r: 'red',
  o: 'gold',
  s: 'stale',
  x: 'unavailable',
}

export function encodeColours(colours: readonly Colour[]): ColourString {
  return colours.map((c) => COLOUR_CODE[c]).join('')
}

export function decodeColours(s: ColourString): Colour[] {
  return [...s].map((ch) => DECODE[ch] ?? 'unavailable')
}

/**
 * The colour a card is COUNTED and FILTERED under. Red and gold mean "below / above
 * consensus" — an outlier verdict — so a basis card's red or gold (a structural gap to
 * market, labelled as such on the card) counts as neither; null = counted nowhere.
 * One definition for the tab marks, the filter buttons and the worst-outlier summary.
 */
export function countedColour(card: { colour: Colour; tone?: CardVerdict['tone'] }): Colour | null {
  if (card.tone === 'basis' && (card.colour === 'red' || card.colour === 'gold')) return null
  return card.colour
}

export type { ConsensusRole, OracleClass, OracleProvider, QuoteUnit, Colour, EffectiveBand }
