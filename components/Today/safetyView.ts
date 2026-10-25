// THE SAFETY BODY — view model. Pure: the API responses (or their loading/error state)
// and the reader's clock in; every string the body prints out. No React, so the unit
// tests run it in node.
//
// Three modules (membrane-board design/DESIGN_RULES.md §5b, finding → evidence → action):
//   1. YOUR POSITION  a pasted address (or the connected wallet, read-only, no signature)
//                     goes to Radar, which reads its venue positions. Nothing personal is
//                     printed here: no address, no numbers.
//   2. VENUE ALARMS   GET /api/venues/alarms, open alarms only. The alarm checker runs at
//                     the end of the recorder's hourly tick over the recorder's own
//                     readings, so its findings are as fresh as the newest venue reading
//                     (the /summary observedAt): that is the as-of, and past
//                     RECORDER_MAX_AGE_MS the headline is withheld and the rows hatched.
//   3. CURATOR EXITS  components/CuratorFeed CuratorFeedCard, which owns its own states.
// There is no live source for a freeze-vote status, so there is no such module.

import { isUnreadDepthAlarm, type AlarmLike } from '@/components/Radar/alertLogic'
import { formatAge, utcClock } from '@/components/Weather/weatherView'
import type { VenueSummary } from '@/pages/api/venues/[venue]/summary'

import {
  RECORDER_MAX_AGE_MS,
  usdShort,
  venueHref,
  venueLabel,
  type Load,
} from './opportunitiesView'

export const SAFETY_COPY = {
  positionKicker: 'Your position',
  headline: 'Can your positions exit now?',
  deck: 'Read-only. No signature.',
  inputLabel: 'Ethereum address',
  placeholder: '0x…',
  action: 'Check on Radar →',
  invalid: 'Not an Ethereum address.',
  useWallet: 'Use connected wallet',
  alarmsKicker: 'Alarms',
  alarmsUnavailable: 'Venue alarms unavailable',
  openVenue: 'Open venue →',
} as const

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/** The Radar permalink for a pasted address, or null when it is not an address. */
export function radarHref(chain: string, raw: string): string | null {
  const a = raw.trim()
  return ADDRESS_RE.test(a) ? `/${chain}/radar/${a}` : null
}

/** "0x7AdA…d142". */
export const shortAddr = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

export interface AlarmFinding {
  lead: string
  /** The figure; null for an alarm that has none (a gate change). */
  figure: string | null
  /** A decrease: red, with the ✖ glyph. */
  loss: boolean
  tail: string
}

export interface AlarmRowView {
  key: string
  label: string
  severity: 'Alarm' | 'Watch'
  finding: AlarmFinding
  /** When it fired: "7 Oct 05:49 UTC". */
  fired: string
  href: string
}

export interface AlarmsView {
  state: 'loading' | 'error' | 'none' | 'open' | 'stale'
  hatched: boolean
  /** Under the "Alarms" kicker: "2 open." / "None open." */
  headline: string | null
  withheld: string | null
  /** "as of 14:45 UTC": the newest venue reading the checker judged. Printed when none
   *  is open (silence needs its as-of); open alarms carry their own times, and data past
   *  RECORDER_MAX_AGE_MS is withheld either way. */
  asOf: string | null
  rows: AlarmRowView[]
}

const num = (v: unknown): number | null => {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n
}
const money = (v: unknown): string => {
  const n = num(v)
  return n === null ? '—' : usdShort(n)
}
/** A fall, as a whole %, rounded toward risk (up). */
const fallPct = (v: unknown): string => {
  const n = num(v)
  return n === null ? '—' : `${Math.ceil(Math.abs(n) - 1e-9)}%`
}

const GATE_WORDS: Record<string, string> = {
  cooldown_duration_changed: 'Cooldown changed',
  instant_liquidity_shift: 'Instant cash moved',
  terms_page_changed: 'Terms page changed',
}

