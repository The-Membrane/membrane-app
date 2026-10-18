// §07's detail view, pure (no React): the market-signal rows a card opens. Every string
// comes from the API response (the market, its I3 state, the T2 record, the feed's
// curator cuts) or from a constant named here; nothing is invented.
//
// Owner, 2026-10-18: "Curator feed · market signals — N of 4 signals on for this market",
// rows = signal · now · track record, then the actions. Four rows:
//   oracle vs market      the collateral-side gap now (I3), record = the T2 retrospective
//   curator cuts          peer moves on this collateral (feed, 24 h / 7 d), not yet tested
//   loan token off peg    the loan-side gap now (the f09536f7 split), not yet tested
//   top depositors leave  withheld: the model failed calibration for the largest holders
//                         (Q26 B4), so no number is shown

import { durationText, utc } from '@/lib/curatorFeed/format'
import {
  gapText,
  leadDaysText,
  pegOf,
  thresholdText,
  type I3Constants,
  type I3Record,
} from '@/lib/curatorFeed/oracleGap'
import type { OracleGapMarketView, PeerMoves } from '@/lib/curatorFeed/service'

import { cardState, loanSideOff, stateLine, usdPrice } from './oracleGapView'

/** on: the signal says look now · off: read, quiet · unread: could not say now ·
 *  none: does not apply to this market · withheld: deliberately not shown. */
export type SignalState = 'on' | 'off' | 'unread' | 'none' | 'withheld'

export interface SignalRow {
  id: 'oracle' | 'peers' | 'peg' | 'depositors'
  name: string
  kind: string
  state: SignalState
  now: string
  nowSub?: string
  record: string
  recordSub?: string
  /** The record's full test, for a hover and for a screen reader. */
  recordTitle?: string
}

export interface Signals {
  rows: SignalRow[]
  on: number
  /** Rows that can be on here (not withheld, not "does not apply"). */
  of: number
  unread: number
  headline: string
}

export const NOT_YET_TESTED = 'Not yet tested'

/** The withheld depositor forecast (owner, 2026-10-18): Q26 B4 failed calibration for the
 *  largest holders, so no figure is shown. */
export const DEPOSITORS_WITHHELD =
  'model failed calibration for the largest holders (Q26 B4) · not shown'

/** The feed is "read to now" when its newest block is within this of the clock. */
export const FEED_FRESH_SECONDS = 2 * 3600

const DAY = 86400

// ── the oracle row's record ──────────────────────────────────────────────────

/**
 * The I3 record in one line, every figure from the record: "Warned AZND 49d ahead ·
 * sdeUSD 6.7d (under 9 d) · not Oct 10 · 2 false alarms (stETH)". Fired carriers by lead
 * time; an incident where no carrier fired is "not <incident>"; false alarms are the calm
 * episode starts summed over every carrier.
 */
export function i3RecordLine(r: I3Record): string {
  const warnDays = r.constants.warnDays
  const fired = r.incidents
    .filter((x) => x.leadDays !== null)
    .sort((a, b) => (b.leadDays as number) - (a.leadDays as number))
  const parts = fired.map(
    (x, i) =>
      `${i === 0 ? 'Warned ' : ''}${x.asset} ${leadDaysText(x.leadDays as number)}d${i === 0 ? ' ahead' : ''}${x.warned9d ? '' : ` (under ${warnDays} d)`}`,
  )
  const byIncident = new Map<string, typeof r.incidents>()
  for (const x of r.incidents)
    byIncident.set(x.incident, [...(byIncident.get(x.incident) ?? []), x])
  for (const [incident, rows] of byIncident)
    if (rows.every((x) => x.leadDays === null))
      parts.push(`not ${incident.replace(/\s\d{4}$/, '')}`)
  const falseAlarms = r.incidents.reduce((s, x) => s + x.calmEpisodeStarts, 0)
  const who = [...new Set(r.incidents.filter((x) => x.calmEpisodeStarts > 0).map((x) => x.asset))]
  parts.push(
    `${falseAlarms} false alarm${falseAlarms === 1 ? '' : 's'}${who.length ? ` (${who.join(', ')})` : ''}`,
  )
  return parts.join(' · ')
}

