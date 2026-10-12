/**
 * Curator action feed — shared types. Pure.
 *
 * Amounts are decimal strings of the token's base units (JSON has no bigint); USD figures
 * are numbers priced at collection time and always labelled as such. Times are unix
 * seconds; blocks are numbers. Addresses and ids are lowercase 0x-hex.
 */

import type { EmitterKind } from './abi'

export type Protocol = 'morpho-v1' | 'morpho-v2' | 'euler-earn' | 'aave-v3'

export const PROTOCOL_OF: Partial<Record<EmitterKind, Protocol>> = {
  mm: 'morpho-v1',
  v2: 'morpho-v2',
  v2adapter: 'morpho-v2',
  ee: 'euler-earn',
  aave: 'aave-v3',
}

/**
 * What a curator (or a protocol's governance, for Aave) did. Grouped:
 *   caps        cap_submit (timelocked raise) · cap_raise · cap_cut · cap_zero · cap_revoke
 *   removal     removal_submit · removal_revoke · market_removed · market_added
 *   deposits    supply_queue_add · supply_queue_remove
 *   timelock    timelock_submit · timelock_set · timelock_revoke
 *   roles       curator_set · allocator_set · guardian_submit · guardian_set · guardian_revoke
 *               · owner_set · sentinel_set
 *   v2 config   adapter_add · adapter_remove · v2_submit (other timelocked call) · v2_revoke
 *   v2 adapter  writeoff_submit (timelocked burnShares) · writeoff (BurnShares: the adapter
 *               drops a market position from the vault's books); other adapter calls reuse
 *               v2_submit / v2_revoke / timelock_set with `via` = the adapter
 *   aave        freeze · unfreeze · pause · unpause · borrow_off · borrow_on · ltv_zero
 *               · collateral_params  (supply/borrow caps reuse cap_raise / cap_cut)
 */
export type ActionKind =
  | 'cap_submit'
  | 'cap_raise'
  | 'cap_cut'
  | 'cap_zero'
  | 'cap_revoke'
  | 'removal_submit'
  | 'removal_revoke'
  | 'market_removed'
  | 'market_added'
  | 'supply_queue_add'
  | 'supply_queue_remove'
  | 'timelock_submit'
  | 'timelock_set'
  | 'timelock_revoke'
  | 'curator_set'
  | 'allocator_set'
  | 'guardian_submit'
  | 'guardian_set'
  | 'guardian_revoke'
  | 'owner_set'
  | 'sentinel_set'
  | 'adapter_add'
  | 'adapter_remove'
  | 'v2_submit'
  | 'v2_revoke'
  | 'writeoff_submit'
  | 'writeoff'
  | 'freeze'
  | 'unfreeze'
  | 'pause'
  | 'unpause'
  | 'borrow_off'
  | 'borrow_on'
  | 'ltv_zero'
  | 'collateral_params'

/** Kinds that take a vault (or a protocol) out of an asset. Clusters are built from these. */
export const EXIT_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'cap_zero',
  'removal_submit',
  'market_removed',
  'writeoff_submit',
  'writeoff',
])
/** Protocol-level analogues (Aave). Shown beside clusters, never counted as a curator. */
export const PROTOCOL_EXIT_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'freeze',
  'pause',
  'borrow_off',
  'ltv_zero',
])

/**
 * What a cap / removal / timelock id points at.
 *   market      a Morpho Blue market id (V1 vault, or V2 "this/marketParams")
 *   strategy    an Euler Earn strategy (an EVK vault address)
 *   collateral  a V2 "collateralToken" id — every market with that collateral
 *   adapter     a V2 "this" id — one adapter (a market adapter or a V1-vault adapter)
 *   reserve     an Aave reserve (asset address)
 */
export type Scope = 'market' | 'strategy' | 'collateral' | 'adapter' | 'reserve' | 'vault'

