import { describe, expect, it } from 'vitest'

import { heldVenues, matchAlerts, toRss, type AlarmLike } from '@/components/Radar/alertLogic'

const alarm = (o: Partial<AlarmLike>): AlarmLike => ({
  venue: 'sUSDe',
  kind: 'utilization',
  severity: 'alarm',
  evidence: { utilizationPct: 96.4 },
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
      heldVenues({
        createdAt: '2026-09-01T00:00:00Z',
        entryPositions: null,
        lastScanned: { usdByVenue: { sUSDe: 0 } },
      }),
    ).toEqual([])
  })
})

describe('matchAlerts', () => {
  const since = '2026-09-10T00:00:00Z'
  const alarms = [
    alarm({ venue: 'sUSDe', firedAt: '2026-09-05T00:00:00Z' }), // open, fired BEFORE the watch — still applies
    alarm({
      venue: 'sUSDe',
      kind: 'gate_change',
      firedAt: '2026-09-21T00:00:00Z',
      evidence: { count: 1, latest: { kind: 'cooldown_duration_changed' } },
    }),
    alarm({ venue: 'sUSDS', firedAt: '2026-09-22T00:00:00Z' }), // not held
    alarm({
      venue: 'sUSDe',
      kind: 'drawdown_fast',
      firedAt: '2026-09-11T00:00:00Z',
      clearedAt: '2026-09-12T00:00:00Z',
      evidence: { dropPct: 40, fromValue: 10e6, toValue: 6e6, metric: 'instant_usd' },
    }),
    alarm({
      venue: 'sUSDe',
      kind: 'net_outflow_streak',
      firedAt: '2026-09-01T00:00:00Z',
      clearedAt: '2026-09-02T00:00:00Z',
    }), // cleared before the watch
  ]

  it('routes only held venues; open ones regardless of fire time, newest first', () => {
    const { open } = matchAlerts(['sUSDe'], alarms, since)
    expect(open.map((a) => a.kind)).toEqual(['gate_change', 'utilization'])
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
    expect(open[0].text).toContain('ALARM · cooldown duration changed')
  })

  it('routes terms-page alarms with an unclassified exit impact', () => {
    const { open } = matchAlerts(
      ['sUSDe'],
      [
        alarm({
          kind: 'gate_change',
          evidence: { count: 1, latest: { kind: 'terms_page_changed' } },
        }),
      ],
      since,
    )
    expect(open).toHaveLength(1)
    expect(open[0].text).toContain('configured official terms-page text changed')
    expect(open[0].text).toContain('exit impact unclassified')
    expect(open[0].text).not.toContain('gate moved')
    const rss = toRss({
      address: '0x1234567890abcdef1234567890abcdef12345678',
      radarUrl: 'https://membrane.money/radar',
      feedUrl: 'https://membrane.money/rss',
      open,
      recent: [],
      footer: 'coverage incomplete',
    })
    expect(rss).toContain('official terms-page text notice · recorded')
    expect(rss).not.toContain('gate change')
    expect(rss).not.toContain('Failure-pattern alarms')
  })

  it('labels a closed legacy terms alarm as an old record, not an ended terms window', () => {
    const { recent } = matchAlerts(
      ['sUSDe'],
      [
        alarm({
          kind: 'gate_change',
          clearedAt: '2026-09-22T00:00:00Z',
          evidence: { count: 1, latest: { kind: 'terms_page_changed' } },
        }),
      ],
      since,
    )
    expect(recent[0].text).toMatch(/^NOTICE RECORD CLOSED · /)
    const rss = toRss({
      address: '0x1234567890abcdef1234567890abcdef12345678',
      radarUrl: 'https://membrane.money/radar',
      feedUrl: 'https://membrane.money/rss',
      open: [],
      recent,
      footer: 'coverage incomplete',
    })
    expect(rss).toContain('official terms-page text notice · old record closed')
    expect(rss).not.toContain('official terms-page text notice · window ended')
  })

  it('routes the separate terms-page notice kind with a neutral RSS title', () => {
    const source = 'https://official.example/terms?section=exit&lang=en'
    const { open } = matchAlerts(
      ['sUSDe'],
      [
        alarm({
          kind: 'terms_page_notice',
          severity: 'notice',
          evidence: { count: 1, sourceUrl: source },
        }),
      ],
      since,
    )
    expect(open).toHaveLength(1)
    expect(open[0].text).toMatch(/^NOTICE · /)
    const rss = toRss({
      address: '0x1234567890abcdef1234567890abcdef12345678',
      radarUrl: 'https://membrane.money/radar',
      feedUrl: 'https://membrane.money/rss',
      open,
      recent: [],
      footer: 'coverage incomplete',
    })
    expect(rss).toContain('official terms-page text notice · recorded')
    expect(rss).toContain('<link>https://official.example/terms?section=exit&amp;lang=en</link>')
    expect(rss).not.toContain('gate change')
  })

  it('depth alarms read as sentences with their window, never raw JSON', () => {
    const { open } = matchAlerts(
      ['sUSDS'],
      [
        alarm({
          venue: 'sUSDS',
          kind: 'depth_collapse',
          evidence: {
            metric: 'depth_usd',
            fromValue: 30e6,
            fromDate: '2026-09-06T00:00:00Z',
            toValue: 12e6,
            toDate: '2026-09-13T00:00:00Z',
            dropPct: -60,
          },
        }),
        alarm({
          venue: 'sUSDS',
          kind: 'depth_skew',
          severity: 'watch',
          firedAt: '2026-09-19T00:00:00Z',
          evidence: { skewPct: 84.2 },
        }),
        alarm({
          venue: 'sUSDS',
          kind: 'utilization',
          firedAt: '2026-09-18T00:00:00Z',
          evidence: { utilizationPct: 96.4 },
        }),
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

  it('excludes both suspended flow kinds from open, recent and RSS even when DB rows remain', () => {
    const stale = [
      alarm({ kind: 'headroom_thin', firedAt: '2026-09-20T00:00:00Z' }),
      alarm({
        kind: 'net_outflow_streak',
        firedAt: '2026-09-21T00:00:00Z',
        clearedAt: '2026-09-22T00:00:00Z',
      }),
    ]
    const { open, recent } = matchAlerts(['sUSDe'], stale, since)
    expect({ open, recent }).toEqual({ open: [], recent: [] })
    expect(
      toRss({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        radarUrl: 'https://membrane.money/radar',
        feedUrl: 'https://membrane.money/rss',
        open,
        recent,
        footer: 'flow coverage incomplete',
      }),
    ).not.toContain('<item>')
  })
})

describe('toRss', () => {
  it('emits one item per moment with distinct guids and escaped text', () => {
    const { open, recent } = matchAlerts(
      ['sUSDe'],
      [
        alarm({ firedAt: '2026-09-20T00:00:00Z' }),
        alarm({
          kind: 'drawdown_fast',
          firedAt: '2026-09-11T00:00:00Z',
          clearedAt: '2026-09-12T00:00:00Z',
          evidence: { dropPct: 40, fromValue: 1, toValue: 0.6, metric: 'a<b' },
        }),
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

describe('unread depth zeros (pre-guard failed reads stored as 0)', () => {
  it('drops a pre-guard depth_collapse that ended at $0, keeps a post-guard one', async () => {
    const { isUnreadDepthAlarm } = await import('@/components/Radar/alertLogic')
    const pre = alarm({
      venue: 'sUSDS',
      kind: 'depth_collapse',
      firedAt: '2026-09-13T04:04:43Z',
      clearedAt: '2026-09-13T05:05:12Z',
      evidence: { toValue: 0, toDate: '2026-09-13T04:04:22Z', fromValue: 3.87e9, dropPct: -100 },
    })
    const post = alarm({
      venue: 'sUSDS',
      kind: 'depth_collapse',
      firedAt: '2026-09-26T04:00:00Z',
      evidence: { toValue: 0, toDate: '2026-09-26T03:59:00Z', fromValue: 3.87e9, dropPct: -100 },
    })
    const partial = alarm({
      venue: 'sUSDS',
      kind: 'depth_collapse',
      firedAt: '2026-09-13T04:04:43Z',
      evidence: { toValue: 1.2e9, toDate: '2026-09-13T04:04:22Z' },
    })
    expect(isUnreadDepthAlarm(pre)).toBe(true)
    expect(isUnreadDepthAlarm(post)).toBe(false)
    expect(isUnreadDepthAlarm(partial)).toBe(false)
    const { open, recent } = matchAlerts(['sUSDS'], [pre, post, partial], '2026-09-01T00:00:00Z')
    expect([...open, ...recent].map((a) => a.firedAt)).toEqual([
      '2026-09-26T04:00:00Z',
      '2026-09-13T04:04:43Z',
    ])
  })

  it('scrubs depth_usd from a pre-guard event, drops it when nothing else changed', async () => {
    const { scrubUnreadDepthEvent } = await import('@/components/Radar/alertLogic')
    const only = {
      kind: 'param_changed',
      at: '2026-09-13T04:04:22Z',
      prev: { depth_usd: 3.87e9 },
      next: { depth_usd: 0 },
    }
    const mixed = {
      kind: 'param_changed',
      at: '2026-09-13T04:04:22Z',
      prev: { depth_usd: 3.87e9, total_assets: 1 },
      next: { depth_usd: 0, total_assets: 2 },
    }
    const real = {
      kind: 'param_changed',
      at: '2026-09-26T00:00:00Z',
      prev: { depth_usd: 3.87e9 },
      next: { depth_usd: 0 },
    }
    expect(scrubUnreadDepthEvent(only)).toBeNull()
    expect(scrubUnreadDepthEvent(mixed)).toEqual({
      ...mixed,
      prev: { total_assets: 1 },
      next: { total_assets: 2 },
    })
    expect(scrubUnreadDepthEvent(real)).toBe(real)
  })
})