/** "Q25 T2 · retrospective · FAIL overall, n = 3 incidents" */
export const i3RecordTest = (r: I3Record): string =>
  `Indicator record, all markets (${r.lane} ${r.test.split(/\s/)[0]}) · retrospective · ${r.verdict} overall, n = ${r.incidentCount} incidents`

/** T2 scored the oracle ABOVE market only: below market the indicator is untested. */
export const BELOW_UNTESTED = 'Not yet tested (T2 tested oracle above market only)'

// ── rows ───────────────────────────────────────────────────────────────────────

function oracleRow(
  m: OracleGapMarketView,
  c: I3Constants,
  record: I3Record,
  now: number,
): SignalRow {
  const line = thresholdText(c)
  const base = {
    id: 'oracle' as const,
    name: 'Oracle vs market',
    kind: 'timed warning',
    record: i3RecordLine(record),
    recordSub: i3RecordTest(record),
    recordTitle: record.test,
  }
  const { i3 } = m
  if (i3.state === 'stale' || i3.state === 'unobserved' || i3.currentGap === undefined)
    return {
      ...base,
      state: 'unread',
      now: '░ not measured now',
      nowSub:
        i3.state === 'stale' && i3.lastTs !== undefined
          ? `last point ${durationText(now - i3.lastTs)} old`
          : 'no point at the newest run',
    }
  const s = cardState(m, c)
  const below = s.dir === 'below'
  // Above market the run is I3's, over the whole stored series. Below market it is read on
  // the card's last 2 × persistence points: a run filling all of them is at least that.
  const capped = below && m.series.length >= 2 * i3.persistence && s.hours >= m.series.length
  const hours = capped ? `≥${m.series.length}` : String(s.hours)
  const line1 = stateLine(s, c).replace(`${s.hours} h`, `${hours} h`)
  const peg = m.loanSide
    ? loanSideOff(m, c)
      ? `collateral side · ${m.loanSymbol} valued at its peg here (it is off its peg: see below)`
      : `collateral side · ${m.loanSymbol} valued at its peg`
    : undefined
  return {
    ...base,
    ...(below ? { record: BELOW_UNTESTED, recordSub: undefined, recordTitle: undefined } : {}),
    state: s.tone === 'neutral' ? 'off' : 'on',
    now: s.tone === 'neutral' ? gapText(i3.currentGap) : `${gapText(i3.currentGap)} for ${hours} h`,
    nowSub: [
      s.tone === 'neutral' || below
        ? line1
        : `${line1} · fires at ≥ ${line} for ${c.persistenceHours} h`,
      ...(peg ? [peg] : []),
    ].join(' · '),
  }
}

