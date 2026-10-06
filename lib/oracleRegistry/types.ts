// Shared shapes for the oracle registry engine (normalize → consensus → classify) and the
// collector's output files (scripts/oracle-registry/collect.mjs → data/oracle-registry/).
//
// The engine is pure: every function takes its clock (`now`, unix seconds) as an argument and
// never reads Date.now(), the network or the filesystem. Snapshots and history files are
// raw on-chain readings in each entry's own quote unit; the engine turns them into USD,
// a consensus per asset and a colour per card.

import type { ConsensusRole, OracleClass, OracleProvider, QuoteUnit } from './catalog'

/**
 * green       — within the asset's (effective) band of the consensus — see EffectiveBand.
 * red         — below consensus by more than the band (downside outlier, a "dip").
 * gold        — above consensus by more than the band (upside outlier).
 * stale       — older than heartbeat + grace (never green, whatever its price).
 * unavailable — no reading, no USD conversion, or no consensus to compare against.
 */
export type Colour = 'green' | 'red' | 'gold' | 'stale' | 'unavailable'

export type VerdictReason =
  | 'within_band'
  | 'downside_outlier'
  | 'upside_outlier'
  | 'stale'
  | 'no_reading'
  | 'no_conversion'
  | 'insufficient_consensus'
  /** A push feed that exposed no update time: it cannot be vouched for, so never green. */
  | 'unknown_freshness'

export type ComponentReading = {
  role: string
  address: string
  /** The component feed's own updatedAt (unix s) when it exposes one. */
  updatedAt: number | null
}

/** One raw on-chain reading of a catalog entry, in the entry's own quote unit. */
export type OracleReading = {
  id: string
  /** Price in entry.quoteUnit with decimals applied; null when the read failed. */
  price: number | null
  /** The price's own timestamp (unix s) when the oracle exposes one. */
  updatedAt: number | null
  /** Component feed ages, for views that carry no updatedAt of their own. */
  components?: ComponentReading[]
  error?: string
  /** Collector extras: Pyth conf, Liquity lastGoodPrice, TWAP tick, … */
  extras?: Record<string, ParamValue>
  warnings?: string[]
}

export type ParamValue = string | number | boolean | null

export type SnapshotEntry = OracleReading & {
  /** Mechanism parameters READ ON-CHAIN at this block (aggregator, CAPO params, market source…). */
  params?: Record<string, ParamValue>
  /** Mechanism parameters DECLARED by the catalog at collection time (heartbeat, deviation…). */
  config?: Record<string, ParamValue>
}

export type OracleSnapshot = {
  version: 1
  chainId: 1
  block: number
  /** Block timestamp (unix s): the evaluation clock for this snapshot. */
  ts: number
  catalogGeneratedAt: string
  entries: SnapshotEntry[]
}

// ---- history files (data/oracle-registry/history/<id>.json) -----------------------

/** Where a history series actually came from (the collector's verdict, not the catalog's plan). */
export type CollectedHistorySource =
  | 'chainlink_rounds'
  | 'events'
  | 'archive_sampling'
  | 'none_public'

/**
 * [ts, price], [ts, price, updatedAt] or [ts, price, updatedAt | null, componentUpdatedAts].
 * Event series: ts = the update's own timestamp, the value holds until the next point.
 * Sampled series: ts = the sample block's timestamp; the optional third element is the
 * feed's own updatedAt at that block, and the optional fourth holds the updatedAt of each
 * component in EntryHistory.components (null where that leg was unreadable) — so a view
 * that inherits its age from its feeds stays judgeable after sampling.
 */
export type HistoryPoint =
  | [number, number]
  | [number, number, number]
  | [number, number, number | null, (number | null)[]]

export type EntryHistory = {
  id: string
  source: CollectedHistorySource
  /** Sampling step in seconds for archive_sampling series. */
  stepSeconds?: number
  from: number
  to: number
  /** The clocked components a sampled series recorded, aligned with each point's 4th element. */
  components?: { role: string; address: string }[]
  points: HistoryPoint[]
  note?: string
}

// ---- engine output -----------------------------------------------------------------

export type FreshnessState = 'fresh' | 'stale' | 'live' | 'unknown'