export interface FeedAction {
  /** `${tx}:${logIndex}` — unique, stable. */
  id: string
  protocol: Protocol
  /** Emitting vault. For Aave: the PoolConfigurator address. For a Vault V2 adapter's
   *  event: the adapter's parent vault (the adapter is in `via`). */
  vault: string
  /** Vault V2 adapter that emitted the event, when it was not the vault itself. */
  via?: string
  kind: ActionKind
  scope: Scope
  /** Market id / strategy / V2 cap id / Aave asset. Absent for vault-wide actions. */
  target?: string
  /** Collateral token(s) the target exposes the vault to. [] = idle market / unknown. */
  collateral: string[]
  /** Loan / vault asset, when known. */
  loan?: string
  /** Previous and new value as decimal strings (cap, timelock seconds, …). */
  from?: string
  to?: string
  /** Which cap: Aave supply vs borrow; V2 absolute vs relative. */
  capType?: 'supply' | 'borrow' | 'absolute' | 'relative'
  /** The account that called (indexed `caller`/`sender`), when the event names one. */
  actor?: string
  /** Free-form, factual (e.g. the V2 function a Submit queued). */
  note?: string
  block: number
  ts: number
  tx: string
  /** Submit-type actions only: when it becomes executable (unix s), and how it ended. */
  validAt?: number
  /** How the chain measured validAt: read from the contract, or event-derived. */
  validAtSource?: 'event' | 'chain' | 'derived'
  resolution?: { how: 'accepted' | 'revoked'; block: number; ts: number; tx: string }
  /** Open submits only: the head-time contract read shows it still pending (true) or
   *  cleared although no accept/revoke event was collected (false). */
  headPending?: boolean
  /**
   * Exit actions only, read at the exit's block: does the vault still have a positive cap
   * on ANOTHER market / strategy with this collateral (V2: collateral cap and another
   * market cap both open)? true = a migration or partial cut, not an exit from the asset.
   * Undefined when the read was not possible.
   */
  stillCapped?: boolean
  /** writeoff only: the written-off position in loan-token base units (shares priced at
   *  the end of the block before), when the collector could read it. */
  assets?: string
  /** market_removed only: a SubmitMarketRemoval preceded it (forced removal path). */
  forced?: boolean
}

/** Display status, computed against a clock (never stored — the clock moves). */
export type ActionStatus =
  | 'pending'
  | 'executable'
  | 'accepted'
  | 'revoked'
  | 'cleared'
  | 'executed'

// ── reallocation flows ─────────────────────────────────────────────────────────

export type FlowSource = 'allocator' | 'public-allocator'

/** One reallocation leg, decoded. `assets` > 0 in = supplied, out = withdrawn. */
export interface Reallocation {
  protocol: Protocol
  vault: string
  /** Morpho market id, Euler strategy, or V2 adapter (when ids do not map to a market). */
  target: string
  dir: 'in' | 'out'
  assets: bigint
  source: FlowSource
  actor: string
  block: number
  ts: number
  tx: string
  logIndex: number
}

/** Daily aggregate per (vault, target, source). Amounts in loan-token base units. */
export interface DailyFlow {
  /** UTC day, 'YYYY-MM-DD'. */
  day: string
  vault: string
  target: string
  source: FlowSource
  out: string
  in: string
  n: number
}

// ── exposure ───────────────────────────────────────────────────────────────────

export interface ExposureAlloc {
  /** Morpho market id, Euler strategy, or V1 vault (for V2 via a V1-vault adapter). */
  target: string
  scope: 'market' | 'strategy'
  collateral: string[]
  /** Loan-token base units. */
  assets: string
  usd?: number
  /** Fraction of the vault's total assets, 0–1. */
  share: number
  /** V2 only: the adapter / underlying V1 vault the allocation passes through. */
  via?: string
  cap?: string
}

export interface ExposureVault {
  vault: string
  protocol: Protocol
  /** totalAssets() as the vault reports it. MetaMorpho v1.1 counts `lostAssets` in it. */
  totalAssets: string
  totalUsd?: number
  /** MetaMorpho v1.1 lostAssets(): assets written off that totalAssets() still counts. */
  lostAssets?: string
  allocations: ExposureAlloc[]
}