const names = (xs: string[], max = 3): string =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} +${xs.length - max}`

function peersRow(p: PeerMoves | undefined, symbol: string, now: number): SignalRow {
  const base = {
    id: 'peers' as const,
    name: `Curator cuts on ${symbol}`,
    kind: 'peer moves',
    record: NOT_YET_TESTED,
  }
  if (!p) return { ...base, state: 'unread', now: '░ feed not read' }
  const to = p.feedToTs
  const from = p.feedFromTs
  // The 24 h window is read only if the feed spans it: from before its start to now.
  const read24 =
    to !== undefined && from !== undefined && from <= now - DAY && to >= now - FEED_FRESH_SECONDS
  const read7 =
    to !== undefined &&
    from !== undefined &&
    from <= now - 7 * DAY &&
    to >= now - FEED_FRESH_SECONDS
  const lag =
    to === undefined
      ? 'feed span unknown'
      : to < now - FEED_FRESH_SECONDS
        ? `feed read to ${utc(to)} (${durationText(now - to)} before now)`
        : from !== undefined && from > now - 7 * DAY
          ? `feed from ${utc(from)}`
          : undefined
  const cuts = (n: number) => `${n} cut${n === 1 ? '' : 's'}`
  const unknown = p.d7.directionUnknown
    ? `${p.d7.directionUnknown} cap change${p.d7.directionUnknown === 1 ? '' : 's'}, direction unknown (not counted)`
    : undefined
  const week = [
    p.d7.count > 0
      ? `7 d: ${cuts(p.d7.count)} · ${names(p.d7.curators)}`
      : read7
        ? '7 d: none'
        : '7 d: none in the part read',
    ...(unknown ? [unknown] : []),
  ].join(' · ')
  if (p.h24.count > 0)
    return {
      ...base,
      state: 'on',
      now: `${cuts(p.h24.count)} in 24 h`,
      nowSub: [names(p.h24.curators), week, ...(lag ? [lag] : [])].join(' · '),
    }
  if (!read24)
    return {
      ...base,
      state: 'unread',
      now: '░ last 24 h not read',
      nowSub: [week, ...(lag ? [lag] : [])].join(' · '),
    }
  return {
    ...base,
    state: 'off',
    now: 'none in 24 h',
    nowSub: [week, ...(lag ? [lag] : [])].join(' · '),
  }
}

function pegRow(m: OracleGapMarketView, c: I3Constants, now: number): SignalRow {
  const line = thresholdText(c)
  const base = {
    id: 'peg' as const,
    name: `${m.loanSymbol} off its peg`,
    kind: `spot check · ≥ ${line}`,
    record: NOT_YET_TESTED,
  }
  const l = m.loanSide
  if (!l) {
    if (!pegOf(m.loan))
      return {
        ...base,
        state: 'none',
        now: 'does not apply',
        nowSub: `${m.loanSymbol} has no peg on file`,
      }
    return { ...base, state: 'unread', now: '░ not read at the newest point' }
  }
  // The loan price is read with the market's point: a stale or unobserved market has no
  // reading now, only its last one.
  if (m.i3.state === 'stale' || m.i3.state === 'unobserved')
    return {
      ...base,
      state: 'unread',
      now: '░ not read at the newest point',
      nowSub: `last reading ${gapText(l.gap)}${m.latest ? `, ${durationText(now - m.latest.ts)} old` : ''}`,
    }
  const price =
    l.ref === 'USD'
      ? `${l.symbol} ${usdPrice(l.loanUsd / l.pegUsd)} vs $1`
      : `${l.symbol} ${Number((l.loanUsd / l.pegUsd).toPrecision(4))} ETH vs 1 ETH`
  return {
    ...base,
    state: loanSideOff(m, c) ? 'on' : 'off',
    now: gapText(l.gap),
    nowSub: `${price} · DefiLlama spot`,
  }
}

const depositorsRow = (): SignalRow => ({
  id: 'depositors',
  name: 'Top depositors leaving (forecast)',
  kind: 'forecast',
  state: 'withheld',
  now: DEPOSITORS_WITHHELD,
  record: 'Failed calibration (Q26 B4)',
})

/** The four rows for one market, and the headline count. */
export function marketSignals(
  m: OracleGapMarketView,
  r: {
    constants: I3Constants
    record: I3Record
    meta: { now: number }
    peerMoves?: Record<string, PeerMoves>
  },
): Signals {
  const now = r.meta.now
  const rows = [
    oracleRow(m, r.constants, r.record, now),
    peersRow(r.peerMoves?.[m.collateral], m.collateralSymbol, now),
    pegRow(m, r.constants, now),
    depositorsRow(),
  ]
  const counted = rows.filter((x) => x.state === 'on' || x.state === 'off' || x.state === 'unread')
  const on = rows.filter((x) => x.state === 'on').length
  const unread = rows.filter((x) => x.state === 'unread').length
  return {
    rows,
    on,
    of: counted.length,
    unread,
    headline: `${on} of ${counted.length} signals on for this market${unread ? ` · ${unread} not read now` : ''}`,
  }
}

// ── the actions: design only on this branch ──────────────────────────────────

export interface SignalAction {
  id: 'cap' | 'alert'
  label: string
  /** What it would do and who can do it. */
  note: string
}

/**
 * None is wired: lowering a cap would sign a transaction, and no
 * alert on this branch carries this signal (Radar's alerts route venue alarms to tracked
 * addresses; oracle vs market is not one of them).
 */
export const SIGNAL_ACTIONS: readonly SignalAction[] = [
  {
    id: 'cap',
    label: 'Lower your cap',
    note: "Would cut your vault's supply cap on this market; a cut applies at once. Who: the vault's curator or owner (V1), or curator or sentinel (V2).",
  },
  {
    id: 'alert',
    label: 'Alert me',
    note: "No alert carries this signal yet: Radar's alerts route venue alarms to tracked addresses, and oracle vs market is not one of them.",
  },
]