export type Freshness = {
  /**
   * fresh   — has a timestamp inside its limit.
   * stale   — older than its limit (heartbeat + grace, pull limit, or age-only limit).
   * live    — computed at read time (TWAP, view over live state): no update clock exists.
   * unknown — a push feed that exposed no timestamp; never counted in consensus.
   */
  state: FreshnessState
  ageSeconds: number | null
  limitSeconds: number | null
  basis: 'heartbeat' | 'pull' | 'age_only' | 'components' | 'live' | 'none'
}

export type QuoteResolution =
  | { kind: 'usd'; pegAssumed?: string }
  | { kind: 'asset'; asset: string; pegAssumed?: string }
  | { kind: 'unsupported'; reason: string }

export type NormalizedPrice = {
  /** USD value, or null (see reason). */
  usd: number | null
  /**
   * true when the USD value was DERIVED by multiplying a non-USD quote (ETH, BTC, an
   * underlying) by that asset's consensus at the same time — not the feed's own USD answer.
   */
  derived: boolean
  conversion?: { asset: string; rate: number }
  /** A stablecoin/LST quote assumed to sit at its peg (USDT = $1, stETH = ETH). */
  pegAssumed?: string
  reason?: 'no_reading' | 'no_conversion' | 'unsupported_quote'
}

export type ConsensusExclusion = {
  id: string
  reason: 'stale' | 'no_reading' | 'no_conversion' | 'unsupported_quote' | 'unknown_freshness'
}

export type AssetConsensus = {
  asset: string
  status: 'ok' | 'insufficient'
  /**
   * Why there is no consensus:
   *   too_few_members  — fewer fresh members than minMembers;
   *   members_disagree — exactly two fresh members, further apart than two bands: their
   *                      midpoint would put BOTH outside the band, and with no third vote
   *                      nothing says which one is wrong.
   */
  reason?: 'too_few_members' | 'members_disagree'
  /** Median USD price of the eligible members; null when insufficient. */
  price: number | null
  memberIds: string[]
  excluded: ConsensusExclusion[]
  /** (max − min) / median of the eligible members, in bps. */
  spreadBps: number | null
  minMembers: number
  /** When insufficient but one fresh member exists: shown as a reference, never used to colour. */
  reference?: { id: string; usd: number }
}

export type BasisInfo = {
  bps: number
  direction: 'above_market' | 'below_market' | 'at_market'
  label: string
  explanation: string
}

export type CardVerdict = {
  id: string
  asset: string
  provider: OracleProvider
  class: OracleClass
  role: ConsensusRole
  colour: Colour
  reason: VerdictReason
  /**
   * 'outlier' — a market-class card: its colour says "this feed disagrees with the market".
   * 'basis'   — an exchange-rate / capped / fixed / peg-assumed card: its colour shows the
   *             STRUCTURAL basis to market (visible, labelled), not a malfunction.
   */
  tone: 'outlier' | 'basis'
  price: number | null
  quoteUnit: QuoteUnit
  usd: number | null
  derived: boolean
  conversion?: { asset: string; rate: number }
  pegAssumed?: string
  deviationBps: number | null
  /** The asset's effective band (AssetBoard.band.bandBps). */
  bandBps: number
  freshness: Freshness
  countedInConsensus: boolean
  basis?: BasisInfo
  warnings: string[]
}

export type RiskClass = 'stable' | 'major' | 'lst_lrt' | 'fixed_income'

/**
 * An asset's outlier band and where it came from (consensus.effectiveBand):
 *   bandBps = max(classBandBps, d1 + d2), d1 ≥ d2 the two largest deviation thresholds declared
 *   by the asset's consensus members. Every verdict — card colour, the two-member agreement
 *   test, the history replay — uses `bandBps`.
 */
export type EffectiveBand = {
  /** The band in force, in bps of the consensus. */
  bandBps: number
  /** The risk-class band (or a configured per-asset override): the floor. */
  classBandBps: number
  /** d1, d2: the two largest declared member thresholds, largest first (0, 1 or 2 values). */
  thresholdsBps: number[]
}

export type AssetBoard = {
  asset: string
  riskClass: RiskClass
  /** The effective band (band.bandBps), not the bare class band. */
  bandBps: number
  band: EffectiveBand
  consensus: AssetConsensus
  cards: CardVerdict[]
}

export type RegistryBoard = {
  ts: number
  block?: number
  assets: AssetBoard[]
}
