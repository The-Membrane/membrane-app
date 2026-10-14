/**
 * Live wavefront engine — chain constants and defaults.
 *
 * Every address here was checked on chain (2026-10-14): the Aave V3 Pool is also resolved at
 * start-up through its PoolAddressesProvider and ASSERTED equal to the value below (a pool or
 * oracle that moved is a stop, not a silent switch); Morpho Blue has bytecode on each chain.
 * Both event topics were checked against real Oct 10 2025 receipts.
 */
import type { ChainKey } from '../../../scripts/oct10-coverage/rpc'
import { ADDRESSES } from '../../../scripts/oct10-coverage/abi'

export type { ChainKey }
export const LIVE_CHAINS: ChainKey[] = ['mainnet', 'arbitrum', 'optimism', 'base']

/** Aave V3 Pool `LiquidationCall(address,address,address,uint256,uint256,address,bool)`. */
export const AAVE_LIQUIDATION_CALL_TOPIC =
  '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286'
/** Morpho Blue `Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)`. */
export const MORPHO_LIQUIDATE_TOPIC =
  '0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41'

export interface ChainConfig {
  chain: ChainKey
  /**
   * Aave V3 PoolAddressesProviderRegistry: EVERY Aave V3 market of the chain is resolved from it
   * at start-up and again every day (mainnet: Core, Lido, EtherFi; the L2s: Core only — checked
   * 2026-10-14 at the Oct 10 2025 blocks and at the head).
   */
  aaveRegistry: string
  /** The Core market's PoolAddressesProvider (the market the Oct 10 census covered). */
  aaveProvider: string
  /** The Pool the Core provider must resolve to (lower case). */
  aavePool: string
  /** The AaveOracle the Core provider must resolve to (lower case). */
  aaveOracle: string
  /** Morpho Blue singleton (lower case). */
  morpho: string
  /**
   * Blocks behind the head that are read at all (reorg safety). Mainnet 3 blocks (~36 s);
   * the L2s about 30 s of blocks (OP-stack 2 s blocks, Arbitrum ~0.25 s).
   */
  confirmations: number
  /** Nominal seconds per block — first guesses in block searches only. */
  blockSeconds: number
  /** Widest eth_getLogs span asked in one call (halved on a refusal). */
  logChunk: number
}

const lc = (s: string) => s.toLowerCase()

export const CHAIN_CONFIG: Record<ChainKey, ChainConfig> = {
  mainnet: {
    chain: 'mainnet',
    aaveRegistry: lc('0xbaA999AC55EAce41CcAE355c77809e68Bb345170'),
    aaveProvider: ADDRESSES.mainnet.provider,
    aavePool: lc('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'),
    aaveOracle: lc(ADDRESSES.mainnet.oracle),
    morpho: lc('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'),
    confirmations: 3,
    blockSeconds: 12,
    logChunk: 2_000,
  },
  arbitrum: {
    chain: 'arbitrum',
    aaveRegistry: lc('0x770ef9f4fe897e59daCc474EF11238303F9552b6'),
    aaveProvider: ADDRESSES.arbitrum.provider,
    aavePool: lc('0x794a61358D6845594F94dc1DB02A252b5b4814aD'),
    aaveOracle: lc(ADDRESSES.arbitrum.oracle),
    morpho: lc('0x6c247b1F6182318877311737BaC0844bAa518F5e'),
    confirmations: 120,
    blockSeconds: 0.25,
    logChunk: 20_000,
  },
  optimism: {
    chain: 'optimism',
    aaveRegistry: lc('0x770ef9f4fe897e59daCc474EF11238303F9552b6'),
    aaveProvider: ADDRESSES.optimism.provider,
    aavePool: lc('0x794a61358D6845594F94dc1DB02A252b5b4814aD'),
    aaveOracle: lc(ADDRESSES.optimism.oracle),
    morpho: lc('0xce95AfbB8EA029495c66020883F87aaE8864AF92'),
    confirmations: 15,
    blockSeconds: 2,
    logChunk: 10_000,
  },
  base: {
    chain: 'base',
    aaveRegistry: lc('0x2f6571d3Eb9a4e350C68C36bCD2afe39530078E2'),
    aaveProvider: ADDRESSES.base.provider,
    aavePool: lc('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'),
    aaveOracle: lc(ADDRESSES.base.oracle),
    morpho: lc('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'),
    confirmations: 15,
    blockSeconds: 2,
    logChunk: 10_000,
  },
}

/** Seconds of confirmations, for scheduling polls (not for correctness). */
export const confirmSeconds = (c: ChainConfig) => Math.ceil(c.confirmations * c.blockSeconds)

/**
 * Symbols that get their own cluster (lib/wavefront/cluster.ts). The census derives them from
 * the counts of the whole two-day window (>= 20 positions); a live stream cannot see its
 * future, so it takes the list as a parameter. Default: the Oct 10-11 census's own clusters.
 */
export const DEFAULT_OWN_CLUSTERS: readonly string[] = ['AERO', 'CRV', 'Mog', 'PEPE', 'UNI']

/** Re-resolve the Aave markets from the registry this often (minutes of stream time). */
export const MARKETS_REFRESH_MINUTES = 24 * 60

export interface EngineDefaults {
  /** A position with no timer armed and no activity for this many minutes is closed. */
  horizonMinutes: number
  /** Reconciliation cadence and look-back, minutes of stream time. */
  reconcileEveryMinutes: number
  reconcileWindowMinutes: number
  /** A minute processed more than this many seconds after it ended is flagged backfilled. */
  backfillLagSeconds: number
  /** Seconds between head polls while waiting for a minute to confirm (live). */
  pollSeconds: number
  /** Parallel per-event reads. */
  readConcurrency: number
}

export const DEFAULTS: EngineDefaults = {
  horizonMinutes: 7 * 24 * 60,
  reconcileEveryMinutes: 60,
  reconcileWindowMinutes: 120,
  backfillLagSeconds: 180,
  pollSeconds: 10,
  readConcurrency: 12,
}