const humanize = (kind: string): string => {
  const s = kind.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** One alarm as a short finding in the reader's words. Each kind's figures come from the
 *  evidence the checker stored (scripts/lib/alarmRules.mjs). */
export function alarmFinding(a: Pick<AlarmLike, 'kind' | 'evidence'>): AlarmFinding {
  const ev = a.evidence ?? {}
  switch (a.kind) {
    case 'utilization': {
      const u = num(ev.utilizationPct)
      return { lead: 'Lent out', figure: u === null ? '—' : `${(Math.ceil(u * 10 - 1e-9) / 10).toFixed(1)}%`, loss: false, tail: '' }
    }
    case 'headroom_thin':
      // What the venue holds for exits, not an instruction (owner, 2026-10-16).
      return { lead: 'Exit available', figure: money(ev.instantUsd), loss: false, tail: `vs worst day out ${money(ev.worstDayOutflowUsd)}` }
    case 'depth_collapse':
      return { lead: 'Swap pool fell', figure: fallPct(ev.dropPct), loss: true, tail: `${money(ev.fromValue)} → ${money(ev.toValue)}` }
    case 'drawdown_fast':
      return { lead: 'Exit capacity fell', figure: fallPct(ev.dropPct), loss: true, tail: `${money(ev.fromValue)} → ${money(ev.toValue)}` }
    case 'net_outflow_streak': {
      const days = num(ev.streakDays)
      return {
        lead: `Outflow ${days ?? '—'} days running,`,
        figure: `−${fallPct(ev.pctOfTvl)}`,
        loss: true,
        tail: 'of deposits',
      }
    }
    case 'depth_skew': {
      const k = num(ev.skewPct)
      return { lead: 'Exit pool', figure: k === null ? '—' : `${Math.ceil(k - 1e-9)}%`, loss: false, tail: 'one-sided' }
    }
    case 'gate_change': {
      const latest = (ev.latest ?? {}) as Record<string, unknown>
      const kind = typeof latest.kind === 'string' ? latest.kind : ''
      return { lead: GATE_WORDS[kind] ?? 'Exit terms changed', figure: null, loss: false, tail: 'in the last 24h' }
    }
    default:
      return { lead: humanize(a.kind), figure: null, loss: false, tail: '' }
  }
}

/** The newest venue reading among the loaded summaries (ms), or null. */
export function newestReading(summaries: Load<VenueSummary>[]): number | null {
  let best: number | null = null
  for (const s of summaries) {
    const at = s.data?.observed ? Date.parse(s.data.observed.observedAt) : NaN
    if (Number.isFinite(at) && (best === null || at > best)) best = at
  }
  return best
}

export function alarmsView(input: {
  alarms: Load<{ open: AlarmLike[] }>
  summaries: Load<VenueSummary>[]
  chain: string
  nowMs: number
}): AlarmsView {
  const { alarms, summaries, chain, nowMs } = input
  const base: AlarmsView = { state: 'loading', hatched: false, headline: null, withheld: null, asOf: null, rows: [] }
  if (!alarms.data) {
    if (alarms.status === 'pending') return base
    return { ...base, state: 'error', hatched: true, withheld: SAFETY_COPY.alarmsUnavailable }
  }
  if (summaries.some((s) => s.status === 'pending' && !s.data)) return base

  const labelOf = (venue: string) =>
    venueLabel(venue, summaries.find((s) => s.data?.venue === venue)?.data?.label)
  const rows: AlarmRowView[] = alarms.data.open
    .filter((a) => a.clearedAt === null && !isUnreadDepthAlarm(a))
    .sort((x, y) => Date.parse(y.firedAt) - Date.parse(x.firedAt))
    .map((a) => ({
      key: `${a.venue}:${a.kind}:${a.firedAt}`,
      label: labelOf(a.venue),
      severity: a.severity === 'watch' ? 'Watch' : 'Alarm',
      finding: alarmFinding(a),
      fired: utcClock(Date.parse(a.firedAt), nowMs),
      href: venueHref(chain, a.venue),
    }))

  const at = newestReading(summaries)
  if (at === null || nowMs - at > RECORDER_MAX_AGE_MS) {
    return {
      ...base,
      state: 'stale',
      hatched: true,
      withheld: at === null ? 'Withheld · venue data age unknown' : `Withheld · venue data ${formatAge(nowMs - at)} old`,
      // The withheld line already carries the age: the as-of would say it twice.
      asOf: null,
      rows,
    }
  }
  const asOf = `as of ${utcClock(at, nowMs)}`
  if (rows.length === 0) {
    return { ...base, state: 'none', headline: 'None open.', asOf }
  }
  return { ...base, state: 'open', headline: `${rows.length} open.`, rows }
}
