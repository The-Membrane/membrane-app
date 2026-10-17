/**
 * Decoding of the two liquidation events, token-unit normalisation, and a JSON codec that keeps
 * non-finite numbers (the engine's durable state holds -Infinity / Infinity in a few places).
 */
import { formatUnits } from 'viem'
import { aavePid, morphoPid } from '../pid'
import { AAVE_LIQUIDATION_CALL_TOPIC, MORPHO_LIQUIDATE_TOPIC, type ChainKey } from './config'

/** A raw eth_getLogs entry. */
export interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  blockHash?: string
  transactionHash: string
  logIndex: string
  removed?: boolean
}

interface EventBase {
  chain: ChainKey
  block: number
  blockHash: string
  tx: string
  logIndex: number
  /** Block timestamp (filled from the block header, never from the log). */
  ts: number
  pid: string
}

/** Aave V3 Pool LiquidationCall. Amounts are raw integers (decimal strings). */
export interface AaveLiquidation extends EventBase {
  protocol: 'aave-v3'
  /** The Aave V3 Pool that emitted the log (pids carry it: lib/wavefront/pid.ts). */
  pool: string
  collateralAsset: string
  debtAsset: string
  user: string
  debtToCover: string
  liquidatedCollateralAmount: string
  liquidator: string
  receiveAToken: boolean
}

/** Morpho Blue Liquidate. Amounts are raw integers (decimal strings). */
export interface MorphoLiquidation extends EventBase {
  protocol: 'morpho-blue'
  marketId: string
  caller: string
  borrower: string
  repaidAssets: string
  repaidShares: string
  seizedAssets: string
  badDebtAssets: string
  badDebtShares: string
}

export type LiqEvent = AaveLiquidation | MorphoLiquidation

const word = (data: string, i: number) => '0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1))
const addr = (w: string) => ('0x' + w.slice(-40)).toLowerCase()
const uint = (w: string) => BigInt(w).toString()

export const eventKey = (e: { chain: string; tx: string; logIndex: number }) =>
  `${e.chain}:${e.tx.toLowerCase()}:${e.logIndex}`

/**
 * Decode one log of either topic, or throw (a log we asked for that does not decode is a
 * malformed answer, never skipped silently). `ts` is left 0 for the caller to fill.
 */
export interface Emitters {
  /** Every Aave V3 Pool of the chain (lower case). */
  aavePools: ReadonlySet<string>
  morpho: string
}

export function decodeLiquidation(chain: ChainKey, log: RawLog, emitters: Emitters): LiqEvent {
  const t0 = (log.topics[0] ?? '').toLowerCase()
  const address = log.address.toLowerCase()
  const base = {
    chain,
    block: Number(BigInt(log.blockNumber)),
    blockHash: (log.blockHash ?? '').toLowerCase(),
    tx: log.transactionHash.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex)),
    ts: 0,
  }
  if (t0 === AAVE_LIQUIDATION_CALL_TOPIC) {
    if (!emitters.aavePools.has(address))
      throw new Error(`LiquidationCall from ${address}, not an Aave V3 pool of ${chain}`)
    if (log.topics.length !== 4 || log.data.length !== 2 + 64 * 4)
      throw new Error(`LiquidationCall ${base.tx}:${base.logIndex}: bad shape`)
    const user = addr(log.topics[3])
    return {
      ...base,
      protocol: 'aave-v3',
      pool: address,
      pid: aavePid(chain, address, user),
      collateralAsset: addr(log.topics[1]),
      debtAsset: addr(log.topics[2]),
      user,
      debtToCover: uint(word(log.data, 0)),
      liquidatedCollateralAmount: uint(word(log.data, 1)),
      liquidator: addr(word(log.data, 2)),
      receiveAToken: BigInt(word(log.data, 3)) !== 0n,
    }
  }
  if (t0 === MORPHO_LIQUIDATE_TOPIC) {
    if (address !== emitters.morpho)
      throw new Error(`Liquidate from ${address}, not Morpho Blue ${emitters.morpho}`)
    if (log.topics.length !== 4 || log.data.length !== 2 + 64 * 5)
      throw new Error(`Liquidate ${base.tx}:${base.logIndex}: bad shape`)
    const marketId = log.topics[1].toLowerCase()
    const borrower = addr(log.topics[3])
    return {
      ...base,
      protocol: 'morpho-blue',
      pid: morphoPid(chain, marketId, borrower),
      marketId,
      caller: addr(log.topics[2]),
      borrower,
      repaidAssets: uint(word(log.data, 0)),
      repaidShares: uint(word(log.data, 1)),
      seizedAssets: uint(word(log.data, 2)),
      badDebtAssets: uint(word(log.data, 3)),
      badDebtShares: uint(word(log.data, 4)),
    }
  }
  throw new Error(`unexpected topic ${t0} in ${base.tx}:${base.logIndex}`)
}

/**
 * raw / 10^decimals as the correctly rounded double of the exact decimal — the same number the
 * owner's CSVs carry in their `*_normalized` columns (checked on all 3,111 Aave and 886 Morpho
 * rows: Number(formatUnits(raw, dec)) equals the CSV value on every row; Number(raw) / 10^dec
 * differs on 82).
 */
export const normUnits = (raw: string | bigint, decimals: number): number =>
  Number(formatUnits(BigInt(raw), decimals))

/** Order events the way a chain orders them. */
export const byChainOrder = (a: LiqEvent, b: LiqEvent) =>
  a.block - b.block || a.logIndex - b.logIndex

// ------------------------------------------------------------------ JSON with non-finite

const NUM_TAG = '$num'

/** JSON.stringify that keeps Infinity, -Infinity and NaN ({"$num":"Infinity"}). */
export function stringifyState(v: unknown, space?: number): string {
  return JSON.stringify(
    v,
    (_k, x) =>
      typeof x === 'number' && !Number.isFinite(x)
        ? { [NUM_TAG]: String(x) }
        : typeof x === 'bigint'
          ? x.toString()
          : x,
    space,
  )
}

export function parseState<T>(text: string): T {
  return JSON.parse(text, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) && NUM_TAG in x && Object.keys(x).length === 1
      ? Number(x[NUM_TAG])
      : x,
  ) as T
}
