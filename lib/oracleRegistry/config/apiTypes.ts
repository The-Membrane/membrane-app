// Payload shapes for the CONFIG CARDS view of /[chain]/oracles (?view=config) and
// /api/oracles/[asset]?view=config. Built on the server by lib/oracleRegistry/config/view.ts
// from the collector's files (data/oracle-registry/config/{state,changes,queues}); read by
// components/OracleRegistry/Config*.tsx.
//
// Type-only imports: the client imports this module, and it must never pull in the engine,
// the subjects loader or the 1+ MB change files.

import type {
  AnnouncementStatus,
  ChangeState,
  ChangeTag,
  ConfigSubject,
  ControllerKind,
  Dimension,
  Direction,
  PowerSpec,
  Severity,
  Stage,
  ValueAtRisk,
} from './types'

export type BreachView = {
  ruleId: string
  message: string
  /** Where the rule fails: "eid 30110 (arbitrum) receive" for a route (the banner names it). */
  where?: string
  /**
   * UQ-30: the breach was carried from the last run that confirmed it, because a read it depends
   * on failed this run — the read gap (the message says "breach unconfirmed: read gap"). Still
   * counted and red.
   */
  unconfirmed?: string
  /** Floor breaches (BR-2): USD value behind the route — the severity rank (null = unknown). */
  valueAtRiskUsd?: number | null
  /** "$300M at risk (locked on Ethereum)" or why it is unknown. */
  valueAtRisk?: string
  /**
   * What part of the value was not read (review round 9): a partial read sorts with the unread
   * breaches (ruling #14), its read side shown as a lower bound. Absent = fully read.
   */
  valueAtRiskUnread?: string[]
}

/**
 * Head-state tallies for one subject. Every number is a plain count of what the collector
 * wrote; nothing is weighted or scored.
 *   floorBreaches   live LayerZero routes under the absolute floor now (rule BR-2)
 *   ruleBreaches    other state rules that fail now (AD-3 EOA holder, AD-7 timelock admin …)
 *   redInEffect     historical red changes whose result is still the live value
 *   redOpen         red pending (scheduled / armed) + red proposed changes
 *   openRed         floorBreaches + ruleBreaches + redInEffect + redOpen — the tab's red mark.
 *                   A breach and the change that caused it can both count: it is a count of
 *                   red flags, not of distinct problems.
 *   pending         timelock ops not yet executed, EXCLUDING stale ones
 *   stale           past their ETA but not executable now (predecessor missing / call reverts)
 */
export type ConfigCounts = {
  floorBreaches: number
  ruleBreaches: number
  redInEffect: number
  redOpen: number
  openRed: number
  redTotal: number
  pending: number
  armed: number
  stale: number
  proposed: number
  /** Proposed Safe transactions with enough signatures: anyone can execute them now (ARMED). */
  armedProposed?: number
  historical: number
  /** Route sides (local or remote) whose config could not be read this run (UNREAD / REMOTE UNREAD). */
  unread: number
  /** Other reads that failed and can hide a red flag (power holders, Safe / multisig queues). */
  readGaps?: number
}

export type ConfigTabSummary = {
  subject: string
  /** The asset tab this config belongs to: the oracle asset's slug, or the subject key. */
  slug: string
  symbol: string
  label: string
  /** Oracle-catalog slug; null ⇒ config-only tab (rsETH). */
  oracleSlug: string | null
  counts: ConfigCounts
  asOf: { block: number; ts: number } | null
}

export type ConfigIndexResponse = {
  available: boolean
  subjects: ConfigTabSummary[]
}

export type HolderView = { kind: ControllerKind | 'unresolved'; label: string; url: string | null }

export type PowerView = {
  power: PowerSpec['power']
  label: string
  holders: HolderView[]
  /** -1 ⇒ immutable (no holder can change it). */
  delaySec: number
  delayLabel: string
  /** false ⇒ a zero-delay Safe / EOA can change it with no on-chain pending window. */
  pendingObservable: boolean
  /** How a pending change is observed, or why it is not ("no pending window · INSTANT (…)"). */
  pendingNote?: string | null
  breaches: BreachView[]
  /**
   * The engine's notes on this power (review round 6: dropped before) — which whitelisted
   * functions bypass the timelock and who holds the bypass, a holder not classified at head.
   */
  warnings: string[]
}

/** Shortest delay over every power of one kind (the header's "effective delay"). */
export type DelayChip = {
  power: PowerSpec['power']
  label: string
  delaySec: number
  delayLabel: string
  pendingObservable: boolean
  powers: number
}

export type RouteSideView = {
  chainId: number
  direction: Direction
  /** Effective distinct known operators (null when the side was not read). */
  E: number | null
  live: boolean
  /** "4-of-4" · "2 req + 2-of-3 opt" · "blocked". */
  shape: string
  operators: string[]
  /** Operators run by the token's own issuer (counted, labelled 'issuer-run'). */
  issuerRun?: string[]
  confirmations: string | null
  floorBreach: boolean
  breaches: BreachView[]
  tags: ChangeTag[]
  warnings: string[]
  /** The engine's one-line description (title attribute / cold tier). */
  display: string
  /** Not read (a failed getConfig / library / peer read): why — never shown as closed. */
  unread?: string | null
  valueAtRisk?: ValueAtRisk | null
}

