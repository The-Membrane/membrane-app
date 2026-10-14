import { describe, expect, it } from 'vitest'

import type { AlarmLike } from '@/components/Radar/alertLogic'
import { RECORDER_MAX_AGE_MS, type Load } from '@/components/Today/opportunitiesView'
import {
  alarmFinding,
  alarmsView,
  newestReading,
  radarHref,
  SAFETY_COPY,
  shortAddr,
} from '@/components/Today/safetyView'
import { HOUR_MS } from '@/lib/regime/m0'
import type { VenueSummary } from '@/pages/api/venues/[venue]/summary'

// The Safety body's view model: the address hand-off to Radar, each alarm as a short
// finding, and the alarms module in every state (loading, error, stale, none, open).

const NOW = Date.UTC(2026, 9, 14, 12, 30)
const ok = <T>(data: T): Load<T> => ({ status: 'success', data })
const PENDING = { status: 'pending', data: undefined } as const
const FAILED = { status: 'error', data: undefined } as const
const ADDR = '0x1601843c5E9bC251A3272907010AFa41Fa18347E'

describe('the position hand-off', () => {
  it('goes to the Radar permalink for a pasted address, trimmed; nothing else', () => {
    expect(radarHref('ethereum', `  ${ADDR} `)).toBe(`/ethereum/radar/${ADDR}`)
    expect(radarHref('ethereum', ADDR.slice(0, 41))).toBeNull()
    expect(radarHref('ethereum', 'vitalik.eth')).toBeNull()
    expect(radarHref('ethereum', '')).toBeNull()
    expect(shortAddr(ADDR)).toBe('0x1601…347E')
  })
})

describe('alarmFinding', () => {
  it('a fall is red with a whole %, rounded toward risk, and its $ path in ink', () => {
    expect(alarmFinding({ kind: 'depth_collapse', evidence: { dropPct: -51.2, fromValue: 40.8e6, toValue: 19.6e6 } })).toEqual({
      lead: 'Swap pool fell',
      figure: '52%',
      loss: true,
      tail: '$40.8M → $19.6M',
    })
    expect(alarmFinding({ kind: 'drawdown_fast', evidence: { dropPct: -24, fromValue: 10e6, toValue: 7.6e6 } })).toMatchObject({
      lead: 'Exit capacity fell',
      figure: '24%',
      loss: true,
    })
    expect(alarmFinding({ kind: 'net_outflow_streak', evidence: { streakDays: 21, pctOfTvl: 11.2, cumulativeOutflowUsd: 9e6 } })).toEqual({
      lead: 'Outflow 21 days running,',
      figure: '−12%',
      loss: true,
      tail: 'of deposits',
    })
  })

  it('levels are ink', () => {
    expect(alarmFinding({ kind: 'utilization', evidence: { utilizationPct: 91.24 } })).toMatchObject({ lead: 'Lent out', figure: '91.3%', loss: false })
    expect(alarmFinding({ kind: 'headroom_thin', evidence: { instantUsd: 12.4e6, worstDayOutflowUsd: 9.8e6 } })).toEqual({
      lead: 'Exit now',
      figure: '$12.4M',
      loss: false,
      tail: 'vs worst day out $9.8M',
    })
    expect(alarmFinding({ kind: 'depth_skew', evidence: { skewPct: 91.2 } })).toMatchObject({ figure: '92%', tail: 'one-sided' })
  })

  it('a gate change names what moved; unknown kinds read as words; missing figures are dashes', () => {
    expect(alarmFinding({ kind: 'gate_change', evidence: { latest: { kind: 'cooldown_duration_changed' } } })).toMatchObject({
      lead: 'Cooldown changed',
      figure: null,
    })
    expect(alarmFinding({ kind: 'gate_change', evidence: null }).lead).toBe('Exit terms changed')
    expect(alarmFinding({ kind: 'terms_page_notice', evidence: null })).toMatchObject({ lead: 'Terms page notice', figure: null })
    expect(alarmFinding({ kind: 'utilization', evidence: {} }).figure).toBe('—')
  })
})

