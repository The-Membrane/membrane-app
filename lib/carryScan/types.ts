/**
 * WEEKLY CARRY SCOUT — shared types and thresholds (umbrella product #10).
 *
 * The scan ranks Ethereum stablecoin venues on (a) market carry — the venue's net APY at
 * a size minus the cheapest same-stable borrow — and shows (b) Membrane carry beside it.
 * Docs of record: docs/CARRY_SCOUT.md.
 *
 * KEYS. A row's key is `1:<lowercase deposit/receipt contract>` (a Morpho market is
 * `1:<morpho>:<marketId>`). DeFiLlama pool UUIDs are aliases only. A scout key is NOT a
 * venue key: nothing here mints a name in tools/venue-recorder.config.json, and no output
 * field is called `venueKey` or `name` (tests/unit/carryScanDedupe.test.ts).
 *
 * UNITS. Every rate is a fraction per year (0.05 = 5%), like lib/netApy. DeFiLlama
 * publishes percent; the conversion happens once, where its rows are read.
 *
 * COPY. "Positive carry" means the spread measured at the last scan — never a promise.
 * Membrane's charge is a curator-set share of yield: never 0%, $0 or "free".
 */

import type { LabelClass } from '../netApy/types'

export const CARRY_SCAN_SCHEMA_VERSION = 1 as const

export const SCAN_SIZES_USD = [100_000, 1_000_000, 10_000_000] as const
export type ScanSize = (typeof SCAN_SIZES_USD)[number]
/** Default ranking size: the same default as /api/net-apy (lib/netApy/service.ts parseQuery). */
export const DEFAULT_SCAN_SIZE: ScanSize = 100_000
export type SizeKey = '100k' | '1m' | '10m'
export const SIZE_KEYS: readonly SizeKey[] = ['100k', '1m', '10m']
export const sizeKeyOf = (n: number): SizeKey =>
  n >= 10_000_000 ? '10m' : n >= 1_000_000 ? '1m' : '100k'
export const sizeUsdOf = (k: SizeKey): ScanSize =>
  k === '10m' ? 10_000_000 : k === '1m' ? 1_000_000 : 100_000

/** Every threshold in one place, each with its evidence in docs/CARRY_SCOUT.md §1/§6. */
export const THRESHOLDS = {
  minTvlUsd: 10_000_000,
  minCount: 30,
  badgeCount: 90,
  maxRewardShare: 0.5,
  minBenchBorrowUsd: 5_000_000,
  /** A size above this share of TVL is shown as "size > 5% of TVL" and unranked at that size. */
  maxSizeShareOfTvl: 0.05,
  /** Finalist stability, from the 90-day chart: σ in percentage points, and current ≤ 1.5 × median. */
  maxSigma90Pp: 1.0,
  maxSpikeRatio: 1.5,
  /** On-chain totalAssets at $1 must sit within ±15% of DeFiLlama tvlUsd. */
  tvlTolerance: 0.15,
  /** 7-day convertToAssets growth vs apyBase7d (else the base APY): more than 1pp apart is "source disagreement". */
  sourceDisagreementPp: 1.0,
  finalistsRanked: 40,
  finalistsNoBench: 20,
  finalistsLp: 20,
  finalistsMax: 80,
  chartCallsPerMinute: 20,
  /** Gate 1: the /pools Ethereum stablecoin count within ±30% of last week's. */
  universeCountTolerance: 0.3,
  universeBaselineCount: 1313,
  /** Gate 2: on-chain vs DeFiLlama benchmark for USDC/USDT within 0.5pp. */
  benchAgreementPp: 0.5,
  /** Gate 3: at least half the finalists must verify on-chain. */
  minVerifiedShare: 0.5,
  /** Gate 4 (churn): held when NEW > 15 or the ranked count moves > 50% week over week. */
  maxNew: 15,
  maxRankedSwing: 0.5,
  staleDays: 8,
  statusWindowWeeks: 8,
  persistentWindow: 4,
  persistentMin: 3,
} as const

/** Stables the gate requires a benchmark for (gate 2). */
export const REQUIRED_BENCH_STABLES = ['USDC', 'USDT', 'USDS', 'DAI'] as const
/** Stables whose on-chain and DeFiLlama benchmarks must agree (gate 2). */
export const AGREEMENT_STABLES = ['USDC', 'USDT'] as const

// ----------------------------------------------------------------- source rows

