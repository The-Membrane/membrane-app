import { describe, expect, it } from 'vitest'

import { BODY_ID, HOME_COPY, jumpTo, regimeHome } from '@/components/Today/regimeHome'
import { weatherView } from '@/components/Weather/weatherView'
import { HOUR_MS, type M0Result } from '@/lib/regime/m0'
import type { WeatherResponse } from '@/lib/weather/handler'

// The home switch: which body owns the Today screen in every weather state, and that it
// always agrees with the strip's own reading of the same response.

const H = Date.UTC(2026, 9, 14, 12)
const NOW = H + 20 * 60_000

const regime = (over: Partial<M0Result> = {}): M0Result => ({
  state: 'calm',
  evaluatedAt: H,
  holdHours: 24,
  triggers: [],
  active: false,
  current: { move24h: { t: H, value: -0.012 }, gap: { t: H, value: 0.0004 } },
  since: null,
  sinceTruncated: false,
  holdsUntil: null,
  lastTriggerAt: null,
  coverage: { hoursObserved: 24, window: 24, required: 20 },
  inputs: { oracleAsOf: NOW - 12 * 60_000, marketAsOf: H },
  stale: [],
  liquidationVolume: { counted: false, reason: 'no live source' },
  ...over,
})

const body = (r: Partial<M0Result> = {}, over: Partial<WeatherResponse> = {}): WeatherResponse =>
  ({
    now: NOW - 30_000,
    gas: { gwei: 0.07, block: 26_187_399, asOfMs: NOW - 9_000 },
    dvol: { dvol: 51.69, dailyMovePct: 2.7, candleOpenMs: H - HOUR_MS, asOfMs: H - 20 * 60_000 },
    regime: regime(r),
    oracle: null,
    thresholds: {} as WeatherResponse['thresholds'],
    sources: [] as unknown as WeatherResponse['sources'],
    errors: {},
    ...over,
  }) as WeatherResponse

const ACTIVE: Partial<M0Result> = {
  state: 'choppy',
  active: true,
  triggers: [{ t: H, kind: 'move24h', value: -0.0921, threshold: 0.0814 }],
  lastTriggerAt: H,
  since: H - 3 * HOUR_MS,
  holdsUntil: H + 24 * HOUR_MS,
}
const HOLD: Partial<M0Result> = {
  state: 'choppy',
  active: false,
  triggers: [{ t: H - 10 * HOUR_MS, kind: 'move24h', value: -0.09, threshold: 0.0814 }],
  lastTriggerAt: H - 10 * HOUR_MS,
  since: H - 30 * HOUR_MS,
  holdsUntil: H + 14 * HOUR_MS,
}

const home = (b: WeatherResponse | undefined, status: 'pending' | 'error' | 'success' = 'success', nowMs = NOW) =>
  regimeHome({ status, data: b, nowMs })

describe('regimeHome', () => {
  it('loading: no owner, no kicker, no jump (the page reserves the space)', () => {
    expect(home(undefined, 'pending')).toEqual({
      state: 'loading',
      owner: null,
      kicker: null,
      byDefault: false,
      jump: null,
    })
  })

  it('calm: Opportunities owns the screen; Safety is one jump line', () => {
    const h = home(body())
    expect(h.state).toBe('calm')
    expect(h.owner).toBe('opportunities')
    expect(h.kicker).toBe('Opportunities')
    expect(h.byDefault).toBe(false)
    expect(h.jump).toEqual({ body: 'safety', text: 'Safety continues below →', href: '#safety' })
  })

  it('choppy with an active trigger: Safety owns the screen', () => {
    const h = home(body(ACTIVE))
    expect(h.state).toBe('choppyActive')
    expect(h.owner).toBe('safety')
    expect(h.kicker).toBe('Safety')
    expect(h.jump).toEqual({ body: 'opportunities', text: 'Opportunities continue below →', href: '#opportunities' })
  })

  it('choppy only by the 24h hold: still Safety', () => {
    const h = home(body(HOLD))
    expect(h.state).toBe('choppyHold')
    expect(h.owner).toBe('safety')
    expect(h.kicker).toBe('Safety')
  })

  it('stale (regime withheld): Safety, by default — toward risk', () => {
    const h = home(body({ state: 'stale', stale: ['oracleOld'] }))
    expect(h.state).toBe('stale')
    expect(h.owner).toBe('safety')
    expect(h.byDefault).toBe(true)
    expect(h.kicker).toBe('Safety, by default')
    expect(h.jump?.body).toBe('opportunities')
  })

  it('a calm response older than two heartbeats is stale input: Safety, by default', () => {
    const h = home(body(), 'success', NOW + 3 * HOUR_MS)
    expect(h.state).toBe('stale')
    expect(h.owner).toBe('safety')
    expect(h.kicker).toBe('Safety, by default')
  })

  it('weather API error: Safety, by default', () => {
    const h = home(undefined, 'error')
    expect(h.state).toBe('error')
    expect(h.owner).toBe('safety')
    expect(h.kicker).toBe(`Safety, ${HOME_COPY.byDefault}`)
  })

  it('a failed refetch keeps the last response: the regime still decides', () => {
    expect(home(body(), 'error').owner).toBe('opportunities')
    expect(home(body(ACTIVE), 'error').owner).toBe('safety')
  })

  it('always agrees with the strip on the same response and clock', () => {
    const cases: [WeatherResponse | undefined, 'pending' | 'error' | 'success', number][] = [
      [undefined, 'pending', NOW],
      [undefined, 'error', NOW],
      [body(), 'success', NOW],
      [body(ACTIVE), 'success', NOW],
      [body(HOLD), 'success', NOW],
      [body({ state: 'stale' }), 'success', NOW],
      [body(), 'success', NOW + 3 * HOUR_MS],
    ]
    for (const [b, status, nowMs] of cases) {
      const strip = weatherView({ status, data: b, nowMs }).kind
      const h = regimeHome({ status, data: b, nowMs })
      const expected = strip === 'loading' ? null : strip === 'calm' ? 'opportunities' : 'safety'
      expect(h.owner).toBe(expected)
    }
  })

  it('the jump never points at the owner, and its anchor is the body id', () => {
    for (const b of [body(), body(ACTIVE), body({ state: 'stale' })]) {
      const h = home(b)
      expect(h.jump?.body).not.toBe(h.owner)
      expect(h.jump?.href).toBe(`#${BODY_ID[h.jump!.body]}`)
    }
    expect(jumpTo('safety').text).toBe('Safety continues below →')
  })
})