const summary = (venue: string, observedAt: string): VenueSummary =>
  ({
    venue,
    label: venue === 'aave-v3-usde' ? 'Aave' : venue,
    observed: { block: 1, observedAt, instantUsd: 1, params: {} },
  }) as unknown as VenueSummary
const sums = (at: string): Load<VenueSummary>[] =>
  ['sUSDe', 'aave-v3-usde', 'sUSDS', 'scrvUSD'].map((v) => ok(summary(v, at)))
const FRESH = new Date(NOW - 22 * 60_000).toISOString()
const WEEK_OLD = '2026-10-07T02:45:19.338Z'

const alarm = (over: Partial<AlarmLike>): AlarmLike => ({
  venue: 'scrvUSD',
  kind: 'utilization',
  severity: 'alarm',
  evidence: { utilizationPct: 96 },
  firedAt: new Date(NOW - HOUR_MS).toISOString(),
  clearedAt: null,
  ...over,
})

describe('alarmsView', () => {
  const view = (a: Load<{ open: AlarmLike[] }>, s: Load<VenueSummary>[] = sums(FRESH)) =>
    alarmsView({ alarms: a, summaries: s, chain: 'ethereum', nowMs: NOW })

  it('none open on fresh data: one ink line with the as-of', () => {
    expect(view(ok({ open: [] }))).toEqual({
      state: 'none',
      hatched: false,
      headline: 'None open.',
      withheld: null,
      asOf: 'as of 12:08 UTC',
      rows: [],
    })
  })

  it('open alarms: newest first, each with its venue page; an unread depth zero is dropped', () => {
    const v = view(
      ok({
        open: [
          alarm({ venue: 'aave-v3-usde', severity: 'watch', firedAt: new Date(NOW - 2 * HOUR_MS).toISOString() }),
          alarm({ kind: 'depth_collapse', evidence: { dropPct: -51.2, fromValue: 40.8e6, toValue: 19.6e6 } }),
          // Before the depth guard went live a failed read stored 0: not a drain.
          alarm({ kind: 'depth_collapse', evidence: { toValue: 0, toDate: '2026-09-13T00:00:00Z' }, firedAt: '2026-09-13T00:00:00Z' }),
        ],
      }),
    )
    expect(v.state).toBe('open')
    expect(v.headline).toBe('2 open.')
    expect(v.asOf).toBeNull()
    expect(v.rows.map((r) => [r.label, r.severity, r.finding.lead, r.href])).toEqual([
      ['scrvUSD', 'Alarm', 'Swap pool fell', '/ethereum/venue/scrvUSD'],
      ['Aave v3 USDe', 'Watch', 'Lent out', '/ethereum/venue/aave-v3-usde'],
    ])
    expect(v.rows[0].fired).toBe('11:30 UTC')
  })

  it('stale venue data (the production case): headline withheld, age said once, rows hatched', () => {
    const v = view(ok({ open: [] }), sums(WEEK_OLD))
    expect(v).toEqual({
      state: 'stale',
      hatched: true,
      headline: null,
      withheld: 'Withheld · venue data 7d old',
      asOf: null,
      rows: [],
    })
    expect(view(ok({ open: [alarm({})] }), sums(WEEK_OLD)).rows).toHaveLength(1)
    // Two hourly ticks is the line.
    expect(view(ok({ open: [] }), sums(new Date(NOW - RECORDER_MAX_AGE_MS).toISOString())).state).toBe('none')
  })

  it('no venue reading at all: the age is unknown, so the headline is withheld', () => {
    const v = view(ok({ open: [] }), [FAILED, FAILED, FAILED, FAILED])
    expect(v).toMatchObject({ state: 'stale', withheld: 'Withheld · venue data age unknown' })
    expect(newestReading([FAILED, ok(summary('a', FRESH))])).toBe(Date.parse(FRESH))
  })

  it('loading and error', () => {
    expect(view(PENDING).state).toBe('loading')
    expect(view(ok({ open: [] }), [PENDING, ...sums(FRESH).slice(1)]).state).toBe('loading')
    expect(view(FAILED)).toMatchObject({ state: 'error', hatched: true, withheld: SAFETY_COPY.alarmsUnavailable })
  })
})