/** The slice of a DeFiLlama `/pools` row the scan reads (APY fields in percent). */
export interface LlamaPool {
  pool: string
  chain: string
  project: string
  symbol: string
  tvlUsd: number
  apy: number | null
  apyBase: number | null
  apyReward: number | null
  apyBase7d?: number | null
  apyMean30d: number | null
  stablecoin: boolean
  exposure: string
  ilRisk: string
  poolMeta: string | null
  count: number | null
  outlier: boolean
  underlyingTokens: string[] | null
}

/** The slice of a DeFiLlama `/lendBorrow` row (joined to /pools on `pool`). */
export interface LlamaLendBorrow {
  pool: string
  apyBaseBorrow: number | null
  apyRewardBorrow: number | null
  totalSupplyUsd: number | null
  totalBorrowUsd: number | null
  /** The LOAN asset's symbol on a CDP/Morpho row. On a Morpho row `symbol`, `underlyingTokens`
   *  and `tvlUsd` of the joined pool describe the COLLATERAL (the Morpho trap). */
  mintedCoin: string | null
  ltv: number | null
  underlyingTokens: string[] | null
}

export interface LlamaProtocol {
  slug: string
  name: string
  category: string | null
}

export interface MorphoVaultInfo {
  address: string
  symbol: string
  name: string
  assetAddress: string
  version: 'v1' | 'v2'
  netApy: number | null
  fee: number | null
  totalAssetsUsd: number | null
}

export interface MorphoMarketInfo {
  marketId: string
  lltv: number
  loanSymbol: string
  loanAddress: string
  collateralSymbol: string | null
  collateralAddress: string | null
  borrowAssetsUsd: number | null
}

export interface ChartPoint {
  timestamp: string
  apy: number | null
}

// ------------------------------------------------------------------ config files

export interface StableEntry {
  symbol: string
  address: string
  decimals: number
  peg: 'USD'
}
export interface StablesConfig {
  verifiedAt: { date: string; block: number; note: string }
  stables: StableEntry[]
  blueChipCollateral: { symbol: string; address: string; decimals: number }[]
}

export interface ProjectsConfig {
  categoryAllow: string[]
  categoryFlag: Record<string, string>
  lpCategoryAllow: string[]
  projectDeny: Record<string, string>
  benchmark: {
    aaveV3Project: string
    aaveV3PoolMeta: (string | null)[]
    aaveV3DenyPoolMeta: string[]
    sparkProject: string
    morphoProject: string
    /** Projects whose DeFiLlama `apyBaseBorrow` is the on-chain APR, not an APY (converted in S3). */
    borrowRateIsAprProjects?: string[]
  }
}

export type ScoutKind =
  | 'aave-reserve'
  | 'spark-reserve'
  | 'metamorpho'
  | 'morpho-vault-v2'
  | 'euler'
  | 'erc4626'
  | 'lp'
  | 'compound'
  | 'other'

export interface PoolAddressEntry {
  address: string
  kind: ScoutKind
  label: string
  verifiedAt: string
  note?: string
  /** 'queued' = exits wait on a queue or cooldown (Maple, sUSDe): not instantly withdrawable. */
  withdraw?: 'instant' | 'queued'
}

// ------------------------------------------------------------------ pipeline

/** A pool that entered the universe (S1), with its stables resolved. */
export interface Candidate {
  pool: LlamaPool
  stables: StableEntry[]
  category: string | null
  flags: string[]
  exposure: 'single' | 'multi'
}

export interface Valued {
  apy: number | null
  /** Same figure as an APR (ln(1+apy)), what the Membrane split is applied to. */
  apr: number | null
  labelClass: LabelClass
  note?: string
}

export interface Carry {
  apy: number | null
  bound: 'exact' | 'upper'
  /** Where the figure comes from: the weaker of its inputs' classes (lib/netApy/types.ts). */
  labelClass: LabelClass
  note?: string
}

export interface CarryB {
  /** Base yield only — what the vaults collect today. */
  base: Carry
  /** Base + eligible incentives, IF vaults claimed rewards. They do not yet. */
  withRewards: Carry
}

export interface BenchRef {
  venue: string
  stable: string
  apy: number
  labelClass: LabelClass
  source: 'onchain' | 'defillama'
}