// ── attribution ────────────────────────────────────────────────────────────────

export interface MarketState {
  totalSupplyAssets: string
  totalBorrowAssets: string
  /** Borrow rate per second, WAD (1e18), from the market's IRM view. */
  borrowRate?: string
}

/** A large reallocation withdrawal and the market state at the end of the blocks around it. */
export interface AttributionCase {
  market: string
  block: number
  ts: number
  /** All vault reallocation withdrawals from this market in this block. */
  legs: { vault: string; assets: string; source: FlowSource; tx: string }[]
  before?: MarketState
  after?: MarketState
}

// ── rate spikes (spike-first attribution) ──────────────────────────────────────

/**
 * Who moved a market's supply or borrow in the block that set a new borrow rate.
 *   supply side  vault-reallocation (an allocator moved the vault's money; `source` says
 *                whether the Public Allocator triggered it) · vault-redemption (the vault
 *                withdrew to pay its own depositors) · vault-deposit · supplier-withdrawal
 *                / supplier-deposit (a non-vault supplier) · bad-debt (written off)
 *   borrow side  borrow · repay · liquidation (repaid) · bad-debt
 */
export type SpikeDriver =
  | 'vault-reallocation'
  | 'vault-redemption'
  | 'vault-deposit'
  | 'supplier-withdrawal'
  | 'supplier-deposit'
  | 'borrow'
  | 'repay'
  | 'liquidation'
  | 'bad-debt'

export interface SpikeFlow {
  driver: SpikeDriver
  side: 'supply' | 'borrow'
  /** −1 = the side's total fell (a withdrawal, a repay), +1 = it rose. */
  sign: 1 | -1
  /** Magnitude, loan-token base units. Summed per (driver, side, vault). */
  assets: string
  /** The vault (a V2 adapter is mapped to its vault). */
  vault?: string
  source?: FlowSource
  /** One transaction of the group, for a link. */
  tx: string
  /** Logs summed into this row. */
  n: number
}

/**
 * One jump in a Morpho Blue market's borrow rate, and every supply / borrow change in
 * the block whose interactions set it. The rate pair comes from consecutive
 * AccrueInterest logs: accrual i reports the rate that applied since accrual i−1, so the
 * change between the two rates was made in accrual i−1's block (`block`).
 */
export interface SpikeCase {
  market: string
  block: number
  ts: number
  /** Per-second WAD rates, as decimal strings. */
  rateBefore: string
  rateAfter: string
  before?: MarketState
  after?: MarketState
  flows: SpikeFlow[]
}

// ── labels ─────────────────────────────────────────────────────────────────────

export interface TokenInfo {
  symbol: string
  decimals: number
  /** Collection-time USD price (Morpho API), when known. */
  priceUsd?: number
  /** Pendle PT maturity (unix s) from the token's expiry(), when it has one. */
  expiry?: number
}
export interface MarketInfo {
  loan: string
  collateral: string
  oracle: string
  irm: string
  /** WAD string. */
  lltv: string
}
export interface VaultInfo {
  protocol: Protocol
  name: string
  asset: string
  curator?: string
  owner?: string
  /** Key into `curators`. Falls back to curator address, then owner address. */
  curatorKey: string
  /** Seconds (V1 / Euler Earn). */
  timelock?: number
  /**
   * Vault V2 timelocks read at the head, seconds, per function: increaseAbsoluteCap,
   * increaseRelativeCap, addAdapter, setIsAllocator, and `adapter.burnShares` for its
   * market adapter. 0 = the curator can do it in one transaction.
   */
  timelocks?: Record<string, number>
}
export interface CuratorInfo {
  name: string
  /** Where the name came from (Morpho API registry, Euler labels, or none). */
  source: 'morpho-api' | 'euler-labels' | 'address'
}
export interface StrategyInfo {
  name: string
  asset: string
  collateral: string[]
}

