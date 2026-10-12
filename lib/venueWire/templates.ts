/**
 * The template library. One finding → one headline line and three labels, filled from the
 * numbers only. Same input, same words: no generated prose, no probabilities, no verdict
 * words (design/DESIGN_RULES.md §4, §5b). Each label is one short line:
 *
 *   measured   what changed, with the numbers
 *   driver     what the data shows moved with it (never a guess at why)
 *   signal     what it may come before, as a possibility, never as odds
 *
 * Example: "Aave USDC idle cash 3.1%, lowest since May".
 */

import { compact } from '@/lib/curatorFeed/format'

import {
  indexAt,
  isoToTs,
  valueAt,
  type AssetFrame,
  type StressWindow,
  type VenueFrame,
  type WireFrames,
} from './series'
import type { Anomaly, MetricKey, Since, StateChange, StoryLabels } from './types'

const DAY = 86_400
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MINUS = '−'

// ------------------------------------------------------------------ number and date words

const utc = (ts: number) => new Date(ts * 1000)
export const monYear = (ts: number): string =>
  `${MONTHS[utc(ts).getUTCMonth()]} ${utc(ts).getUTCFullYear()}`
export const dayMon = (ts: number): string =>
  `${utc(ts).getUTCDate()} ${MONTHS[utc(ts).getUTCMonth()]}`
export const dayMonYear = (ts: number): string => `${dayMon(ts)} ${utc(ts).getUTCFullYear()}`
export const hourStamp = (ts: number): string =>
  utc(ts).toISOString().slice(0, 16).replace('T', ' ') + 'Z'

/**
 * "since May", "since Nov 2025", "since 3 Sep"; a record reads "on record (from Oct 2023)".
 * The year shows when it differs from the reading's year; the day shows inside 60 days.
 */
export function sinceWords(since: Since, at: number, recordFrom: number): string {
  if (since.ts === null) return `on record (from ${monYear(recordFrom)})`
  const sameYear = utc(since.ts).getUTCFullYear() === utc(at).getUTCFullYear()
  if (since.days < 60) return `since ${sameYear ? dayMon(since.ts) : dayMonYear(since.ts)}`
  return `since ${sameYear ? MONTHS[utc(since.ts).getUTCMonth()] : monYear(since.ts)}`
}

const signed = (x: number, s: string) => `${x < 0 ? MINUS : '+'}${s}`

export const pct = (x: number): string => {
  const a = Math.abs(x)
  const s = `${a.toFixed(a < 1 ? 2 : 1)}%`
  return x < 0 ? `${MINUS}${s}` : s
}
export const signedPct = (x: number): string => signed(x, `${Math.abs(x).toFixed(1)}%`)
export const bpsAsPct = (bps: number): string => `${(bps / 100).toFixed(2)}%`
export const usd = (x: number): string => (x < 0 ? `${MINUS}$${compact(-x)}` : `$${compact(x)}`)
export const signedUsd = (x: number): string => signed(x, `$${compact(Math.abs(x))}`)

/** "$2,410" for prices of 100 and up, "$0.9971" below. */
export function price(x: number): string {
  if (Math.abs(x) < 100) return `$${x.toFixed(4)}`
  const whole = Math.round(x)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `$${whole}`
}

/** A value in its series unit. */
export function valueWords(x: number, unit: string): string {
  if (unit === 'pct') return pct(x)
  if (unit === 'bps') return bpsAsPct(x)
  if (unit === 'usd') return usd(x)
  return `${compact(x)} ${unit}`
}
const signedValue = (x: number, unit: string): string =>
  unit === 'usd' ? signedUsd(x) : signed(x, `${compact(Math.abs(x))} ${unit}`)

// ------------------------------------------------------------------ helpers over frames

const WINDOW_RANK = (w: StressWindow) =>
  !w.trigger || w.trigger === 'named' ? 0 : w.trigger === 'eth-drop' ? 1 : 2

