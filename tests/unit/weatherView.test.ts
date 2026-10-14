import { describe, expect, it } from 'vitest'

import {
  formatAge,
  formatGwei,
  reasonFor,
  signedPct,
  STRIP_COPY,
  utcClock,
  weatherView,
} from '@/components/Weather/weatherView'
import { HOUR_MS, type M0Result } from '@/lib/regime/m0'
import type { WeatherResponse } from '@/lib/weather/handler'

// The strip's view model: every state the strip must draw (calm, choppy active, choppy
// held, stale, loading, error) and the single-input failures, from fixed responses.

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

const body = (over: Partial<WeatherResponse> = {}): WeatherResponse =>
  ({
    now: NOW - 30_000,
    gas: { gwei: 0.066797862, block: 26_187_399, asOfMs: NOW - 9_000 },
    dvol: {
      dvol: 51.69,
      dailyMovePct: 51.69 / Math.sqrt(365),
      candleOpenMs: H - HOUR_MS,
      asOfMs: H - 20 * 60_000,
    },
    regime: regime(),
    oracle: null,
    thresholds: {} as WeatherResponse['thresholds'],
    sources: [] as unknown as WeatherResponse['sources'],
    errors: {},
    ...over,
  }) as WeatherResponse

const view = (
  b: WeatherResponse | undefined,
  status: 'pending' | 'error' | 'success' = 'success',
) => weatherView({ status, data: b, nowMs: NOW })

describe('formatters', () => {
  it('formatAge floors to s / m / h / d', () => {
    expect(formatAge(-5)).toBe('0s')
    expect(formatAge(9_999)).toBe('9s')
    expect(formatAge(60_000)).toBe('1m')
    expect(formatAge(12 * 60_000 + 59_000)).toBe('12m')
    expect(formatAge(3 * HOUR_MS + 1)).toBe('3h')
    expect(formatAge(49 * HOUR_MS)).toBe('2d')
  })

  it('formatGwei: 2 significant digits under 1 gwei, else 1 decimal', () => {
    expect(formatGwei(0.066797862)).toBe('0.067')
    expect(formatGwei(0.4)).toBe('0.4')
    expect(formatGwei(0.423)).toBe('0.42')
    expect(formatGwei(1)).toBe('1.0')
    expect(formatGwei(12.345)).toBe('12.3')
  })

  it('signedPct uses a true minus and no sign on zero', () => {
    expect(signedPct(-0.0921, 1)).toBe('−9.2%')
    expect(signedPct(0.0921, 1)).toBe('+9.2%')
    expect(signedPct(-0.0001, 1)).toBe('0.0%')
  })

  it('utcClock adds the day only when it is not today (UTC)', () => {
    expect(utcClock(H + 2 * HOUR_MS, NOW)).toBe('14:00 UTC')
    expect(utcClock(H + 22 * HOUR_MS, NOW)).toBe('15 Oct 10:00 UTC')
    expect(utcClock(H - 13 * HOUR_MS, NOW)).toBe('13 Oct 23:00 UTC')
  })

  it('reasonFor prefers the move, and the gap names its direction', () => {
    const move = { t: H, kind: 'move24h' as const, value: -0.0921, threshold: 0.0814 }
    const gap = { t: H, kind: 'oracleGap' as const, value: -0.0191, threshold: 0.0167 }
    expect(reasonFor([gap, move], H)).toEqual({
      lead: 'ETH',
      figure: '−9.2%',
      loss: true,
      tail: 'in 24h',
      threshold: 'p95 8.1%',
    })
    expect(reasonFor([{ ...move, value: 0.0921 }], H)?.loss).toBe(false)
    expect(reasonFor([gap], H)).toEqual({
      lead: 'Chainlink',
      figure: '1.91%',
      loss: false,
      tail: 'below Coinbase',
      threshold: 'band 1.67%',
    })
    expect(reasonFor([{ ...gap, value: 0.02 }], H)?.tail).toBe('above Coinbase')
    expect(reasonFor([gap], H - HOUR_MS)).toBeNull()
  })
})

