import type { NextApiRequest, NextApiResponse } from 'next'
import { describe, expect, it, vi } from 'vitest'

import { HOUR_MS, type HourlyPoint } from '@/lib/regime/m0'
import { M0_THRESHOLDS_FILE } from '@/lib/regime/thresholds'
import {
  buildWeather,
  createWeatherHandler,
  WEATHER_CACHE_CONTROL,
  type WeatherDeps,
  type WeatherResponse,
} from '@/lib/weather/handler'
import type { OracleHourly, Read } from '@/lib/weather/sources'

// GET /api/weather with mocked readers: the response shape, partial failure (200 with
// the part null and its error), total failure (503), the 60 s memo and the cache header.

const H = Date.UTC(2026, 9, 14, 12)
const NOW = H + 20 * 60_000
const grid = (f: (k: number) => number | null): HourlyPoint[] =>
  Array.from({ length: 50 }, (_, i) => ({ t: H - (49 - i) * HOUR_MS, v: f(49 - i) }))

const oracleOk = (f: (k: number) => number | null = () => 2500): Read<OracleHourly> => ({
  ok: true,
  data: {
    points: grid(f),
    latest: { roundId: '1', answer: 2500, updatedAtMs: NOW - 12 * 60_000 },
    roundsRead: 51,
    oldestRoundMs: H - 50 * HOUR_MS,
    partial: null,
  },
})

