import { describe, expect, it } from 'vitest'

import {
  cardSummary,
  clusterLine,
  currentClusters,
  exitsAsOf,
  gapExposed,
  gapLine,
  gapMark,
  rowHeadline,
  rowLine,
  type Line,
} from '@/lib/curatorFeed/headlines'
import type {
  ClusterView,
  FeedRow,
  OracleGapMarketView,
  OracleGapResponse,
} from '@/lib/curatorFeed/service'
import type { ActionKind } from '@/lib/curatorFeed/types'
import type { I3State } from '@/lib/curatorFeed/oracleGap'

// The compact surfaces' copy: short headlines, no verdict words, numbers from the data.

const KINDS: ActionKind[] = [
  'cap_submit',
  'cap_raise',
  'cap_cut',
  'cap_zero',
  'cap_revoke',
  'removal_submit',
  'removal_revoke',
  'market_removed',
  'market_added',
  'supply_queue_add',
  'supply_queue_remove',
  'timelock_submit',
  'timelock_set',
  'timelock_revoke',
  'curator_set',
  'allocator_set',
  'guardian_submit',
  'guardian_set',
  'guardian_revoke',
  'owner_set',
  'sentinel_set',
  'adapter_add',
  'adapter_remove',
  'v2_submit',
  'v2_revoke',
  'writeoff_submit',
  'writeoff',
  'freeze',
  'unfreeze',
  'pause',
  'unpause',
  'borrow_off',
  'borrow_on',
  'ltv_zero',
  'collateral_params',
]

const NOW = 1_791_950_000
const H = 3600
const BANNED = /\b(safe|safety|odds|ok|good|healthy|risky)\b/i
const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const all = (l: Line | undefined) => (l ? `${l.headline} ${l.detail}` : '')

const row = (over: Partial<FeedRow>): FeedRow =>
  ({
    id: 'tx:1',
    protocol: 'morpho-v1',
    vault: '0x' + '1'.repeat(40),
    kind: 'cap_zero',
    scope: 'market',
    collateral: ['0x' + '2'.repeat(40)],
    block: 1,
    ts: NOW - 2 * 86_400,
    tx: '0x' + 'a'.repeat(64),
    claim: 'measured-change',
    status: 'executed',
    tone: 'grey',
    secondsLeft: 0,
    inCluster: false,
    text: 'Set supply cap to 0 on PT-sUSDD/USDC (91.5% LLTV) (was 10M USDC)',
    vaultName: 'Steakhouse USDC',
    curatorName: 'Steakhouse Financial',
    targetName: 'PT-sUSDD/USDC (91.5% LLTV)',
    collateralSymbols: ['PT-sUSDD'],
    zeroTimelock: [],
    ...over,
  }) as FeedRow

describe('feed rows', () => {
  it('lead with a 2–5 word headline, then the subject', () => {
    expect(rowHeadline(row({}))).toBe('Cap cut to 0: PT-sUSDD')
    expect(rowHeadline(row({ kind: 'writeoff' }))).toBe('Written off: PT-sUSDD')
    expect(rowHeadline(row({ kind: 'supply_queue_remove' }))).toBe('No new deposits: PT-sUSDD')
    expect(rowHeadline(row({ kind: 'freeze', protocol: 'aave-v3' }))).toBe('Aave froze PT-sUSDD')
    expect(rowHeadline(row({ kind: 'timelock_submit', collateralSymbols: [] }))).toBe(
      'Timelock change queued',
    )
    expect(rowHeadline(row({ kind: 'allocator_set', to: 'true' }))).toBe('Allocator added')
    expect(rowHeadline(row({ kind: 'allocator_set', to: 'false' }))).toBe('Allocator removed')
    // Several collaterals: the first, then a count. None: the target.
    expect(rowHeadline(row({ collateralSymbols: ['LBTC', 'WBTC', 'cbBTC'] }))).toBe(
      'Cap cut to 0: LBTC +2',
    )
    expect(rowHeadline(row({ collateralSymbols: ['idle'], targetName: 'idle USDC' }))).toBe(
      'Cap cut to 0: idle USDC',
    )
    for (const kind of KINDS) {
      const h = rowHeadline(row({ kind, collateralSymbols: ['X'] }))
      expect(words(h), `${kind}: ${h}`).toBeGreaterThanOrEqual(2)
      expect(words(h), `${kind}: ${h}`).toBeLessThanOrEqual(5)
      expect(h).not.toMatch(BANNED)
    }
  })

  it('the small print: vault · curator · date · status; ✖ only in a cluster', () => {
    expect(rowLine(row({}))).toEqual({
      alarm: false,
      headline: 'Cap cut to 0: PT-sUSDD',
      detail: `Steakhouse USDC · Steakhouse Financial · ${new Date((NOW - 2 * 86_400) * 1000).toISOString().slice(0, 10)}`,
    })
    const p = rowLine(
      row({
        kind: 'removal_submit',
        status: 'pending',
        tone: 'amber',
        secondsLeft: 2 * 86_400 + 3 * H,
      }),
    )
    expect(p.mark).toBeUndefined()
    expect(p.detail).toMatch(/ · pending · 2d 3h left$/)
    const inCluster = row({ inCluster: true, tone: 'red', curatorName: '0x' + 'b'.repeat(40) })
    const c = rowLine(inCluster, true)
    expect(c).toMatchObject({ mark: '✖', alarm: true })
    expect(c.detail).toContain('0xbbbb…bbbb · ')
    expect(c.detail).toContain('part of an exit cluster')
    // In an older cluster: said in the small print, no ✖.
    expect(rowLine(inCluster, false)).toMatchObject({ alarm: false })
    expect(rowLine(inCluster, false).mark).toBeUndefined()
  })
})

