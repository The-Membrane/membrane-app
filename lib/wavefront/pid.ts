/**
 * POSITION IDS — one module for every writer and reader of the wavefront stream (the live engine
 * now; the census adopts it when it moves to every Aave market).
 *
 *   aave-v3:<chain>:<pool>:<user>               one Aave V3 account IN ONE POOL
 *   morpho-blue:<chain>:<marketId>:<borrower>   one Morpho Blue position (unchanged)
 *
 * All lower case. WHY THE POOL. Ethereum has three Aave V3 pools in the registry (Core
 * 0x87870bca…, Lido 0x4e033931…, EtherFi 0x0aa97c28…), each with its own reserves, oracle and
 * health factor: the same address borrowing on two of them is two positions that are liquidated
 * independently. The pool ADDRESS (not a market label) is the id: it is what the LiquidationCall
 * log carries, it never needs a lookup table, and it cannot collide. Labels for display come from
 * the provider's getMarketId() (`aaveMarketLabel`).
 *
 * LEGACY. The Oct 10-11 census (Core pools only) wrote `aave-v3:<chain>:<user>`.
 * `parseAnyPid` reads both; `legacyPid` maps a Core-pool id back to it (used to compare the live
 * engine with that census).
 */
export type PidProtocol = 'aave-v3' | 'morpho-blue'

const lc = (s: string) => s.toLowerCase()

export const aavePid = (chain: string, pool: string, user: string) =>
  `aave-v3:${chain}:${lc(pool)}:${lc(user)}`

export const morphoPid = (chain: string, marketId: string, borrower: string) =>
  `morpho-blue:${chain}:${lc(marketId)}:${lc(borrower)}`

export interface ParsedPid {
  protocol: PidProtocol
  chain: string
  /** Aave: the pool (null for a legacy id); Morpho: the market id. */
  market: string | null
  /** User / borrower. */
  addr: string
}

/** Parse a pid in the current or the legacy (census) form. */
export function parseAnyPid(pid: string): ParsedPid {
  const p = pid.split(':')
  if (p[0] === 'aave-v3' && p.length === 4)
    return { protocol: 'aave-v3', chain: p[1], market: p[2], addr: p[3] }
  if (p[0] === 'aave-v3' && p.length === 3)
    return { protocol: 'aave-v3', chain: p[1], market: null, addr: p[2] }
  if (p[0] === 'morpho-blue' && p.length === 4)
    return { protocol: 'morpho-blue', chain: p[1], market: p[2], addr: p[3] }
  throw new Error(`bad pid ${pid}`)
}

/** The census's legacy id of an Aave position (pool dropped); Morpho ids are unchanged. */
export function legacyPid(pid: string): string {
  const p = parseAnyPid(pid)
  return p.protocol === 'aave-v3' ? `aave-v3:${p.chain}:${p.addr}` : pid
}

/** The Core pool of each chain (what the Oct 10-11 census covered). */
export const AAVE_CORE_POOL: Record<string, string> = {
  mainnet: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  arbitrum: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
  optimism: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
  base: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5',
}

/** Short display label of a pool (from its provider's market id when known). */
export function aaveMarketLabel(chain: string, pool: string, marketId?: string): string {
  if (AAVE_CORE_POOL[chain] === lc(pool)) return 'core'
  const m = (marketId ?? '').toLowerCase()
  if (m.includes('lido')) return 'lido'
  if (m.includes('etherfi')) return 'etherfi'
  return lc(pool).slice(0, 10)
}