export interface Entities {
  tokens: Record<string, TokenInfo>
  markets: Record<string, MarketInfo>
  vaults: Record<string, VaultInfo>
  curators: Record<string, CuratorInfo>
  strategies: Record<string, StrategyInfo>
  /** Aave PoolConfigurator → market label, e.g. "Aave v3 Core". */
  aaveMarkets: Record<string, string>
  /** Vault V2 cap id → decoded idData. */
  v2Ids: Record<
    string,
    {
      type: 'collateral' | 'market' | 'adapter'
      collateral?: string
      market?: string
      adapter?: string
    }
  >
}

// ── clusters ───────────────────────────────────────────────────────────────────

export interface ExitCluster {
  collateral: string
  start: number
  end: number
  /** Shortest window (hours) that holds exits from ≥ minCurators distinct curators. */
  tightestHours: number
  curators: string[]
  vaults: string[]
  actionIds: string[]
  /** Aave freezes / LTV-zero on the same asset inside the cluster's window. */
  protocolActionIds: string[]
}

// ── flags: market facts at the head, curator exposure shifts (flags.ts) ────────

/**
 * What a Morpho Blue market's oracle prices the collateral FROM (flags.ts classifyOracle):
 *   fixed       no feed and no vault: price() is a constant
 *   reported    every input is a reported value (a NAV / fundamental / exchange-rate feed,
 *               or a vault rate whose asset is not the loan token) — no market price
 *   vault-rate  one ERC-4626 vault rate into its own asset, which is the loan token
 *   market      at least one input is a market price feed
 *   unknown     not a MorphoChainlinkOracleV2, or a feed whose description is unreadable
 */
export type OracleKind = 'fixed' | 'reported' | 'vault-rate' | 'market' | 'unknown'

export interface OraclePart {
  role: 'baseFeed1' | 'baseFeed2' | 'quoteFeed1' | 'quoteFeed2' | 'baseVault' | 'quoteVault'
  address: string
  /** Feed description() when readable. */
  description?: string
  /** Vault parts: the vault's asset(). */
  asset?: string
}

export interface MarketFlags {
  oracle: string
  oracleKind: OracleKind
  parts: OraclePart[]
  /** price() at the head (1e36-scaled decimal string); absent when it reverts. */
  price?: string
  /** price() reverts at the head. `since`: first block of the current run of reverts;
   *  `beforeWindow`: it reverted at every block probed back to `since` (Morpho Blue's
   *  deployment; the window's first block in files written before 2026-10-11). */
  reverting?: { since: number; sinceTs: number; beforeWindow?: boolean }
  /** Seconds since the OLDEST update among the feeds that answer, at the head. */
  staleSeconds?: number
  /** Largest borrower at the last exposure read: Morpho API ranking, amounts read on chain
   *  (loan-token base units). */
  borrowers?: {
    top: string
    topAssets: string
    secondAssets?: string
    totalBorrow: string
    totalSupply: string
    block: number
  }
  /** market() supply / borrow assets at the head and `lockedDays` earlier (loan-token base
   *  units). Read only when borrows are ≥ `lockedUtil` of supply at the head (flag 5). */
  fill?: {
    block: number
    supply: string
    borrow: string
    /** market().lastUpdate at the head: interest is accrued in supply / borrow to here. */
    lastUpdate: number
    prevBlock: number
    prevTs: number
    prevSupply: string
    prevBorrow: string
  }
}

/** One curator's vaults moving a market position between each other on one UTC day,
 *  followed by the vaults that gave it up cutting that collateral (flags.ts detectShifts). */
export interface CuratorShift {
  curator: string
  market: string
  day: string
  /** Net change of each vault's position that day, whole loan-token units. */
  from: { vault: string; amount: number }[]
  to: { vault: string; amount: number }[]
  /** The smaller side (moved out vs moved in), USD at collection-time prices. */
  usd?: number
  /** First exit action (cap to 0, removal, write-off) of each from-vault on that collateral. */
  cuts: { vault: string; actionId: string; ts: number }[]
}

export interface FeedFlags {
  block: number
  ts: number
  /** Only markets with at least one fact worth showing (flags.ts hasMarketFlag). */
  markets: Record<string, MarketFlags>
  shifts: CuratorShift[]
}