/** The stress window that holds ts: a named market event first, then an ETH drop, then this venue's episode. */
export function windowAt(
  windows: readonly StressWindow[],
  ts: number,
  subjectId: string,
): StressWindow | null {
  const hit = windows
    .filter(
      (w) => (!w.venue || w.venue === subjectId) && isoToTs(w.from) <= ts && ts <= isoToTs(w.to),
    )
    .sort((a, b) => WINDOW_RANK(a) - WINDOW_RANK(b))
  return hit[0] ?? null
}

/** A stress window in the reader's words (the builder's labels are internal). */
export function windowWords(w: StressWindow): string {
  if (!w.trigger || w.trigger === 'named') return `the ${w.label}`
  if (w.trigger === 'eth-drop') {
    const m = /(\d+(?:\.\d+)?)%/.exec(w.label)
    return m ? `a ${m[1]}% ETH drop` : 'an ETH drop'
  }
  const m = /util>=(\d+)/.exec(w.trigger)
  return m ? `a run of utilisation at or above ${m[1]}%` : 'a stress episode'
}

/** "Aave USDC, Spark USDC" for up to three venues; "Aave and Spark venues" above that. */
export function venueList(frames: WireFrames, ids: readonly string[]): string {
  const labels = ids.map((id) => frames.venues.get(id)?.subject.label ?? id)
  if (labels.length <= 3) return labels.join(', ')
  const protocols = [...new Set(labels.map((l) => l.split(' ')[0]))]
  const head =
    protocols.length > 1
      ? `${protocols.slice(0, -1).join(', ')} and ${protocols.at(-1)}`
      : protocols[0]
  return `${head} venues`
}

const MAX_BACK = 6 * 3600

/** Δ of a venue column between two times, or null. */
function deltaOf(f: VenueFrame, col: (number | null)[], from: number, to: number): number | null {
  const now = valueAt(f.t, col, to, MAX_BACK)
  const then = valueAt(f.t, col, from, MAX_BACK)
  return now === null || then === null ? null : now - then
}

function ethMove(
  frames: WireFrames,
  at: number,
  days: number,
  col: 'price' | 'ref' = 'price',
): number | null {
  const eth = frames.assets.get('eth')
  const c = eth ? (col === 'price' ? eth.price : eth.ref) : null
  if (!eth || !c) return null
  const now = valueAt(eth.t, c, at, MAX_BACK)
  const then = valueAt(eth.t, c, at - days * DAY, MAX_BACK)
  return now === null || then === null || then === 0 ? null : 100 * (now / then - 1)
}

// ------------------------------------------------------------------ level stories

interface LevelTemplate {
  headline: (subject: string, value: string, since: string) => string
  /** Value in the headline when it is not the series value (a price, not a discount). */
  headlineValue?: (x: number) => string
  /** The run headline's subject phrase ("Aave USDT idle cash 4.8%"). */
  runLead?: (subject: string, value: string) => string
  /** The headline value moves against the series (a discount shown as a price). */
  inverted?: boolean
}

const LEVEL: Record<MetricKey, Partial<Record<'low' | 'high', LevelTemplate>>> = {
  idleCashPct: {
    low: {
      headline: (s, v, w) => `${s} idle cash ${v}, lowest ${w}`,
      runLead: (s, v) => `${s} idle cash ${v}`,
    },
  },
  exitCapacity: {
    low: {
      headline: (s, v, w) => `${s} exit capacity ${v}, lowest ${w}`,
      runLead: (s, v) => `${s} exit capacity ${v}`,
    },
  },
  utilisationPct: {
    low: {
      headline: (s, v, w) => `${s} utilisation ${v}, lowest ${w}`,
      runLead: (s, v) => `${s} utilisation ${v}`,
    },
  },
  borrowAprPct: {
    high: {
      headline: (s, v, w) => `${s} borrow rate ${v}, highest ${w}`,
      runLead: (s, v) => `${s} borrow rate ${v}`,
    },
    low: {
      headline: (s, v, w) => `${s} borrow rate ${v}, lowest ${w}`,
      runLead: (s, v) => `${s} borrow rate ${v}`,
    },
  },
  navDiscountBps: {
    high: {
      headline: (s, v, w) => `${s} discount to NAV ${v}, widest ${w}`,
      runLead: (s, v) => `${s} discount to NAV ${v}`,
    },
  },
  depegBps: {
    high: {
      headline: (s, v, w) => `${s} at ${v}, widest discount to $1 ${w}`,
      headlineValue: (bps) => price(1 - bps / 1e4),
      runLead: (s, v) => `${s} at ${v}`,
      inverted: true,
    },
  },
  oracleDeviationBps: {
    high: {
      headline: (s, v, w) => `${s} oracle ${v} off Coinbase, widest gap ${w}`,
      runLead: (s, v) => `${s} oracle ${v} off Coinbase`,
    },
  },
  priceMove24hPct: {
    low: { headline: (s, v, w) => `${s} ${v} in 24h, largest drop ${w}`, headlineValue: signedPct },
  },
}