export type RouteRowView = {
  eid: number
  chain: string
  local: { send: RouteSideView | null; receive: RouteSideView | null }
  remote: {
    chainId: number | null
    address: string | null
    url: string | null
    send: RouteSideView | null
    receive: RouteSideView | null
    /** REMOTE UNREAD reason; null when the remote side was read. */
    unread: string | null
  } | null
  live: boolean
  /** min E over every LIVE side that was read (local and remote). */
  minE: number | null
  floorBreach: boolean
  /** USD value behind the route (the floor-breach severity rank, owner ruling #9). */
  valueAtRisk?: ValueAtRisk | null
}

export type OAppView = {
  address: string
  /** The subject's label for the contract ("rsETH OFTAdapter"), else the short address. */
  label: string
  url: string | null
  owner: HolderView[]
  delegate: HolderView[]
  routes: RouteRowView[]
  liveRoutes: number
  closedRoutes: number
  remoteRead: number
  remoteUnread: number
}

export type DvnView = {
  name: string
  address: string
  url: string | null
  quorum: number | null
  signers: number | null
}

export type ItemView = {
  key: string
  display: string
  chainId: number
  breaches: BreachView[]
  warnings: string[]
}

export type QueueView = {
  kind: 'oz_timelock' | 'safe' | 'legacy_multisig' | 'dg_timelock'
  address: string
  opId: string
  label: string
  url: string | null
}

export type ConfigChangeView = {
  id: string
  state: ChangeState
  stage: Stage | null
  dimension: Dimension
  title: string
  before: string | null
  after: string | null
  red: boolean
  severity: Severity
  floorBreach: boolean
  ruleIds: string[]
  tags: ChangeTag[]
  stillInEffect: boolean
  announcement: AnnouncementStatus
  /** v1 ingests no governance source: always null (never "announced" without evidence). */
  unannounced: boolean | null
  chainId: number
  block: number | null
  /** Getter change found on the archive grid: it happened in (blockFrom, block]. */
  blockFrom: number | null
  ts: number | null
  eta: number | null
  txUrl: string | null
  queue: QueueView | null
  /** Pending timelock op: who can call execute() ("anyone" when EXECUTOR_ROLE is open). */
  executableBy: string | null
  /** Proposed Safe transaction: "2/5". */
  signatures: string | null
  /** 'both': a peer change (one peer serves the send and the receive direction). */
  route: { eid: number; direction: Direction | 'both'; chain: string } | null
  notes: string[]
}

export type GovChannelView = { kind: 'snapshot' | 'discourse'; label: string; url: string }

export type ProposedSourceView = {
  kind: 'safe_tx_service' | 'snapshot' | 'discourse'
  status: 'ok' | 'unavailable' | 'not_ingested'
  note: string | null
}

export type ConfigCardView = {
  available: boolean
  /** The change / queue files loaded (they can exist while the head-state file does not). */
  changesAvailable: boolean
  reason?: string
  subject: string
  label: string
  symbol: string
  slug: string
  oracleSlug: string | null
  class: ConfigSubject['class']
  asOf: { block: number; ts: number }
  scan: { from: number; to: number }
  announcement: AnnouncementStatus
  govChannels: GovChannelView[]
  proposedSources: ProposedSourceView[]
  counts: ConfigCounts
  delays: DelayChip[]
  /** Every state rule failing now — the persistent red banner (no change event needed). */
  breaches: (BreachView & { dimension: Dimension; key: string })[]
  bridge: {
    oapps: OAppView[]
    dvns: DvnView[]
    /** Non-LayerZero bridges: CCIP pools, Wormhole NTT managers, canonical rollup bridges. */
    ccip: ItemView[]
  }
  oracle: {
    oracleSlug: string | null
    entries: number
    changes: number
    /** Oracle governance events were collected for this subject (else: "not collected"). */
    collected: boolean
    /** The window they cover (days), when known. */
    windowDays: number | null
  }
  admin: { powers: PowerView[]; items: ItemView[] }
  mint: { items: ItemView[] }
  timeline: {
    rows: ConfigChangeView[]
    historicalTotal: number
    historicalShown: number
    /** false ⇒ quiet historical rows were trimmed (every red / in-effect row is always kept). */
    complete: boolean
    /**
     * Counts over the FULL timeline (review round 6: the filter labels counted only the loaded
     * rows, so a trimmed card showed "Oracles 0" next to "2 config changes").
     */
    totals: { all: number; red: number; byDimension: Record<Dimension, number> }
  }
  /** Rule ID → one-line description, for the rule IDs this card uses. */
  rules: Record<string, string>
  notes: string[]
  warnings: string[]
  /** Reads that failed and can hide a red flag (the card never says "no red flags" over them). */
  readGaps?: string[]
}
