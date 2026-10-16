import { describe, expect, it } from 'vitest'

import {
  agesBriefOf,
  type AgeInput,
  formatAge,
  PHONE_LINE_CHARS,
  formatGwei,
  rarity,
  reasonFor,
  signedPct,
  STRIP_COPY,
  utcClock,
  volatilitySentence,
  weatherView,
  type WeatherView,
} from '@/components/Weather/weatherView'
import { HOUR_MS, type M0Result } from '@/lib/regime/m0'
import { M0_THRESHOLDS_FILE, oneIn } from '@/lib/regime/thresholds'
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
      rarity: 'a 1-in-20 day',
    })
    expect(reasonFor([{ ...move, value: 0.0921 }], H)?.loss).toBe(false)
    expect(reasonFor([gap], H)).toEqual({
      lead: 'Chainlink',
      figure: '1.91%',
      loss: false,
      tail: 'below Coinbase',
      rarity: 'a 1-in-1,000 hour',
    })
    expect(reasonFor([{ ...gap, value: 0.02 }], H)?.tail).toBe('above Coinbase')
    expect(reasonFor([gap], H - HOUR_MS)).toBeNull()
  })

  it("the rarity is the generated file's quantile level as 1 in N, never a percentile", () => {
    const move = { t: H, kind: 'move24h' as const, value: -0.0921, threshold: 0.0814 }
    const gap = { t: H, kind: 'oracleGap' as const, value: 0.02, threshold: 0.0167 }
    expect(reasonFor([move], H)?.rarity).toBe(
      `a 1-in-${oneIn(M0_THRESHOLDS_FILE.move24hQuantile)} day`,
    )
    expect(reasonFor([gap], H)?.rarity).toBe(
      `a 1-in-${oneIn(M0_THRESHOLDS_FILE.gapQuantile).toLocaleString('en-US')} hour`,
    )
    // It follows the level it is given: the p99 band on file would read 1 in 100.
    expect(reasonFor([gap], H, { move24h: 20, gap: oneIn('p99') })?.rarity).toBe('a 1-in-100 hour')
    expect(rarity(1000, 'hour')).toBe('a 1-in-1,000 hour')
  })

  it('the volatility line says volatility and no direction', () => {
    const s = volatilitySentence(51.69 / Math.sqrt(365))
    expect(s).toBe('ETH volatility: options price a 2.7% daily swing, up or down.')
    expect(s).toMatch(/volatility/i)
    expect(s).toMatch(/up or down/)
    // No sign: the figure is a size, not a direction.
    expect(s).not.toMatch(/[+−±-]\d/)
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
    expect(v.sentence).toBe('ETH volatility: options price a 2.7% daily swing, up or down.')
    expect(v.credit).toBe('Deribit DVOL ÷ √365 · measured')
    expect(v.gas).toBe('Base fee 0.067 gwei')
    expect(v.ages).toEqual(['Chainlink 12m', 'Coinbase 20m', 'DVOL 40m', 'gas 9s'])
    expect(v.agesBrief).toBe('inputs ≤40m old')
    expect(v.liq).toBe('Liq. volume not counted · no live source')
  })

  it('choppy, trigger active: ∿ word, the reason with a red falling figure, and the hold', () => {
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
    expect(v.regime).toEqual({ text: 'Choppy', glyph: '∿', caps: true })
    expect(v.reason).toEqual({
      lead: 'ETH',
      figure: '−9.2%',
      loss: true,
      tail: 'in 24h',
      rarity: 'a 1-in-20 day',
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

describe("weatherView — the phones' ages line never outgrows 390px", () => {
  const input = (name: string, asOf: number | null, failed = false): AgeInput => ({
    name,
    asOf,
    failed,
    maxAge: name === 'gas' ? 15 * 60_000 : 2 * HOUR_MS,
  })
  const BASE_FEE = 'Base fee 0.067 gwei'

  it('a whole response 3h old (the browser clock ahead) collapses to one item', () => {
    // A fresh payload read 3h later: every input shares the 3h bucket.
    const v = weatherView({ status: 'success', data: body(), nowMs: NOW + 3 * HOUR_MS })
    expect(v.kind).toBe('stale')
    expect(v.agesBrief).toBe('inputs 3h old')
    expect(v.gas).toBeNull()
  })

  it('groups inputs in the same state', () => {
    const b = agesBriefOf(
      [
        input('Chainlink', NOW - 3 * HOUR_MS),
        input('Coinbase', NOW - 3 * HOUR_MS - 60_000),
        input('DVOL', NOW - 20 * 60_000),
        input('gas', NOW - 9_000),
      ],
      NOW,
      BASE_FEE,
    )
    expect(b).toBe('Chainlink, Coinbase 3h old')
  })

  it('falls back to a count when the names would not fit beside the base fee', () => {
    const mixed = [
      input('Chainlink', null, true),
      input('Coinbase', NOW - 3 * HOUR_MS),
      input('DVOL', NOW - 5 * HOUR_MS),
      input('gas', NOW - 9_000),
    ]
    expect(agesBriefOf(mixed, NOW, BASE_FEE)).toBe('3 inputs old or unavailable')
    const missing = [
      input('Chainlink', null, true),
      input('Coinbase', null, true),
      input('DVOL', null, true),
      input('gas', NOW - 9_000),
    ]
    expect(agesBriefOf(missing, NOW, BASE_FEE)).toBe('3 inputs unavailable')
    // Without the base fee beside it, the names fit.
    expect(agesBriefOf(missing, NOW, null)).toBe('Chainlink, Coinbase, DVOL unavailable')
  })

  it('fits one line in every combination of fresh, old and missing inputs', () => {
    const states = [
      (n: string) => input(n, NOW - 9_000),
      (n: string) => input(n, NOW - 59 * 60_000 * 2),
      (n: string) => input(n, NOW - 47 * HOUR_MS),
      (n: string) => input(n, null, true),
    ]
    const names = ['Chainlink', 'Coinbase', 'DVOL', 'gas']
    for (let code = 0; code < 4 ** 4; code++) {
      const inputs = names.map((n, i) => states[Math.floor(code / 4 ** i) % 4](n))
      for (const gas of [null, BASE_FEE, 'Base fee 123.4 gwei']) {
        const brief = agesBriefOf(inputs, NOW, gas)
        expect((gas ? gas.length + 3 : 0) + brief.length).toBeLessThanOrEqual(PHONE_LINE_CHARS)
      }
    }
  })
})

describe('weatherView — signed figures', () => {
  it('a falling move prints the typographic minus, never a hyphen', () => {
    const v = view(
      body({
        regime: regime({
          state: 'choppy',
          active: true,
          triggers: [{ t: H, kind: 'move24h', value: -0.105, threshold: 0.0814 }],
          lastTriggerAt: H,
          since: H,
          holdsUntil: H + 24 * HOUR_MS,
        }),
      }),
    )
    expect(v.reason?.figure).toBe('\u221210.5%')
    expect(v.reason?.figure.codePointAt(0)).toBe(0x2212)
    const printed = [v.regime.text, v.reason?.figure, v.reason?.tail, v.reason?.rarity, v.holds]
    // A hyphen before a digit is a minus unless it joins a word ("1-in-20").
    for (const t of printed) expect(t ?? '').not.toMatch(/(^|[^A-Za-z])-\d/)
  })
})

describe('weatherView — plain words in every state (owner, PR #106)', () => {
  const H24 = H + 24 * HOUR_MS
  const states: Record<string, WeatherView> = {
    calm: view(body()),
    'choppy, move': view(
      body({
        regime: regime({
          state: 'choppy',
          active: true,
          triggers: [{ t: H, kind: 'move24h', value: -0.105, threshold: 0.0814 }],
          lastTriggerAt: H,
          since: H,
          holdsUntil: H24,
        }),
      }),
    ),
    'choppy, gap': view(
      body({
        regime: regime({
          state: 'choppy',
          active: true,
          triggers: [{ t: H, kind: 'oracleGap', value: -0.0191, threshold: 0.0167 }],
          lastTriggerAt: H,
          since: H,
          holdsUntil: H24,
        }),
      }),
    ),
    'choppy, held': view(
      body({
        regime: regime({
          state: 'choppy',
          triggers: [{ t: H - 10 * HOUR_MS, kind: 'oracleGap', value: 0.02, threshold: 0.0167 }],
          lastTriggerAt: H - 10 * HOUR_MS,
          since: H - 10 * HOUR_MS,
          holdsUntil: H + 14 * HOUR_MS,
        }),
      }),
    ),
    stale: view(body({ regime: regime({ state: 'stale', stale: ['oracleOld'] }) })),
    loading: view(undefined, 'pending'),
    error: view(undefined, 'error'),
  }
  const words = (v: WeatherView) =>
    [
      v.regime.glyph,
      v.regime.text,
      v.reason?.lead,
      v.reason?.figure,
      v.reason?.tail,
      v.reason?.rarity,
      v.since,
      v.holds,
      v.sentence,
      v.credit,
      v.gas,
      ...v.ages,
      v.agesBrief,
      v.liq,
    ]
      .filter(Boolean)
      .join(' · ')

  it.each(Object.keys(states))('%s: no percentile jargon, no verdict words', (k) => {
    const text = words(states[k])
    expect(text).not.toMatch(/\bp\d|percentile|quantile|\bband\b/i)
    expect(text).not.toMatch(/\b(safe|odds)\b/i)
  })

  it.each(Object.keys(states))('%s: no arrow or triangle anywhere', (k) => {
    expect(words(states[k])).not.toMatch(/[▲▼△▽↑↓⬆⬇]/)
  })

  it('choppy is ink with the wave in every choppy state', () => {
    for (const k of ['choppy, move', 'choppy, gap', 'choppy, held']) {
      expect(states[k].regime).toEqual({ text: 'Choppy', glyph: '∿', caps: true })
    }
    expect(states['choppy, gap'].reason?.rarity).toBe('a 1-in-1,000 hour')
  })
})