export type ScoutList = 'ranked' | 'lp' | 'no-benchmark' | 'unverified'
export type ScoutStatus = 'NEW' | 'STILL' | 'RETURNING'
/** `unresolved` = the scan found no deposit contract, so nothing is known about the venue type. */
export type ReadinessTier =
  | 'ready-cv'
  | 'ready-dv'
  | 'needs-adapter'
  | 'not-deployable'
  | 'unresolved'

export interface Readiness {
  tier: ReadinessTier
  blockers: string[]
  route: string
}

export interface Segue {
  kind: 'cv-propose' | 'dv-create' | 'none'
  implId?: string
  venueData?: string
}

export interface Stability {
  sigma90Pp: number | null
  median90: number | null
  spikeRatio: number | null
  points: number
  ok: boolean
  reason?: string
}

export interface Verification {
  ok: boolean
  checks: string[]
  failed?: string
  /** On-chain share-price growth over 7 days, as an APY. */
  trailing7dApy?: number | null
}

export interface ScoutRow {
  key: string | null
  aliases: string[]
  label: string
  protocol: string
  category: string | null
  kind: ScoutKind
  stable: string
  stables: string[]
  exposure: 'single' | 'multi'
  address: string | null
  tvlUsd: number
  count: number
  apy: number
  apyBase: number | null
  apyReward: number | null
  apyMean30d: number | null
  venueNet: Record<SizeKey, Valued>
  venueNetBase: Record<SizeKey, Valued>
  bench: Record<SizeKey, BenchRef | null>
  carryA: Record<SizeKey, Carry | null>
  carryABase: Record<SizeKey, Carry | null>
  /** apyMean30d − this week's benchmark at the default size (DeFiLlama's borrow-rate history, chartLendBorrow, is a paid endpoint). */
  carryA30d: number | null
  carryB: Record<SizeKey, CarryB>
  stability: Stability | null
  verification: Verification | null
  flags: string[]
  list: ScoutList
  rank: number | null
  unrankedReason?: string
  status: ScoutStatus | null
  weeksInRow: number
  persistent: boolean | null
  readiness: Readiness
  segue: Segue
  /** Serialized NetBreakdown at the default size, for on-chain priced lending rows only. */
  breakdown: unknown | null
}

export interface DroppedRow {
  key: string
  aliases: string[]
  label: string
  protocol: string
  stable: string
  failedGate: string
  lastPassedWeek: string
}

export interface NowOnAppRow {
  key: string
  label: string
  protocol: string
  stable: string
  note: string
}

export interface BenchmarkTable {
  [stable: string]: {
    bySize: Record<SizeKey, BenchRef | null>
    candidates: {
      venue: string
      source: 'onchain' | 'defillama'
      labelClass: LabelClass
      apyBySize: Record<SizeKey, number | null>
      borrowUsd: number | null
      note?: string
    }[]
  }
}

export interface StageCounts {
  ethStablePools: number
  universeSingle: number
  universeLp: number
  afterFilters: number
  afterFiltersLp: number
  withBenchmark: number
  positive: number
  noBenchmark: number
  onApp: number
  finalists: number
  verified: number
  stable: number
  ranked: number
  rankedLp: number
  unverified: number
  dropped: number
  new: number
  gateTrace: Record<string, number>
}

export interface CarryScanFile {
  schemaVersion: typeof CARRY_SCAN_SCHEMA_VERSION
  week: string
  asOf: number
  anchor: { blockNumber: string; blockTimestamp: string; blockHash: string } | null
  appSha: string | null
  rpc: string
  defaultSizeUsd: number
  sizes: number[]
  counts: StageCounts
  benchmarks: BenchmarkTable
  rows: ScoutRow[]
  dropped: DroppedRow[]
  nowOnApp: NowOnAppRow[]
  sources: { name: string; ok: boolean; rows: number | null }[]
  notes: string[]
}

export interface CarryScanStatus {
  lastAttempt: number
  week: string
  ok: boolean
  held?: boolean
  reason: string | null
  lastGoodWeek: string | null
}

/** The slice of a past weekly file the status stage reads. */
export interface PastWeek {
  week: string
  rows: {
    key: string | null
    list: ScoutList
    /** Only the spread is read; files written before label classes existed lack them. */
    carryA?: Partial<Record<SizeKey, Pick<Carry, 'apy'> | null>>
    label?: string
    protocol?: string
    stable?: string
    aliases?: string[]
  }[]
  counts?: { ranked?: number; ethStablePools?: number }
}
