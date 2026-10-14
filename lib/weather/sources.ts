/**
 * The weather strip's live inputs. SERVER-SIDE (pages/api/weather.ts): each reader takes
 * its client or fetch as an argument, so tests pass mocks and nothing here reads env.
 *
 *   readBaseFee          Ethereum base fee, latest block              (chain)
 *   readDvolEth          Deribit DVOL for ETH, latest closed hour     (implied vol)
 *   readCoinbaseHourly   Coinbase Exchange ETH-USD 1h candle closes   (market)
 *   readChainlinkHourly  Chainlink ETH/USD answer in force each hour  (oracle)
 *
 * Hourly series follow price-history's convention (lib/regime/m0.ts): one value per hour,
 * stamped at the hour END, null = no observation. Every reader has a time budget and never
 * throws: it returns { ok: false, error } with any URL redacted.
 */

import type { PublicClient } from 'viem'

import { redactError } from '@/lib/netApy/rpc'
import { HOUR_MS, type HourlyPoint } from '@/lib/regime/m0'

/** Chainlink ETH/USD on Ethereum mainnet. roundId = phaseId << 64 | aggregatorRoundId. */
export const CHAINLINK_ETH_USD = {
  proxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  decimals: 8,
  heartbeatS: 3600,
  deviation: 0.005,
} as const

export const DERIBIT_DVOL_URL = 'https://www.deribit.com/api/v2/public/get_volatility_index_data'
export const COINBASE_CANDLES_URL = 'https://api.exchange.coinbase.com/products/ETH-USD/candles'

export const READ_TIMEOUT_MS = 8_000

