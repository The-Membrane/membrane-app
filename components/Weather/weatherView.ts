// THE WEATHER STRIP — view model. Pure: the response from GET /api/weather plus the
// reader's clock in, every string the strip prints out. No React, so the unit tests run it
// in node. Rules: membrane-board design/DESIGN_RULES.md (calm is ink; red = a decrease and
// always carries a glyph; stale = hatch, headline withheld, ages shown; no number without
// a live source; one failed input hides only its own element). Plain words (owner, on
// PR #106): no percentile labels, and the DVOL line says it is volatility, with no direction.

import type { WeatherResponse } from '@/lib/weather/handler'
import { HOUR_MS, M0_MAX_INPUT_AGE_MS, type M0Result, type M0Trigger } from '@/lib/regime/m0'
import { m0OneIn, type M0OneIn } from '@/lib/regime/thresholds'

export type StripKind = 'loading' | 'error' | 'calm' | 'choppy' | 'stale'

/** One reason: "ETH −9.2% in 24h" + "a 1-in-20 day". The figure is red only for a fall. */
export interface Reason {
  lead: string
  figure: string
  /** A decrease: red, with the ✖ glyph. */
  loss: boolean
  tail: string
  /** How rare the threshold it crossed is, in plain words: "a 1-in-20 day". The strip
   *  drops it below 1280px; the method table has it. */
  rarity: string
}

export interface WeatherView {
  kind: StripKind
  /** Hatched strip: stale or unavailable. */
  hatched: boolean
  /** The regime word (or the withheld / unavailable line) and its glyph. Choppy's ∿ is a
   *  wave, not a direction: an arrow or triangle would read as "price up" (owner). */
  regime: { text: string; glyph: '∿' | '░' | null; caps: boolean }
  /** Choppy with a trigger in the latest hour. */
  reason: Reason | null
  /** Choppy only by the hold: "since 09:00 UTC". */
  since: string | null
  /** Choppy: "holds to 14:00 UTC". */
  holds: string | null
  sentence: string | null
  credit: string | null
  gas: string | null
  /** Every input's age, desktop dateline: "Chainlink 12m", "DVOL unavailable". */
  ages: string[]
  /** Phones: the same facts in one item — "inputs ≤40m old", or what is old or missing. */
  agesBrief: string | null
  liq: string | null
}

export const STRIP_COPY = {
  calm: 'Calm',
  choppy: 'Choppy',
  withheld: 'Regime withheld · inputs stale',
  unavailable: 'Weather unavailable',
  liq: 'Liq. volume not counted · no live source',
  credit: 'Deribit DVOL ÷ √365 · measured',
  dash: '—',
} as const

/** The DVOL line: volatility, with no direction (owner: "we have to vocalize that being
 *  volatility"). One serif line in a 390px screen's 358px up to a 99.9% swing (343px by
 *  the italic's advance widths). */
export function volatilitySentence(dailyMovePct: number): string {
  return `ETH volatility: options price a ${dailyMovePct.toFixed(1)}% daily swing, up or down.`
}

/** "a 1-in-20 day": the share of readings at or past a threshold, in the reading's unit
 *  (the 24h move is a day; the oracle gap is an hourly reading). */
export function rarity(oneIn: number, unit: 'day' | 'hour'): string {
  return `a 1-in-${oneIn.toLocaleString('en-US')} ${unit}`
}

const ONE_IN = m0OneIn()

/** Inputs past these ages are not printed as figures (their age still is). The regime's
 *  own inputs use M0's two heartbeats; DVOL is one hourly candle late at 2h; a base fee
 *  older than 15 min is no longer the current fee. */
export const MAX_AGE_MS = {
  oracle: M0_MAX_INPUT_AGE_MS,
  market: M0_MAX_INPUT_AGE_MS,
  dvol: 2 * HOUR_MS,
  gas: 15 * 60_000,
} as const

/** The typographic minus (U+2212), escaped so no encoding step can turn it into a hyphen. */
const MINUS = '\u2212'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "12m", "9s", "3h", "2d" — floored. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const TWO_SIGNIFICANT = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2 })