const durationWords = (s: number): string => {
  const h = Math.floor(s / 3600)
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`
}

function template(a: Anomaly): LevelTemplate {
  const t = LEVEL[a.baseline.metric][a.tail]
  if (!t) throw new Error(`venueWire: no template for ${a.baseline.metric} ${a.tail}`)
  return t
}

const headlineValue = (t: LevelTemplate, x: number, unit: string) =>
  t.headlineValue ? t.headlineValue(x) : valueWords(x, unit)

/**
 * The run's value and band edge as words. When both round to the same text ("4.8% under
 * 4.8%"), a percentage gets two decimals.
 */
function runValues(a: Anomaly): { value: string; band: string } {
  const t = template(a)
  const run = a.run as NonNullable<Anomaly['run']>
  const x = a.baseline.guard[a.tail]
  let value = headlineValue(t, x, a.baseline.unit)
  let edge = headlineValue(t, run.edge, a.baseline.unit)
  if (value === edge && a.baseline.unit === 'pct') {
    value = `${x.toFixed(2)}%`
    edge = `${run.edge.toFixed(2)}%`
  }
  const below = (a.tail === 'low') !== Boolean(t.inverted)
  return { value, band: `${below ? 'under' : 'over'} ${edge}` }
}

/** The one-line story. Level: "Aave USDC idle cash 3.1%, lowest since May". */
export function anomalyHeadline(a: Anomaly): string {
  const b = a.baseline
  const t = template(a)
  const since = sinceWords(a.since, b.at, b.bands.fromTs)
  if (a.kind === 'level')
    return t.headline(b.subject.label, headlineValue(t, b.guard[a.tail], b.unit), since)
  const run = a.run as NonNullable<Anomaly['run']>
  if (!t.runLead) throw new Error(`venueWire: no run template for ${b.metric} ${a.tail}`)
  const { value, band } = runValues(a)
  return `${t.runLead(b.subject.label, value)}, ${band} for ${durationWords(run.hours * 3600)}, longest run ${since}`
}

function runMeasured(a: Anomaly): string {
  const b = a.baseline
  const t = template(a)
  const run = a.run as NonNullable<Anomaly['run']>
  const { value, band } = runValues(a)
  const median = headlineValue(t, b.bands.p50, b.unit)
  return `${value} on ${dayMon(b.at)} · ${band} since ${hourStamp(run.from)} · median ${median} since ${monYear(b.bands.fromTs)}`
}

function levelMeasured(a: Anomaly, frames: WireFrames): string {
  if (a.kind === 'run') return runMeasured(a)
  const b = a.baseline
  const x = b.guard[a.tail]
  if (b.metric === 'priceMove24hPct') {
    const eth = frames.assets.get(b.subject.id)
    const now = eth ? valueAt(eth.t, eth.price, b.at, MAX_BACK) : null
    const then = eth ? valueAt(eth.t, eth.price, b.at - DAY, MAX_BACK) : null
    const prices =
      now !== null && then !== null
        ? `${price(now)} on ${dayMon(b.at)} · ${price(then)} 24h before · `
        : ''
    return `${prices}median 24h move ${signedPct(b.bands.p50)} since ${monYear(b.bands.fromTs)}`
  }
  const series = frames.series.find((s) => s.subject.id === b.subject.id && s.metric === b.metric)
  const before = series ? valueAt(series.t, series.v, b.at - 7 * DAY, MAX_BACK) : null
  const fmt = (n: number) => (b.metric === 'depegBps' ? price(1 - n / 1e4) : valueWords(n, b.unit))
  const parts = [`${fmt(x)} on ${dayMon(b.at)}`]
  if (before !== null) parts.push(`${fmt(before)} 7d before`)
  parts.push(`median ${fmt(b.bands.p50)} since ${monYear(b.bands.fromTs)}`)
  return parts.join(' · ')
}

function levelDriver(a: Anomaly, frames: WireFrames): string {
  const b = a.baseline
  const at = b.at
  const venue = frames.venues.get(b.subject.id)
  if (
    venue &&
    (b.metric === 'idleCashPct' || b.metric === 'exitCapacity' || b.metric === 'utilisationPct')
  ) {
    // A run reports the flows since it began; a level the 7 days before its reading.
    const from = a.run ? a.run.from : at - 7 * DAY
    const span = a.run ? `Since ${dayMon(a.run.from)}` : '7d'
    const dDebt = deltaOf(venue, venue.debt, from, at)
    const dSupply = deltaOf(venue, venue.supply, from, at)
    if (dDebt === null || dSupply === null) return `${span} flows not measured`
    const unit = venue.usd ? 'usd' : venue.symbol
    return `${span}: ${venue.morpho ? 'lent out' : 'borrows'} ${signedValue(dDebt, unit)}, deposits ${signedValue(dSupply, unit)}`
  }
  if (venue && b.metric === 'borrowAprPct') {
    const u = valueAt(venue.t, venue.util, at, MAX_BACK)
    const u7 = valueAt(venue.t, venue.util, at - 7 * DAY, MAX_BACK)
    if (u === null) return 'Utilisation not measured'
    return u7 === null
      ? `Utilisation ${pct(100 * u)}`
      : `Utilisation ${pct(100 * u)} (${pct(100 * u7)} 7d before)`
  }
  const asset: AssetFrame | undefined = frames.assets.get(b.subject.id)
  if (b.metric === 'navDiscountBps' && asset) {
    const r = valueAt(asset.t, asset.price, at, MAX_BACK)
    const m = ethMove(frames, at, 7)
    const head = r === null ? `${asset.priceName} not read` : `${asset.priceName} ${r.toFixed(4)}`
    return m === null ? head : `${head} · ETH/USD ${signedPct(m)} over 7d`
  }
  if (b.metric === 'depegBps' && asset) {
    const i = indexAt(asset.t, at)
    let low = Infinity
    for (let j = i; j >= 0 && at - asset.t[j] <= 7 * DAY; j--) {
      const p = asset.price[j]
      if (p !== null && p < low) low = p
    }
    return Number.isFinite(low)
      ? `${asset.priceName} 7d low ${price(low)}: a market price, with no venue flow behind it in this feed`
      : `${asset.priceName} not read in the 7d before`
  }
  if (b.metric === 'oracleDeviationBps' && asset) {
    const o = valueAt(asset.t, asset.price, at, MAX_BACK)
    const c = asset.ref ? valueAt(asset.t, asset.ref, at, MAX_BACK) : null
    const m = ethMove(frames, at, 1, 'ref')
    const head =
      o !== null && c !== null
        ? `Chainlink ${price(o)} vs Coinbase ${price(c)}`
        : 'Chainlink vs Coinbase'
    return m === null ? head : `${head} · Coinbase ${signedPct(m)} in 24h`
  }
  if (b.metric === 'priceMove24hPct') {
    const m = ethMove(frames, at, 1, 'ref')
    return m === null
      ? 'Market-wide move not cross-checked'
      : `Market-wide: Coinbase ETH/USD ${signedPct(m)} in the same 24h`
  }
  return 'No driver in the data'
}

function levelSignal(a: Anomaly, frames: WireFrames): string {
  const b = a.baseline
  const venue = frames.venues.get(b.subject.id)
  const asset = frames.assets.get(b.subject.id)
  // Only venues that held material size at the story's time.
  const live = asset
    ? asset.affects.filter((id) => (frames.venues.get(id)?.fromTs ?? Infinity) <= b.at)
    : []
  const affects = venueList(frames, live)
  let line: string
  switch (b.metric) {
    case 'idleCashPct':
    case 'exitCapacity': {
      const exit = venue ? valueAt(venue.t, venue.exit, b.at, MAX_BACK) : null
      const size =
        exit === null
          ? 'the idle cash'
          : valueWords(exit, venue?.usd ? 'usd' : (venue?.symbol ?? b.unit))
      const wait = venue?.morpho ? 'repayments in its markets' : 'repayments or new deposits'
      line = `May precede an exit queue: withdrawals above ${size} would wait for ${wait}.`
      break
    }
    case 'utilisationPct':
      line = 'May precede lower supply yield: rates follow utilisation down.'
      break
    case 'borrowAprPct':
      line =
        a.tail === 'high'
          ? `May precede deleveraging: carry funded here would pay ${pct(b.guard.high)} to borrow.`
          : `May precede new borrowing: carry funded here would pay ${pct(b.guard.low)} to borrow.`
      break
    case 'navDiscountBps':
      line = affects
        ? `May precede stETH loop unwinds that draw WETH from ${affects}.`
        : 'May precede stETH loop unwinds.'
      break
    case 'depegBps':
      line = affects
        ? `May precede withdrawals from ${affects}, and liquidations where it is priced at market.`
        : 'May precede liquidations where it is collateral priced at market.'
      break
    case 'oracleDeviationBps':
      line = 'May precede liquidations priced off the oracle, not the market.'
      break
    case 'priceMove24hPct':
      line = affects
        ? `May precede liquidations of ETH-backed loans on ${affects}.`
        : 'May precede liquidations of ETH-backed loans.'
      break
  }
  if (a.since.ts !== null) {
    const w = windowAt(frames.windows, a.since.ts, b.subject.id)
    if (w)
      line +=
        a.kind === 'run'
          ? ` The last run this long ended on ${dayMonYear(a.since.ts)}, in ${windowWords(w)}.`
          : ` Last at this level on ${dayMonYear(a.since.ts)}, in ${windowWords(w)}.`
  }
  return line
}

export function anomalyLabels(a: Anomaly, frames: WireFrames): StoryLabels {
  return {
    measured: levelMeasured(a, frames),
    driver: levelDriver(a, frames),
    signal: levelSignal(a, frames),
  }
}

// ------------------------------------------------------------------ state stories

export function stateHeadline(c: StateChange): string {
  const what = c.flag === 'frozen' ? 'reserve' : 'withdrawals'
  if (!c.on) {
    const verb = c.flag === 'frozen' ? 'unfrozen' : 'resumed'
    return c.runFrom === null
      ? `${c.subject.label} ${what} ${verb}`
      : `${c.subject.label} ${what} ${verb} after ${durationWords(c.at - c.runFrom)}`
  }
  const first =
    c.previous === null
      ? `on record (from ${monYear(c.recordFromTs)})`
      : `since ${dayMonYear(c.previous)}`
  return `${c.subject.label} ${what} ${c.flag}, first time ${first}`
}

export function stateLabels(c: StateChange): StoryLabels {
  const block = c.block === null ? '' : ` at block ${c.block}`
  const measured = `Reserve flag ${c.flag} ${c.on ? 'set' : 'cleared'}${block}, read ${hourStamp(c.at)}`
  const driver = 'Pool configuration change on-chain'
  let signal: string
  if (c.flag === 'frozen')
    signal = c.on
      ? 'May precede parameter changes: new deposits and borrows are blocked, withdrawals and repayments still work.'
      : 'New deposits and borrows are open again.'
  else
    signal = c.on
      ? 'Withdrawals are blocked: every exit from this venue waits for an unpause.'
      : 'Withdrawals are open again.'
  return { measured, driver, signal }
}

/** Words §4 bans in any story (verdicts, odds, promises). Exported for the tests. */
export const BANNED = [
  /\bsafe\b/i,
  /\bok\b/i,
  /\bgood\b/i,
  /positive carry/i,
  /\bprobabilit/i,
  /\bchance\b/i,
  /\blikely\b/i,
  /\bodds\b/i,
  /\bwill\b/i,
  /\bguarantee/i,
  /\bforecast/i,
  /\bfree\b/i,
]