describe('weatherView — states', () => {
  it('calm: ink word, the sentence with its credit, gas and every age', () => {
    const v = view(body())
    expect(v.kind).toBe('calm')
    expect(v.hatched).toBe(false)
    expect(v.regime).toEqual({ text: 'Calm', glyph: null, caps: true })
    expect(v.reason).toBeNull()
    expect(v.holds).toBeNull()
    expect(v.sentence).toBe('The market prices a 2.7% daily ETH move.')
    expect(v.credit).toBe('Deribit DVOL ÷ √365 · measured')
    expect(v.gas).toBe('Base fee 0.067 gwei')
    expect(v.ages).toEqual(['Chainlink 12m', 'Coinbase 20m', 'DVOL 40m', 'gas 9s'])
    expect(v.agesBrief).toBe('inputs ≤40m old')
    expect(v.liq).toBe('Liq. volume not counted · no live source')
  })

  it('choppy, trigger active: ▲ word, the reason with a red falling figure, and the hold', () => {
    const v = view(
      body({
        regime: regime({
          state: 'choppy',
          active: true,
          triggers: [{ t: H, kind: 'move24h', value: -0.0921, threshold: 0.0814 }],
          lastTriggerAt: H,
          since: H,
          holdsUntil: H + 24 * HOUR_MS,
        }),
      }),
    )
    expect(v.kind).toBe('choppy')
    expect(v.regime).toEqual({ text: 'Choppy', glyph: '▲', caps: true })
    expect(v.reason).toEqual({
      lead: 'ETH',
      figure: '−9.2%',
      loss: true,
      tail: 'in 24h',
      threshold: 'p95 8.1%',
    })
    expect(v.since).toBeNull()
    expect(v.holds).toBe('holds to 15 Oct 12:00 UTC')
    expect(v.hatched).toBe(false)
  })

  it('choppy, held with no active trigger: since … · holds to …', () => {
    const v = view(
      body({
        regime: regime({
          state: 'choppy',
          active: false,
          triggers: [{ t: H - 10 * HOUR_MS, kind: 'oracleGap', value: 0.02, threshold: 0.0167 }],
          lastTriggerAt: H - 10 * HOUR_MS,
          since: H - 10 * HOUR_MS,
          holdsUntil: H + 14 * HOUR_MS,
        }),
      }),
    )
    expect(v.reason).toBeNull()
    expect(v.since).toBe('since 02:00 UTC')
    expect(v.holds).toBe('holds to 15 Oct 02:00 UTC')
  })

  it('stale: hatched, the word withheld, ages still shown', () => {
    const v = view(
      body({
        regime: regime({
          state: 'stale',
          stale: ['oracleOld'],
          inputs: { oracleAsOf: NOW - 3 * HOUR_MS, marketAsOf: H },
        }),
      }),
    )
    expect(v.kind).toBe('stale')
    expect(v.hatched).toBe(true)
    expect(v.regime).toEqual({ text: 'Regime withheld · inputs stale', glyph: '░', caps: true })
    expect(v.reason).toBeNull()
    expect(v.holds).toBeNull()
    expect(v.ages[0]).toBe('Chainlink 3h')
    expect(v.agesBrief).toBe('Chainlink 3h old')
    // Not a regime input, still fresh: still printed.
    expect(v.sentence).not.toBeNull()
  })

  it('a choppy response that is itself over 2h old is withheld', () => {
    const v = view(
      body({
        now: NOW - 2 * HOUR_MS - 1,
        regime: regime({
          state: 'choppy',
          active: true,
          lastTriggerAt: H,
          since: H,
          holdsUntil: H + 24 * HOUR_MS,
        }),
      }),
    )
    expect(v.kind).toBe('stale')
    expect(v.regime.text).toBe(STRIP_COPY.withheld)
    expect(v.holds).toBeNull()
  })

  it('loading: em dashes, no figures', () => {
    const v = view(undefined, 'pending')
    expect(v.kind).toBe('loading')
    expect(v.regime.text).toBe('—')
    expect(v.sentence).toBe('—')
    expect(v.gas).toBeNull()
    expect(v.ages).toEqual([])
    expect(v.liq).toBeNull()
  })

  it('error with no data: hatched, "Weather unavailable", nothing else', () => {
    const v = view(undefined, 'error')
    expect(v.kind).toBe('error')
    expect(v.hatched).toBe(true)
    expect(v.regime).toEqual({ text: 'Weather unavailable', glyph: '░', caps: true })
    expect([v.sentence, v.credit, v.gas, v.agesBrief, v.liq]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ])
    expect(v.ages).toEqual([])
  })
})

describe('weatherView — one failed input hides only its element', () => {
  it('no DVOL: no sentence, no credit, "DVOL unavailable" in the ages', () => {
    const v = view(body({ dvol: null, errors: { dvol: 'HTTP 502' } }))
    expect(v.kind).toBe('calm')
    expect(v.sentence).toBeNull()
    expect(v.credit).toBeNull()
    expect(v.gas).not.toBeNull()
    expect(v.ages).toContain('DVOL unavailable')
    expect(v.agesBrief).toBe('DVOL unavailable')
  })

  it('an old DVOL candle is not printed as the sentence, its age is', () => {
    const v = view(
      body({
        dvol: {
          dvol: 50,
          dailyMovePct: 2.6,
          candleOpenMs: H - 4 * HOUR_MS,
          asOfMs: H - 3 * HOUR_MS,
        },
      }),
    )
    expect(v.sentence).toBeNull()
    expect(v.ages).toContain('DVOL 3h')
  })

  it('no gas: no base fee, "gas unavailable"', () => {
    const v = view(body({ gas: null, errors: { gas: 'boom' } }))
    expect(v.gas).toBeNull()
    expect(v.sentence).not.toBeNull()
    expect(v.ages).toContain('gas unavailable')
  })

  it('a failed oracle read is named', () => {
    const v = view(
      body({
        errors: { oracle: 'boom' },
        regime: regime({
          state: 'stale',
          stale: ['oracleOld'],
          inputs: { oracleAsOf: null, marketAsOf: H },
        }),
      }),
    )
    expect(v.ages[0]).toBe('Chainlink unavailable')
    expect(v.kind).toBe('stale')
  })
})