/** 2 significant digits under 1 gwei, else 1 decimal. */
export function formatGwei(gwei: number): string {
  if (gwei < 1) return TWO_SIGNIFICANT.format(gwei)
  return gwei.toFixed(1)
}

/** "−9.2%" / "+9.2%" from a signed fraction. */
export function signedPct(v: number, digits: number): string {
  const s = (Math.abs(v) * 100).toFixed(digits)
  if (Number(s) === 0) return `${s}%`
  return `${v < 0 ? MINUS : '+'}${s}%`
}

const pct = (v: number, digits: number) => `${(Math.abs(v) * 100).toFixed(digits)}%`

/** "14:00 UTC", with the UTC day in front when it is not the reader's UTC day. */
export function utcClock(ms: number, nowMs: number): string {
  const d = new Date(ms)
  const n = new Date(nowMs)
  const hm = d.toISOString().slice(11, 16)
  const sameDay =
    d.getUTCFullYear() === n.getUTCFullYear() &&
    d.getUTCMonth() === n.getUTCMonth() &&
    d.getUTCDate() === n.getUTCDate()
  return sameDay ? `${hm} UTC` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hm} UTC`
}

/** The reason printed for an active trigger: the move if it fired, else the gap. */
export function reasonFor(
  triggers: M0Trigger[],
  at: number,
  oneIn: M0OneIn = ONE_IN,
): Reason | null {
  const here = triggers.filter((t) => t.t === at)
  const move = here.find((t) => t.kind === 'move24h')
  if (move) {
    return {
      lead: 'ETH',
      figure: signedPct(move.value, 1),
      loss: move.value < 0,
      tail: 'in 24h',
      rarity: rarity(oneIn.move24h, 'day'),
    }
  }
  const gap = here.find((t) => t.kind === 'oracleGap')
  if (gap) {
    return {
      lead: 'Chainlink',
      figure: pct(gap.value, 2),
      loss: false,
      tail: `${gap.value < 0 ? 'below' : 'above'} Coinbase`,
      rarity: rarity(oneIn.gap, 'hour'),
    }
  }
  return null
}

export interface AgeInput {
  name: string
  asOf: number | null
  failed: boolean
  maxAge: number
}

function agesOf(body: WeatherResponse): AgeInput[] {
  const r = body.regime
  return [
    {
      name: 'Chainlink',
      asOf: r.inputs.oracleAsOf,
      failed: !!body.errors.oracle,
      maxAge: MAX_AGE_MS.oracle,
    },
    {
      name: 'Coinbase',
      asOf: r.inputs.marketAsOf,
      failed: !!body.errors.market,
      maxAge: MAX_AGE_MS.market,
    },
    { name: 'DVOL', asOf: body.dvol?.asOfMs ?? null, failed: !body.dvol, maxAge: MAX_AGE_MS.dvol },
    { name: 'gas', asOf: body.gas?.asOfMs ?? null, failed: !body.gas, maxAge: MAX_AGE_MS.gas },
  ]
}

const fresh = (asOf: number | null | undefined, maxAge: number, nowMs: number): asOf is number =>
  typeof asOf === 'number' && nowMs - asOf <= maxAge

/** The phones' dateline row holds 54 mono characters at 390px (358px ÷ 6.6px); 2 spare. */
export const PHONE_LINE_CHARS = 52

/**
 * The ages in one item, for phones: "inputs ≤40m old" when all are fresh, else what is old
 * or missing, inputs in the same state grouped ("Chainlink, Coinbase 3h old"; all four:
 * "inputs 3h old"). If that would not fit beside the base fee on one 390px line, it falls
 * back to a count ("3 inputs old or unavailable"); the wide dateline still lists each age.
 */
export function agesBriefOf(inputs: AgeInput[], nowMs: number, gas: string | null): string {
  const bad = inputs.filter((a) => a.failed || a.asOf === null || !fresh(a.asOf, a.maxAge, nowMs))
  if (!bad.length) {
    const oldest = Math.max(...inputs.map((a) => nowMs - (a.asOf as number)))
    return `inputs ≤${formatAge(oldest)} old`
  }
  const missing = (a: AgeInput) => a.failed || a.asOf === null
  const groups = new Map<string, string[]>()
  for (const a of bad) {
    const state = missing(a) ? 'unavailable' : `${formatAge(nowMs - (a.asOf as number))} old`
    groups.set(state, [...(groups.get(state) ?? []), a.name])
  }
  const named = [...groups]
    .map(([state, names]) =>
      names.length === inputs.length ? `inputs ${state}` : `${names.join(', ')} ${state}`,
    )
    .join(' · ')
  if (named.length <= PHONE_LINE_CHARS - (gas ? gas.length + 3 : 0)) return named
  const unavailable = bad.filter(missing).length
  const what =
    unavailable === 0 ? 'old' : unavailable === bad.length ? 'unavailable' : 'old or unavailable'
  return `${bad.length} inputs ${what}`
}

const EMPTY: Omit<WeatherView, 'kind' | 'hatched' | 'regime'> = {
  reason: null,
  since: null,
  holds: null,
  sentence: null,
  credit: null,
  gas: null,
  ages: [],
  agesBrief: null,
  liq: null,
}

export function weatherView(input: {
  status: 'pending' | 'error' | 'success'
  data: WeatherResponse | undefined
  nowMs: number
}): WeatherView {
  const { data, nowMs } = input
  if (!data) {
    if (input.status === 'pending') {
      return {
        ...EMPTY,
        kind: 'loading',
        hatched: false,
        regime: { text: STRIP_COPY.dash, glyph: null, caps: false },
        sentence: STRIP_COPY.dash,
        agesBrief: STRIP_COPY.dash,
      }
    }
    return {
      ...EMPTY,
      kind: 'error',
      hatched: true,
      regime: { text: STRIP_COPY.unavailable, glyph: '░', caps: true },
    }
  }

  const r: M0Result = data.regime
  // A response this old (a dead network keeps the last good one) is itself stale input.
  const responseOld = nowMs - data.now > M0_MAX_INPUT_AGE_MS
  const kind: StripKind = responseOld ? 'stale' : r.state

  const inputs = agesOf(data)
  const ages = inputs.map((a) =>
    a.failed || a.asOf === null
      ? `${a.name} unavailable`
      : `${a.name} ${formatAge(nowMs - a.asOf)}`,
  )
  const dvolFresh = data.dvol && fresh(data.dvol.asOfMs, MAX_AGE_MS.dvol, nowMs) ? data.dvol : null
  const gasFresh = data.gas && fresh(data.gas.asOfMs, MAX_AGE_MS.gas, nowMs) ? data.gas : null
  const gas = gasFresh ? `Base fee ${formatGwei(gasFresh.gwei)} gwei` : null
  const agesBrief = agesBriefOf(inputs, nowMs, gas)

  const base = {
    ...EMPTY,
    sentence: dvolFresh ? volatilitySentence(dvolFresh.dailyMovePct) : null,
    credit: dvolFresh ? STRIP_COPY.credit : null,
    gas,
    ages,
    agesBrief,
    liq: STRIP_COPY.liq,
  }

  if (kind === 'stale') {
    return {
      ...base,
      kind,
      hatched: true,
      regime: { text: STRIP_COPY.withheld, glyph: '░', caps: true },
    }
  }
  if (kind === 'calm') {
    return {
      ...base,
      kind,
      hatched: false,
      regime: { text: STRIP_COPY.calm, glyph: null, caps: true },
    }
  }
  // Choppy. Active: the reason and the hold. Held: since … · holds to ….
  const active = r.active && r.lastTriggerAt !== null
  return {
    ...base,
    kind,
    hatched: false,
    regime: { text: STRIP_COPY.choppy, glyph: '∿', caps: true },
    reason: active ? reasonFor(r.triggers, r.lastTriggerAt as number) : null,
    since: !active && r.since !== null ? `since ${utcClock(r.since, nowMs)}` : null,
    holds: r.holdsUntil !== null ? `holds to ${utcClock(r.holdsUntil, nowMs)}` : null,
  }
}