function deps(over: Partial<WeatherDeps> = {}, clock = { now: NOW }): WeatherDeps {
  return {
    now: () => clock.now,
    gas: vi.fn(async () => ({
      ok: true as const,
      data: { gwei: 0.42, block: 23_000_000, asOfMs: NOW - 9000 },
    })),
    dvol: vi.fn(async () => ({
      ok: true as const,
      data: {
        dvol: 51.47,
        dailyMovePct: 51.47 / Math.sqrt(365),
        candleOpenMs: H - HOUR_MS,
        asOfMs: H,
      },
    })),
    market: vi.fn(async () => ({
      ok: true as const,
      data: { points: grid(() => 2501), asOfMs: H },
    })),
    oracle: vi.fn(async () => oracleOk()),
    ...over,
  }
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>
async function call(handler: Handler, method = 'GET') {
  const out = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown }
  const res = {
    setHeader: (k: string, v: string) => {
      out.headers[k] = v
      return res
    },
    status: (s: number) => {
      out.status = s
      return res
    },
    json: (b: unknown) => {
      out.body = b
      return res
    },
  }
  await handler(
    { method, query: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  )
  return out
}

describe('buildWeather', () => {
  it('returns every part, the regime and the provenance', async () => {
    const built = await buildWeather(deps())
    expect(built.status).toBe(200)
    const body = built.body as WeatherResponse
    expect(body.now).toBe(NOW)
    expect(body.gas).toEqual({ gwei: 0.42, block: 23_000_000, asOfMs: NOW - 9000 })
    expect(body.dvol?.dvol).toBe(51.47)
    expect(body.regime.state).toBe('calm')
    expect(body.regime.inputs).toEqual({ oracleAsOf: NOW - 12 * 60_000, marketAsOf: H })
    expect(body.regime.liquidationVolume).toEqual({ counted: false, reason: 'no live source' })
    expect(body.oracle).toMatchObject({ roundsRead: 51, partial: null })
    expect(body.thresholds).toEqual({
      move24hP95: M0_THRESHOLDS_FILE.move24hP95,
      gapBand: M0_THRESHOLDS_FILE.gapP999,
      gapQuantile: 'p99.9',
      n: M0_THRESHOLDS_FILE.n,
      period: { from: M0_THRESHOLDS_FILE.period.from, to: M0_THRESHOLDS_FILE.period.to },
      source: M0_THRESHOLDS_FILE.source,
    })
    expect(body.sources.map((s) => s.kind)).toEqual(['oracle', 'market', 'implied vol', 'chain'])
    expect(body.errors).toEqual({})
  })

  it('evaluates the regime from the readers (a −10% day is choppy)', async () => {
    const d = deps({
      oracle: async () => oracleOk((k) => (k < 3 ? 2250 : 2500)),
      market: async () => ({
        ok: true,
        data: { points: grid((k) => (k < 3 ? 2250 : 2500)), asOfMs: H },
      }),
    })
    const body = (await buildWeather(d)).body as WeatherResponse
    expect(body.regime.state).toBe('choppy')
    expect(body.regime.active).toBe(true)
    expect(body.regime.current.move24h?.value).toBeCloseTo(-0.1, 12)
  })

  it('a failed part is null with its error; the rest still renders', async () => {
    const d = deps({
      dvol: async () => ({ ok: false, error: 'HTTP 502 from www.deribit.com' }),
      market: async () => ({ ok: false, error: 'timed out after 8000 ms' }),
    })
    const built = await buildWeather(d)
    expect(built.status).toBe(200)
    const body = built.body as WeatherResponse
    expect(body.dvol).toBeNull()
    expect(body.gas).not.toBeNull()
    expect(body.errors).toEqual({
      dvol: 'HTTP 502 from www.deribit.com',
      market: 'timed out after 8000 ms',
    })
    // No market: calm cannot be claimed.
    expect(body.regime.state).toBe('stale')
    expect(body.regime.stale).toContain('marketOld')
  })

  it('an oracle failure nulls the oracle block and the regime is stale', async () => {
    const body = (await buildWeather(deps({ oracle: async () => ({ ok: false, error: 'boom' }) })))
      .body as WeatherResponse
    expect(body.oracle).toBeNull()
    expect(body.regime.state).toBe('stale')
    expect(body.regime.stale).toContain('oracleOld')
  })

  it('a reader that throws anyway only fails its own part, redacted', async () => {
    const d = deps({
      gas: async () => {
        throw new Error('fetch failed https://rpc.example/key')
      },
    })
    const body = (await buildWeather(d)).body as WeatherResponse
    expect(body.gas).toBeNull()
    expect(body.errors.gas).toBe('fetch failed [rpc]')
  })

  it('every part failing is a 503', async () => {
    const no = async () => ({ ok: false as const, error: 'x' })
    const built = await buildWeather(deps({ gas: no, dvol: no, market: no, oracle: no }))
    expect(built.status).toBe(503)
    expect(built.body).toEqual({
      error: 'every weather input failed',
      errors: { gas: 'x', dvol: 'x', market: 'x', oracle: 'x' },
    })
  })
})

describe('GET /api/weather', () => {
  it('GET only', async () => {
    const out = await call(createWeatherHandler(deps()), 'POST')
    expect(out.status).toBe(405)
    expect(out.headers.Allow).toBe('GET')
  })

  it('sets the edge cache header and memoises a 200 for 60 s', async () => {
    const clock = { now: NOW }
    const d = deps({}, clock)
    const handler = createWeatherHandler(d)
    const a = await call(handler)
    expect(a.status).toBe(200)
    expect(a.headers['Cache-Control']).toBe(WEATHER_CACHE_CONTROL)
    expect(WEATHER_CACHE_CONTROL).toBe('public, s-maxage=60, stale-while-revalidate=300')
    clock.now = NOW + 59_000
    const b = await call(handler)
    expect(b.body).toBe(a.body)
    expect(d.gas).toHaveBeenCalledTimes(1)
    clock.now = NOW + 60_000
    await call(handler)
    expect(d.gas).toHaveBeenCalledTimes(2)
  })

  it('concurrent misses share one read', async () => {
    const d = deps()
    const handler = createWeatherHandler(d)
    await Promise.all([call(handler), call(handler), call(handler)])
    expect(d.oracle).toHaveBeenCalledTimes(1)
  })

  it('a 503 is not memoised or cached', async () => {
    const no = vi.fn(async () => ({ ok: false as const, error: 'x' }))
    const handler = createWeatherHandler(deps({ gas: no, dvol: no, market: no, oracle: no }))
    const a = await call(handler)
    expect(a.status).toBe(503)
    expect(a.headers['Cache-Control']).toBe('no-store')
    await call(handler)
    expect(no).toHaveBeenCalledTimes(8)
  })
})
