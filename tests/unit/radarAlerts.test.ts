import { describe, expect, it } from 'vitest'

import { heldVenues, matchAlerts, toRss, type AlarmLike } from '@/components/Radar/alertLogic'

const alarm = (o: Partial<AlarmLike>): AlarmLike => ({
  venue: 'sUSDe',
  kind: 'headroom_thin',
  severity: 'alarm',
  evidence: { instantUsd: 1_000_000, worstDayOutflowUsd: 900_000, ratio: 1.1 },
  firedAt: '2026-09-20T00:00:00Z',
  clearedAt: null,
  ...o,
})

describe('heldVenues', () => {
  it('prefers the cached current scan and drops dust', () => {
    expect(
      heldVenues({
        createdAt: '2026-09-01T00:00:00Z',
        entryPositions: [{ venue: 'sUSDS', usd: 5000 }],
        lastScanned: { usdByVenue: { sUSDe: 2000, scrvUSD: 0.5 } },
      }),
    ).toEqual(['sUSDe'])
  })

  it('falls back to the entry snapshot before the first refresh', () => {
    expect(
      heldVenues({
        createdAt: '2026-09-01T00:00:00Z',
        entryPositions: [
          { venue: 'sUSDS', usd: 5000 },
          { venue: 'sUSDS', usd: 10 },
          { venue: 'scrvUSD', usd: 0 },
        ],
        lastScanned: null,
      }),
    ).toEqual(['sUSDS'])
  })

  it('an address that exited everything holds nothing', () => {
    expect(
      heldVenues({ createdAt: '2026-09-01T00:00:00Z', entryPositions: null, lastScanned: { usdByVenue: { sUSDe: 0 } } }),
    ).toEqual([])
  })
})

describe('matchAlerts', () => {
  const since = '2026-09-10T00:00:00Z'
  const alarms = [
    alarm({ venue: 'sUSDe', firedAt: '2026-09-05T00:00:00Z' }), // open, fired BEFORE the watch — still applies
    alarm({ venue: 'sUSDe', kind: 'gate_change', firedAt: '2026-09-21T00:00:00Z', evidence: { count: 1, latest: { kind: 'cooldown_duration_changed' } } }),
    alarm({ venue: 'sUSDS', firedAt: '2026-09-22T00:00:00Z' }), // not held
    alarm({ venue: 'sUSDe', kind: 'drawdown_fast', firedAt: '2026-09-11T00:00:00Z', clearedAt: '2026-09-12T00:00:00Z', evidence: { dropPct: 40, fromValue: 10e6, toValue: 6e6, metric: 'instant_usd' } }),
    alarm({ venue: 'sUSDe', kind: 'net_outflow_streak', firedAt: '2026-09-01T00:00:00Z', clearedAt: '2026-09-02T00:00:00Z' }), // cleared before the watch
  ]

  it('routes only held venues; open ones regardless of fire time, newest first', () => {
    const { open } = matchAlerts(['sUSDe'], alarms, since)
    expect(open.map((a) => a.kind)).toEqual(['gate_change', 'headroom_thin'])
    expect(open.every((a) => a.open && a.venue === 'sUSDe')).toBe(true)
  })

  it('recent = cleared during the watch only', () => {
    const { recent } = matchAlerts(['sUSDe'], alarms, since)
    expect(recent.map((a) => a.kind)).toEqual(['drawdown_fast'])
    expect(recent[0].open).toBe(false)
    expect(recent[0].text.startsWith('CLEARED · capacity fell 40%')).toBe(true)
  })

  it('renders the same consequence line the venue log uses', () => {
    const { open } = matchAlerts(['sUSDe'], alarms, since)
    expect(open[0].text).toContain('ALARM · the gate moved — cooldown_duration_changed')
  })

  it('depth alarms read as sentences with their window, never raw JSON', () => {
    const { open } = matchAlerts(
      ['sUSDS'],
      [
        alarm({ venue: 'sUSDS', kind: 'depth_collapse', evidence: { metric: 'depth_usd', fromValue: 30e6, fromDate: '2026-09-06T00:00:00Z', toValue: 12e6, toDate: '2026-09-13T00:00:00Z', dropPct: -60 } }),
        alarm({ venue: 'sUSDS', kind: 'depth_skew', severity: 'watch', firedAt: '2026-09-19T00:00:00Z', evidence: { skewPct: 84.2 } }),
        alarm({ venue: 'sUSDS', kind: 'utilization', firedAt: '2026-09-18T00:00:00Z', evidence: { utilizationPct: 96.4 } }),
      ],
      since,
    )
    const text = open.map((a) => a.text)
    expect(text[0]).toContain('instant swap-out depth fell 60%')
    expect(text[0]).toContain('from 2026-09-06 to 2026-09-13')
    expect(text[1]).toContain('WATCH · the instant-exit pool is 84% one-sided')
    expect(text[2]).toContain('utilization 96.4%')
    expect(text.some((t) => t.includes('{'))).toBe(false)
  })

  it('nothing held ⇒ nothing routed', () => {
    expect(matchAlerts([], alarms, since)).toEqual({ open: [], recent: [] })
  })
})

describe('toRss', () => {
  it('emits one item per moment with distinct guids and escaped text', () => {
    const { open, recent } = matchAlerts(
      ['sUSDe'],
      [
        alarm({ firedAt: '2026-09-20T00:00:00Z' }),
        alarm({ kind: 'drawdown_fast', firedAt: '2026-09-11T00:00:00Z', clearedAt: '2026-09-12T00:00:00Z', evidence: { dropPct: 40, fromValue: 1, toValue: 0.6, metric: 'a<b' } }),
      ],
      '2026-09-10T00:00:00Z',
    )
    const out = toRss({
      address: '0x1234567890abcdef1234567890abcdef12345678',
      radarUrl: 'https://membrane.money/ethereum/radar?address=0x12&x=1',
      feedUrl: 'https://membrane.money/api/radar/alerts/0x12?format=rss',
      open,
      recent,
      footer: 'this alarm cannot yet see: depth-vs-book',
    })
    expect(out.match(/<item>/g)).toHaveLength(2)
    expect(out).toContain(':fired</guid>')
    expect(out).toContain(':cleared</guid>')
    expect(out).toContain('a&lt;b')
    expect(out).toContain('&amp;x=1')
    expect(out).toContain('Data compiled by Membrane')
    // newest moment first: the open alarm (09-20) precedes the clear (09-12)
    expect(out.indexOf('fired</guid>')).toBeLessThan(out.indexOf('cleared</guid>'))
  })
})