describe('clusters', () => {
  const c = {
    curators: ['k1', 'k2'],
    curatorNames: ['Gauntlet', 'MEV Capital'],
    symbol: 'LBTC',
    tightestHours: 14.6,
    end: NOW,
    text: '2 curators set LBTC caps to 0 or removed LBTC markets within 15h',
  } as unknown as ClusterView

  it('"2 curators left LBTC", the window in the small print; ✖ only when current', () => {
    expect(clusterLine(c, true)).toEqual({
      mark: '✖',
      alarm: true,
      headline: '2 curators left LBTC',
      detail: `within 15h · ${new Date(NOW * 1000).toISOString().slice(0, 10)} · Gauntlet, MEV Capital`,
    })
    expect(clusterLine({ ...c, tightestHours: 0.4 }, true).detail).toMatch(/^within <1h/)
    expect(clusterLine(c, false)).toMatchObject({ alarm: false, headline: '2 curators left LBTC' })
    expect(clusterLine(c, false).mark).toBeUndefined()
  })

  it('current while the last exit is inside the window; newest first', () => {
    const old = { end: NOW - 60 * 86_400 }
    const edge = { end: NOW - 72 * H }
    const late = { end: NOW - 72 * H - 1 }
    const fresh = { end: NOW - H }
    const { current, past } = currentClusters([old, edge, late, fresh], NOW, 72)
    expect(current).toEqual([fresh, edge])
    expect(past).toEqual([late, old])
  })
})

// ── oracle gap ──────────────────────────────────────────────────────────────

const counts = (o: Partial<Record<I3State, number>> = {}): Record<I3State, number> => ({
  fired: 0,
  building: 0,
  below: 0,
  stale: 0,
  unobserved: 0,
  ...o,
})

const gap = (o: {
  measured?: boolean
  stale?: boolean
  runs?: number
  counts?: Partial<Record<I3State, number>>
  curatedFired?: number
  bookFired?: number
  exposedFired?: number
}): OracleGapResponse =>
  ({
    meta: {
      now: NOW,
      measured: o.measured ?? true,
      runs: o.runs ?? 30,
      lastRunTs: o.stale ? NOW - 5 * H : NOW - 600,
      stale: o.stale ?? false,
      staleHours: 3,
      marketSource: 'defillama',
      exposureBlock: 1,
      exposureTs: NOW,
    },
    constants: { gap: 0.02, persistenceHours: 24, persistenceDailyPoints: 2 },
    counts: counts(o.counts),
    curatedUsd: counts({ fired: o.curatedFired ?? 0 }),
    bookUsd: counts({ fired: o.bookFired ?? 0 }),
    exposed: counts({ fired: o.exposedFired ?? 0 }),
    exposedMinUsd: 1,
    markets: [],
    total: 0,
  }) as unknown as OracleGapResponse

