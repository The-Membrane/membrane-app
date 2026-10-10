import { describe, expect, it } from 'vitest'

import {
  alarmConsequence,
  capacityMove,
  consequence,
  fmtDuration,
  isTermsOnlyNotice,
  termsSourceUrl,
  type Entry,
} from '@/components/Carry/venueLogLogic'

const entry = (
  kind: string,
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Entry => ({
  venue: 'sUSDe',
  kind,
  at: '2026-03-18T13:54:47.000Z',
  prev,
  next,
  provenance: 'reconstructed',
})

describe('VenueLog consequence rendering', () => {
  it('shows the venue, dollar delta and measured window for a capacity move', () => {
    const move = capacityMove({
      ...entry('param_changed', { depth_usd: 24_589_947.676515 }, { depth_usd: 30_505_294.031558 }),
      venue: 'scrvUSD',
      provenance: 'observed',
      at: '2026-09-21T21:25:02.474Z',
      since: '2026-09-21T05:15:22.074Z',
    })
    expect(move).toMatchObject({
      venue: 'scrvUSD',
      metric: 'instant swap-out depth',
      change: 'rose $5.92M',
      from: '$24.59M',
      to: '$30.51M',
      window: 'over 16h',
    })
    expect(capacityMove(entry('terms_page_changed', {}, {}))).toBeNull()
  })

  it('renders the Ethena cooldown cut as a shortened cooldown window, warning tone', () => {
    const c = consequence(
      entry('cooldown_duration_changed', { cooldownDuration: 604800 }, { cooldownDuration: 86400 }),
    )
    expect(c.text).toContain('cooldown 7d → 1d')
    expect(c.text).toContain('shortened')
    expect(c.tone).toBe('warning')
  })

  it('renders a lengthened cooldown loudly', () => {
    const c = consequence(
      entry('cooldown_duration_changed', { cooldownDuration: 86400 }, { cooldownDuration: 604800 }),
    )
    expect(c.text).toContain('cooldown 1d → 7d')
    expect(c.text).toContain('LENGTHENED')
  })

  it('renders liquidity shifts with sign and warning only on drops', () => {
    const down = consequence(
      entry('instant_liquidity_shift', { instant_usd: 300_000_000 }, { instant_usd: 200_000_000 }),
    )
    expect(down.text).toContain('$300.00M → $200.00M')
    expect(down.text).toContain('-33%')
    expect(down.tone).toBe('warning')

    const up = consequence(
      entry('instant_liquidity_shift', { instant_usd: 200_000_000 }, { instant_usd: 300_000_000 }),
    )
    expect(up.text).toContain('+50%')
    expect(up.tone).toBe('normal')
  })

  it('names an unknown kind and never dumps JSON', () => {
    const c = consequence(entry('brand_new_kind', { a: 1 }, { a: 2 }))
    expect(c.text).toBe('brand new kind recorded')
    expect(c.text).not.toContain('{')
    expect(c.tone).toBe('normal')
  })

  it('terms_page_changed says the page was edited, never the hash', () => {
    const c = consequence(
      entry(
        'terms_page_changed',
        { content_len: 6229, content_hash: 'aa' },
        { content_len: 6300, content_hash: 'bb' },
      ),
    )
    expect(c.text).toBe(
      'configured official terms-page text changed (+71 chars) — exit impact unclassified; review the source terms',
    )
    expect(c.text).not.toContain('aa')
    expect(c.tone).toBe('normal')
  })

  it('a terms-only gate alarm reports an unclassified text change, not a moved withdrawal gate', () => {
    const c = alarmConsequence({
      ...entry('gate_change', {}, {}),
      provenance: 'alarm',
      severity: 'alarm',
      evidence: {
        count: 1,
        latest: {
          kind: 'terms_page_changed',
          prev: { content_hash: 'aa' },
          next: { content_hash: 'bb' },
        },
      },
    })
    expect(c.text).toContain('configured official terms-page text changed')
    expect(c.text).toContain('exit impact unclassified')
    expect(c.text).not.toMatch(/gate moved|withdrawal gate|aa|bb/)
    expect(c.text).toMatch(/^NOTICE · /)
    expect(c.tone).toBe('notice')
    const closed = alarmConsequence({
      ...entry('gate_change', {}, {}),
      provenance: 'alarm',
      cleared: true,
      evidence: { count: 1, latest: { kind: 'terms_page_changed' } },
    })
    expect(closed.text).toMatch(/^NOTICE RECORD CLOSED · /)
    expect(closed.text).not.toContain('WINDOW ENDED')
  })

  it('renders the separate terms-page notice kind without gate claims or false reversal on expiry', () => {
    const open: Entry = {
      ...entry('terms_page_notice', {}, {}),
      provenance: 'alarm',
      severity: 'notice',
      evidence: { count: 1 },
    }
    expect(isTermsOnlyNotice(open)).toBe(true)
    expect(alarmConsequence(open)).toMatchObject({ tone: 'notice' })
    expect(alarmConsequence(open).text).toMatch(
      /^NOTICE · configured official terms-page text changed/,
    )
    const ended = alarmConsequence({ ...open, cleared: true })
    expect(ended.text).toMatch(/^NOTICE WINDOW ENDED · /)
    expect(ended.text).toContain('recorded 24h detection window')
    expect(ended.text).not.toMatch(/in the last 24h|gate moved|terms reverted/)
  })

  it('links only a structured HTTPS source on a terms event', () => {
    const source = 'https://official.example/terms?section=exit&lang=en'
    expect(termsSourceUrl({ kind: 'terms_page_notice', evidence: { sourceUrl: source } })).toBe(
      source,
    )
    expect(
      termsSourceUrl({
        kind: 'gate_change',
        evidence: { sourceUrl: source, latest: { kind: 'terms_page_changed' } },
      }),
    ).toBe(source)
    expect(
      termsSourceUrl({
        kind: 'gate_change',
        evidence: { sourceUrl: source, latest: { kind: 'cooldown_duration_changed' } },
      }),
    ).toBeNull()
    for (const bad of [
      'http://official.example/terms',
      'javascript:alert(1)',
      'https://u:p@official.example/terms',
      'https://official.example/terms\n',
      '//official.example/terms',
      'not a url',
    ]) {
      expect(termsSourceUrl({ kind: 'terms_page_notice', evidence: { sourceUrl: bad } })).toBeNull()
    }
  })

  it('a mixed alarm retains measured cooldown and instant-liquidity changes even when terms changed last', () => {
    const e: Entry = {
      ...entry('gate_change', {}, {}),
      provenance: 'alarm',
      evidence: {
        count: 3,
        latest: { kind: 'terms_page_changed' },
        events: [
          { kind: 'terms_page_changed' },
          {
            kind: 'instant_liquidity_shift',
            prev: { instant_usd: 3_000_000 },
            next: { instant_usd: 2_000_000 },
          },
          {
            kind: 'cooldown_duration_changed',
            prev: { cooldownDuration: 86_400 },
            next: { cooldownDuration: 604_800 },
          },
        ],
      },
    }
    const c = alarmConsequence(e)
    expect(isTermsOnlyNotice(e)).toBe(false)
    expect(c.text).toContain('cooldown duration changed 1d → 7d')
    expect(c.text).toContain('instant exit capacity shifted $3.00M → $2.00M')
    expect(c.text).toContain('terms-page text also changed (exit impact unclassified)')
    expect(c.tone).toBe('danger')
  })

  it('does not classify a partial multi-event roster as terms-only', () => {
    const e: Entry = {
      ...entry('gate_change', {}, {}),
      provenance: 'alarm',
      evidence: { count: 2, latest: { kind: 'terms_page_changed' } },
    }
    expect(isTermsOnlyNotice(e)).toBe(false)
    const c = alarmConsequence(e)
    expect(c.tone).toBe('danger')
    expect(c.text).toContain('additional event details unavailable')
  })

  it('does not neutralize a legacy alarm with missing or invalid event count', () => {
    for (const count of [undefined, 0, -1, 1.5, 'unknown']) {
      const e: Entry = {
        ...entry('gate_change', {}, {}),
        provenance: 'alarm',
        evidence: { count, latest: { kind: 'terms_page_changed' } },
      }
      expect(isTermsOnlyNotice(e)).toBe(false)
      expect(alarmConsequence(e).tone).toBe('danger')
      expect(alarmConsequence(e).text).toContain('additional event details unavailable')
    }
  })

  it('a measured cooldown alarm retains its timing semantics', () => {
    const c = alarmConsequence({
      ...entry('gate_change', {}, {}),
      provenance: 'alarm',
      severity: 'alarm',
      evidence: {
        count: 1,
        latest: {
          kind: 'cooldown_duration_changed',
          prev: { cooldownDuration: 604800 },
          next: { cooldownDuration: 86400 },
        },
      },
    })
    expect(c.text).toContain('cooldown duration changed 7d → 1d')
    expect(c.text).toContain('review the current exit conditions')
  })

  it('param_changed renders each changed key by name, USD keys as dollars', () => {
    const c = consequence(
      entry('param_changed', { depth_usd: 24589947.6 }, { depth_usd: 30505294.0 }),
    )
    expect(c.text).toBe('instant swap-out depth $24.59M → $30.51M')
    const w = consequence({
      ...entry('param_changed', { depth_usd: 1e6 }, { depth_usd: 2e6 }),
      at: '2026-09-21T06:00:00Z',
      since: '2026-09-21T05:00:00Z',
    })
    expect(w.text).toBe('instant swap-out depth $1.00M → $2.00M over 1h')
    const d = consequence({
      ...entry('param_changed', { depth_usd: 1e6 }, { depth_usd: 2e6 }),
      at: '2026-09-21T06:00:00Z',
      since: '2026-09-15T06:00:00Z',
    })
    expect(d.text).toMatch(/ over 6d$/)
    expect(c.tone).toBe('normal')
    expect(consequence(entry('param_changed', { depth_usd: 30e6 }, { depth_usd: 14e6 })).tone).toBe(
      'warning',
    )
  })

  it('formats durations in the largest clean unit', () => {
    expect(fmtDuration(604800)).toBe('7d')
    expect(fmtDuration(86400)).toBe('1d')
    expect(fmtDuration(7200)).toBe('2h')
    expect(fmtDuration(90)).toBe('90s')
  })
})

describe('legacy flow alarms', () => {
  const alarm = (kind: string, cleared: boolean): Entry => ({
    venue: 'sUSDe',
    kind,
    at: '2026-09-26T00:00:00.000Z',
    prev: null,
    next: null,
    provenance: 'alarm',
    severity: 'alarm',
    cleared,
    evidence: {
      streakDays: 20,
      cumulativeOutflowUsd: 2e6,
      worstDayOutflowUsd: 1e6,
      ratio: 2,
    },
  })

  it.each(['net_outflow_streak', 'headroom_thin'])(
    '%s is retained as an unvalidated historical signal',
    (kind) => {
      for (const cleared of [false, true]) {
        const rendered = alarmConsequence(alarm(kind, cleared))
        expect(rendered.tone).toBe('muted')
        expect(rendered.text).toContain('HISTORICAL')
        expect(rendered.text).toContain('source flow coverage was incomplete')
        expect(rendered.text).not.toMatch(/20d|\$|2\.0×|one bad day|the book is bleeding/)
      }
    },
  )

  it('keeps unrelated measured alarms actionable', () => {
    const rendered = alarmConsequence({
      ...alarm('drawdown_fast', false),
      evidence: { dropPct: 25, fromValue: 2e6, toValue: 1.5e6, metric: 'instant_usd' },
    })
    expect(rendered.tone).toBe('danger')
    expect(rendered.text).toContain('capacity fell 25%')
  })
})
