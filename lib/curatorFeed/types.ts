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
  /** Emitting vault. For Aave: the PoolConfigurator address. */
  vault: string
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
  totalAssets: string
  totalUsd?: number
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