describe('the card’s oracle-gap line', () => {
  it('unavailable, not measured, stale: no finding stated', () => {
    expect(gapLine(undefined, false)).toBeUndefined()
    expect(gapLine(undefined, true)).toMatchObject({
      mark: '░',
      headline: 'Oracle gap: unavailable',
    })
    expect(gapLine(gap({ measured: false }), false)).toMatchObject({
      alarm: false,
      headline: 'Oracle gap: not measured yet',
    })
    const s = gapLine(gap({ stale: true, counts: { stale: 3 } }), false)!
    expect(s).toEqual({
      mark: '░',
      alarm: false,
      headline: 'Oracle gap: stale',
      detail: 'last point 5h ago',
    })
  })

  it('none: "none for 24h" once 24 points exist, "none yet" before', () => {
    expect(gapLine(gap({ counts: { below: 280, building: 3 } }), false)).toEqual({
      alarm: false,
      headline: 'Oracle gap: none for 24h',
      detail: 'no oracle ≥ 2% above market for 24 h · 3 markets above 2% for under 24 h',
    })
    expect(gapLine(gap({ runs: 1, counts: { below: 280, building: 11 } }), false)).toEqual({
      alarm: false,
      headline: 'Oracle gap: none yet',
      detail: '1 of 24 hourly points so far · 11 markets above 2% for under 24 h',
    })
  })

  it('fired: ✖ and the $ exposed, book value said', () => {
    expect(
      gapLine(
        gap({
          counts: { fired: 2 },
          curatedFired: 5_000_000,
          bookFired: 1_000_000,
          exposedFired: 1,
        }),
        false,
      ),
    ).toEqual({
      mark: '✖',
      alarm: true,
      headline: 'Oracle gap: 2 markets fired',
      detail: 'oracle ≥ 2% above market for 24 h · $5M (incl. $1M book value) curated supply',
    })
    expect(gapLine(gap({ counts: { fired: 1 } }), false)!.detail).toMatch(/no curated supply$/)
  })
})

const mkt = (i3: Partial<OracleGapMarketView['i3']>, over: Partial<OracleGapMarketView> = {}) =>
  ({
    market: '0x' + '1'.repeat(64),
    marketName: 'wstETH/WETH (94.5% LLTV)',
    curatedUsd: 12_300_000,
    locked: false,
    vaults: [],
    series: [],
    i3: { state: 'below', hoursAboveConsecutive: 0, persistence: 24, ...i3 },
    ...over,
  }) as OracleGapMarketView

describe('the §07 card mark', () => {
  const R = gap({})
  it('the delta is the headline; the mark carries the state', () => {
    expect(
      gapMark(mkt({ state: 'fired', currentGap: 0.031, hoursAboveConsecutive: 30 }), R),
    ).toEqual({
      mark: '✖',
      alarm: true,
      headline: '+3.10%',
      detail: 'fired · 30 h ≥ 2%',
    })
    expect(
      gapMark(mkt({ state: 'building', currentGap: 0.0239, hoursAboveConsecutive: 3 }), R),
    ).toEqual({
      mark: '▲',
      alarm: false,
      headline: '+2.39%',
      detail: '3 of 24 h ≥ 2%',
    })
    expect(gapMark(mkt({ state: 'below', currentGap: -0.004 }), R)).toEqual({
      alarm: false,
      headline: '−0.40%',
      detail: 'below 2%',
    })
  })
  it('stale and not measured: hatched, the figure withheld', () => {
    expect(
      gapMark(
        mkt({ state: 'stale', currentGap: 0.025, lastTs: NOW - 5 * H, hoursAboveConsecutive: 4 }),
        R,
      ),
    ).toEqual({
      mark: '░',
      alarm: false,
      headline: '░',
      detail: 'stale · last point +2.50% · 5h old',
    })
    // The last value is never printed as if it were current.
    expect(
      gapMark(mkt({ state: 'stale', currentGap: 12, lastTs: NOW - 5 * H - 300 }), R).detail,
    ).toMatch(/^stale · last point oracle [\d,.]+× market · 5h 5m old$/)
    expect(gapMark(mkt({ state: 'stale', lastTs: NOW - 2 * H }), R).detail).toBe(
      'stale · last point 2h old',
    )
    expect(gapMark(mkt({ state: 'unobserved' }), R)).toEqual({
      mark: '░',
      alarm: false,
      headline: '░',
      detail: 'not measured',
    })
    expect(
      gapMark(
        mkt(
          { state: 'unobserved' },
          { lastRaw: { ts: NOW, oracleUsd: 1, marketUsd: 1, marketConfidence: 0.85, rawGap: 0.1 } },
        ),
        R,
      ).detail,
    ).toBe('not measured · low price confidence')
  })
  it('$ exposed in small print; book value said', () => {
    expect(gapExposed(mkt({}), 1)).toBe('$12.3M exposed')
    expect(gapExposed(mkt({}, { locked: true, curatedUsd: 787_000_000 }), 1)).toBe(
      '$787M exposed · book value',
    )
    expect(gapExposed(mkt({}, { curatedUsd: undefined }), 1)).toBe('no curated supply')
    expect(gapExposed(mkt({}, { curatedUsd: 0.4 }), 1)).toBe('under $1 curated supply')
  })
})