export type Read<T> = { ok: true; data: T } | { ok: false; error: string }
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const AGGREGATOR_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    type: 'function',
    name: 'getRoundData',
    stateMutability: 'view',
    inputs: [{ name: '_roundId', type: 'uint80' }],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`)
    this.name = 'TimeoutError'
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), Math.max(0, ms))
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController()
  const run = async () => {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'membrane-weather' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
    return res.json()
  }
  try {
    return await withTimeout(run(), timeoutMs)
  } catch (e) {
    ctrl.abort()
    throw e
  }
}

const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: redactError(e) })

/** Hour END of the latest completed hour at `nowMs`. */
export const lastHourEnd = (nowMs: number): number => Math.floor(nowMs / HOUR_MS) * HOUR_MS

/** The `hours` hour ends ending at the latest completed hour, oldest first. */
export function hourGrid(nowMs: number, hours: number): number[] {
  const H = lastHourEnd(nowMs)
  return Array.from({ length: hours }, (_, i) => H - (hours - 1 - i) * HOUR_MS)
}

// ------------------------------------------------------------------ gas

export interface BaseFee {
  gwei: number
  block: number
  /** The block's own timestamp. */
  asOfMs: number
}

export async function readBaseFee(
  client: PublicClient,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<Read<BaseFee>> {
  try {
    const block = await withTimeout(client.getBlock({ blockTag: 'latest' }), timeoutMs)
    if (block.baseFeePerGas === null || block.baseFeePerGas === undefined)
      throw new Error('block has no base fee')
    return {
      ok: true,
      data: {
        gwei: Number(block.baseFeePerGas) / 1e9,
        block: Number(block.number),
        asOfMs: Number(block.timestamp) * 1000,
      },
    }
  } catch (e) {
    return fail(e)
  }
}

// ------------------------------------------------------------------ DVOL

export interface Dvol {
  /** Annualised 30-day implied volatility, in vol points (Deribit DVOL close). */
  dvol: number
  /** dvol / √365: the daily move the options market prices, in %. */
  dailyMovePct: number
  candleOpenMs: number
  /** The candle's close time (open + 1h). Only closed candles are read. */
  asOfMs: number
}

/** The newest CLOSED hourly DVOL candle. Rows are [open_ms, open, high, low, close]; the
 *  candle still forming (open + 1h > now) is skipped, so asOf is never in the future. */
export async function readDvolEth(
  fetchImpl: FetchLike,
  nowMs: number,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<Read<Dvol>> {
  try {
    const q = new URLSearchParams({
      currency: 'ETH',
      resolution: '3600',
      start_timestamp: String(nowMs - 4 * HOUR_MS),
      end_timestamp: String(nowMs),
    })
    const body = (await getJson(fetchImpl, `${DERIBIT_DVOL_URL}?${q}`, timeoutMs)) as {
      result?: { data?: unknown }
    }
    const rows = body?.result?.data
    if (!Array.isArray(rows)) throw new Error('Deribit: no result.data')
    let best: [number, number] | null = null
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 5) continue
      const open = Number(r[0])
      const close = Number(r[4])
      if (!Number.isFinite(open) || !(close > 0) || open + HOUR_MS > nowMs) continue
      if (!best || open > best[0]) best = [open, close]
    }
    if (!best) throw new Error('Deribit: no closed DVOL candle in the last 4h')
    const [candleOpenMs, dvol] = best
    return {
      ok: true,
      data: {
        dvol,
        dailyMovePct: dvol / Math.sqrt(365),
        candleOpenMs,
        asOfMs: candleOpenMs + HOUR_MS,
      },
    }
  } catch (e) {
    return fail(e)
  }
}

// ------------------------------------------------------------------ Coinbase

export interface MarketHourly {
  points: HourlyPoint[]
  /** Close time of the newest closed candle; null if none came back. */
  asOfMs: number | null
}

/** Coinbase Exchange ETH-USD 1h candles. Rows are [time_s (open), low, high, open, close,
 *  volume], newest first; the candle still forming is dropped. */
export async function readCoinbaseHourly(
  fetchImpl: FetchLike,
  nowMs: number,
  hours = 50,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<Read<MarketHourly>> {
  try {
    const grid = hourGrid(nowMs, hours)
    const q = new URLSearchParams({
      granularity: '3600',
      start: new Date(grid[0] - HOUR_MS).toISOString(),
      end: new Date(nowMs).toISOString(),
    })
    const rows = await getJson(fetchImpl, `${COINBASE_CANDLES_URL}?${q}`, timeoutMs)
    if (!Array.isArray(rows)) throw new Error('Coinbase: response is not a candle list')
    const close = new Map<number, number>()
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 5) continue
      const end = (Number(r[0]) + 3600) * 1000
      const v = Number(r[4])
      if (!Number.isFinite(end) || end > nowMs || !(v > 0)) continue
      close.set(end, v)
    }
    const points = grid.map((t) => ({ t, v: close.get(t) ?? null }))
    const seen = points.filter((p) => p.v !== null)
    return { ok: true, data: { points, asOfMs: seen.length ? seen[seen.length - 1].t : null } }
  } catch (e) {
    return fail(e)
  }
}

// ------------------------------------------------------------------ Chainlink

export type ChainlinkPartial = 'phaseStart' | 'roundCap' | 'timeout' | 'readError'

export interface OracleHourly {
  points: HourlyPoint[]
  latest: { roundId: string; answer: number; updatedAtMs: number }
  roundsRead: number
  /** updatedAt of the oldest round read: hours before it are null. */
  oldestRoundMs: number
  /** Why the walk stopped before reaching the first hour, or null if it reached it. */
  partial: ChainlinkPartial | null
}

export interface ChainlinkOptions {
  timeoutMs?: number
  /** getRoundData calls per multicall. */
  batch?: number
  /** Hard cap on rounds read (a heartbeat-only 50h is ~50; a crash can be several hundred). */
  maxRounds?: number
}

interface Round {
  agg: bigint
  answer: number
  updatedAtS: number
}

const AGG_MASK = (1n << 64n) - 1n

/**
 * The answer in force at each hour end: latestRoundData, then getRoundData walking
 * backwards in multicall batches until a round at or before the first hour end. The walk
 * stays inside the current phase (proxy id = phaseId << 64 | n); at its first round, or a
 * reverting / empty round, it stops and the earlier hours stay null (partial = phaseStart).
 * A timeout or read error mid-walk keeps what was read and says so.
 */
export async function readChainlinkHourly(
  client: PublicClient,
  nowMs: number,
  hours = 50,
  opts: ChainlinkOptions = {},
): Promise<Read<OracleHourly>> {
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS
  const batch = opts.batch ?? 64
  const maxRounds = opts.maxRounds ?? 600
  const deadline = Date.now() + timeoutMs
  const left = () => deadline - Date.now()
  const scale = 10 ** CHAINLINK_ETH_USD.decimals
  try {
    const grid = hourGrid(nowMs, hours)
    const needS = grid[0] / 1000

    const [roundId, answer, , updatedAt] = await withTimeout(
      client.readContract({
        address: CHAINLINK_ETH_USD.proxy,
        abi: AGGREGATOR_ABI,
        functionName: 'latestRoundData',
      }),
      left(),
    )
    const phase = roundId >> 64n
    const rounds: Round[] = [
      { agg: roundId & AGG_MASK, answer: Number(answer) / scale, updatedAtS: Number(updatedAt) },
    ]
    const oldest = () => rounds[rounds.length - 1]

    let partial: ChainlinkPartial | null = null
    while (oldest().updatedAtS > needS) {
      const from = oldest().agg
      if (from <= 1n) {
        partial = 'phaseStart'
        break
      }
      if (rounds.length >= maxRounds) {
        partial = 'roundCap'
        break
      }
      const ids: bigint[] = []
      for (
        let id = from - 1n;
        id >= 1n && ids.length < Math.min(batch, maxRounds - rounds.length);
        id--
      )
        ids.push(id)
      let res
      try {
        res = await withTimeout(
          client.multicall({
            allowFailure: true,
            contracts: ids.map((id) => ({
              address: CHAINLINK_ETH_USD.proxy,
              abi: AGGREGATOR_ABI,
              functionName: 'getRoundData' as const,
              args: [(phase << 64n) | id] as const,
            })),
          }),
          left(),
        )
      } catch (e) {
        partial = e instanceof TimeoutError ? 'timeout' : 'readError'
        break
      }
      let ended = false
      for (let i = 0; i < ids.length; i++) {
        const r = res[i]
        const u = r.status === 'success' ? Number(r.result[3]) : 0
        // A revert or an empty round: the phase begins here.
        if (r.status !== 'success' || u === 0) {
          ended = true
          break
        }
        rounds.push({ agg: ids[i], answer: Number(r.result[1]) / scale, updatedAtS: u })
        if (u <= needS) break
      }
      if (ended) {
        partial = 'phaseStart'
        break
      }
    }

    // Rounds are newest first. For each hour end, the newest round updated at or before it.
    const asc = [...rounds].reverse()
    let j = -1
    const points = grid.map((t) => {
      while (j + 1 < asc.length && asc[j + 1].updatedAtS * 1000 <= t) j++
      return { t, v: j >= 0 ? asc[j].answer : null }
    })
    return {
      ok: true,
      data: {
        points,
        latest: {
          roundId: roundId.toString(),
          answer: Number(answer) / scale,
          updatedAtMs: Number(updatedAt) * 1000,
        },
        roundsRead: rounds.length,
        oldestRoundMs: oldest().updatedAtS * 1000,
        partial: oldest().updatedAtS <= needS ? null : partial,
      },
    }
  } catch (e) {
    return fail(e)
  }
}
