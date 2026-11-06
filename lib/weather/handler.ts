/**
 * GET /api/weather — the masthead's weather strip: gas, the DVOL daily move and the M0
 * regime, with every input's age. SERVER-SIDE; pages/api/weather.ts wires the live
 * readers in, tests pass mocks.
 *
 * The four readers run in parallel and never throw (lib/weather/sources.ts). A failed
 * reader nulls only its own part and adds its error; the regime is still evaluated on
 * what came back (lib/regime/m0.ts decides calm, choppy or stale). All four failing is a
 * 503. A 200 is memoised in-process for 60 s and cached at the edge for 60 s (+300 s
 * stale-while-revalidate); concurrent misses share one read.
 */

import type { NextApiRequest, NextApiResponse } from 'next'

import { redactError } from '@/lib/netApy/rpc'
import { evaluateM0, type M0Result } from '@/lib/regime/m0'
import { M0_THRESHOLDS, M0_THRESHOLDS_FILE } from '@/lib/regime/thresholds'

import type { BaseFee, ChainlinkPartial, Dvol, MarketHourly, OracleHourly, Read } from './sources'

export const WEATHER_MEMO_MS = 60_000
export const WEATHER_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300'

export interface WeatherDeps {
  now: () => number
  gas: (nowMs: number) => Promise<Read<BaseFee>>
  dvol: (nowMs: number) => Promise<Read<Dvol>>
  market: (nowMs: number) => Promise<Read<MarketHourly>>
  oracle: (nowMs: number) => Promise<Read<OracleHourly>>
}

export const WEATHER_SOURCES = [
  { name: 'Chainlink ETH/USD', kind: 'oracle' },
  { name: 'Coinbase ETH-USD 1h', kind: 'market' },
  { name: 'Deribit DVOL (ETH)', kind: 'implied vol' },
  { name: 'Ethereum base fee', kind: 'chain' },
] as const

export type WeatherInput = 'gas' | 'dvol' | 'market' | 'oracle'

export interface WeatherResponse {
  /** Server clock when the inputs were read (ms). */
  now: number
  gas: BaseFee | null
  dvol: Dvol | null
  regime: M0Result
  /** How far back the Chainlink walk reached; null when the oracle read failed. */
  oracle: {
    latest: OracleHourly['latest']
    roundsRead: number
    oldestRoundMs: number
    partial: ChainlinkPartial | null
  } | null
  thresholds: {
    move24hP95: number
    gapBand: number
    gapQuantile: 'p99.9'
    n: { move24h: number; gap: number }
    period: { from: string; to: string }
    source: { repo: string; commit: string; path: string; sha256: string }
  }
  sources: typeof WEATHER_SOURCES
  /** One redacted line per failed input. */
  errors: Partial<Record<WeatherInput, string>>
}

export type WeatherBuild =
  | { status: 200; body: WeatherResponse }
  | { status: 503; body: { error: string; errors: Partial<Record<WeatherInput, string>> } }

const THRESHOLDS: WeatherResponse['thresholds'] = {
  move24hP95: M0_THRESHOLDS.move24hP95,
  gapBand: M0_THRESHOLDS.gapBand,
  gapQuantile: M0_THRESHOLDS_FILE.gapQuantile,
  n: M0_THRESHOLDS_FILE.n,
  period: { from: M0_THRESHOLDS_FILE.period.from, to: M0_THRESHOLDS_FILE.period.to },
  source: M0_THRESHOLDS_FILE.source,
}

/** A reader that broke its never-throw contract still only fails its own part. */
const settle = async <T>(p: () => Promise<Read<T>>): Promise<Read<T>> => {
  try {
    return await p()
  } catch (e) {
    return { ok: false, error: redactError(e) }
  }
}

export async function buildWeather(deps: WeatherDeps): Promise<WeatherBuild> {
  const now = deps.now()
  const [gas, dvol, market, oracle] = await Promise.all([
    settle(() => deps.gas(now)),
    settle(() => deps.dvol(now)),
    settle(() => deps.market(now)),
    settle(() => deps.oracle(now)),
  ])
  const errors: Partial<Record<WeatherInput, string>> = {}
  if (!gas.ok) errors.gas = gas.error
  if (!dvol.ok) errors.dvol = dvol.error
  if (!market.ok) errors.market = market.error
  if (!oracle.ok) errors.oracle = oracle.error
  if (!gas.ok && !dvol.ok && !market.ok && !oracle.ok) {
    return { status: 503, body: { error: 'every weather input failed', errors } }
  }

  const regime = evaluateM0({
    oracle: oracle.ok ? oracle.data.points : [],
    market: market.ok ? market.data.points : [],
    nowMs: now,
    thresholds: M0_THRESHOLDS,
    oracleAsOfMs: oracle.ok ? oracle.data.latest.updatedAtMs : null,
    marketAsOfMs: market.ok ? market.data.asOfMs : null,
  })

  return {
    status: 200,
    body: {
      now,
      gas: gas.ok ? gas.data : null,
      dvol: dvol.ok ? dvol.data : null,
      regime,
      oracle: oracle.ok
        ? {
            latest: oracle.data.latest,
            roundsRead: oracle.data.roundsRead,
            oldestRoundMs: oracle.data.oldestRoundMs,
            partial: oracle.data.partial,
          }
        : null,
      thresholds: THRESHOLDS,
      sources: WEATHER_SOURCES,
      errors,
    },
  }
}

export function createWeatherHandler(deps: WeatherDeps, memoMs = WEATHER_MEMO_MS) {
  let memo: { at: number; body: WeatherResponse } | null = null
  let inflight: Promise<WeatherBuild> | null = null

  return async function weatherHandler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return res.status(405).json({ error: 'GET only' })
    }
    if (memo && deps.now() - memo.at < memoMs) {
      res.setHeader('Cache-Control', WEATHER_CACHE_CONTROL)
      return res.status(200).json(memo.body)
    }
    if (!inflight) {
      inflight = buildWeather(deps)
        .catch((e): WeatherBuild => ({ status: 503, body: { error: redactError(e), errors: {} } }))
        .finally(() => {
          inflight = null
        })
    }
    const built = await inflight
    if (built.status === 200) {
      memo = { at: built.body.now, body: built.body }
      res.setHeader('Cache-Control', WEATHER_CACHE_CONTROL)
    } else {
      res.setHeader('Cache-Control', 'no-store')
    }
    return res.status(built.status).json(built.body)
  }
}