describe('the exits feed’s staleness', () => {
  it('stale past 3 h (the oracle gap’s rule), not only past the 72 h cluster window', () => {
    expect(exitsAsOf({ now: NOW, toTs: NOW - 2 * H })).toBeUndefined()
    expect(exitsAsOf({ now: NOW, toTs: NOW - 3 * H })).toBeUndefined()
    expect(exitsAsOf({ now: NOW, toTs: NOW - 3 * H - 1 })).toBe(NOW - 3 * H - 1)
    // The reviewer's case: head 48 h old (exits 20 h ago not collected yet).
    expect(exitsAsOf({ now: NOW, toTs: NOW - 48 * H })).toBe(NOW - 48 * H)
    const fresh = gap({ counts: { below: 10 } })
    const s = cardSummary({
      feed: { currentClusters: 0, pending: 0, asOf: exitsAsOf({ now: NOW, toTs: NOW - 48 * H }) },
      feedError: false,
      gap: fresh,
      gapError: false,
    })!
    expect(s.headline).not.toMatch(/No alarm now/)
    expect(s.headline).toMatch(/^Exits as of \d{4}-\d\d-\d\d \d\d:\d\d UTC · no oracle alarm$/)
    expect(s.mark).toBe('░')
  })
})

describe('the card’s top line', () => {
  const fresh = gap({ counts: { below: 10 } })
  it('says whether anything fired', () => {
    expect(cardSummary({ feedError: false, gapError: false })).toBeUndefined()
    expect(
      cardSummary({
        feed: { currentClusters: 1, pending: 0 },
        feedError: false,
        gap: fresh,
        gapError: false,
      }),
    ).toEqual({ mark: '✖', alarm: true, headline: '1 alarm now', detail: '' })
    expect(
      cardSummary({
        feed: { currentClusters: 1, pending: 0 },
        feedError: false,
        gap: gap({ counts: { fired: 2 } }),
        gapError: false,
      })!.headline,
    ).toBe('3 alarms now')
    expect(
      cardSummary({
        feed: { currentClusters: 0, pending: 2 },
        feedError: false,
        gap: fresh,
        gapError: false,
      }),
    ).toEqual({ alarm: false, headline: 'No alarm now · 2 changes queued', detail: '' })
  })
  it('never claims "no alarm" over a missing input', () => {
    const feed = { currentClusters: 0, pending: 0 }
    expect(
      cardSummary({ feed, feedError: false, gap: gap({ stale: true }), gapError: false }),
    ).toEqual({
      mark: '░',
      alarm: false,
      headline: 'No exit alarm · oracle gap stale',
      detail: '',
    })
    expect(cardSummary({ feed, feedError: false, gapError: true })!.headline).toBe(
      'No exit alarm · oracle gap unavailable',
    )
    expect(
      cardSummary({ feed, feedError: false, gap: gap({ measured: false }), gapError: false })!
        .headline,
    ).toBe('No exit alarm · oracle gap not measured')
    expect(cardSummary({ feedError: true, gap: fresh, gapError: false })).toMatchObject({
      mark: '░',
      headline: 'Exits unavailable · no oracle alarm',
    })
    expect(cardSummary({ feedError: true, gapError: true })).toMatchObject({
      mark: '░',
      headline: 'Feed unavailable',
    })
    // A stale exits feed: no "now" about exits.
    expect(
      cardSummary({
        feed: { currentClusters: 0, pending: 0, asOf: NOW - 5 * 86_400 },
        feedError: false,
        gap: fresh,
        gapError: false,
      }),
    ).toEqual({
      mark: '░',
      alarm: false,
      headline: `Exits as of ${new Date((NOW - 5 * 86_400) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC · no oracle alarm`,
      detail: '',
    })
    // A stale gap that had fired is not an alarm now: its finding is withheld.
    expect(
      cardSummary({
        feed,
        feedError: false,
        gap: gap({ stale: true, counts: { fired: 1 } }),
        gapError: false,
      })!.alarm,
    ).toBe(false)
  })
  it('no verdict words anywhere', () => {
    const lines = [
      gapLine(fresh, false),
      gapLine(gap({ counts: { fired: 1 } }), false),
      cardSummary({
        feed: { currentClusters: 0, pending: 0 },
        feedError: false,
        gap: fresh,
        gapError: false,
      }),
    ]
    for (const l of lines) expect(all(l)).not.toMatch(BANNED)
  })
})
