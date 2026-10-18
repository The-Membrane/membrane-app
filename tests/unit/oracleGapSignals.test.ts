import { describe, expect, it } from 'vitest'

import {
  DEPOSITORS_WITHHELD,
  i3RecordLine,
  i3RecordTest,
  marketSignals,
  NOT_YET_TESTED,
  SIGNAL_ACTIONS,
} from '@/components/CuratorFeed/signalsView'
import record from '@/lib/curatorFeed/i3Record.generated.json'
import type { I3Constants, I3Record } from '@/lib/curatorFeed/oracleGap'
import { peerMovesOf, type OracleGapMarketView, type PeerMoves } from '@/lib/curatorFeed/service'
import type { FeedFile } from '@/lib/curatorFeed/store'

// §07's detail view: which signals are on, and where every string comes from.

const REC = record as unknown as I3Record
const C: I3Constants = { gap: 0.02, persistenceHours: 24, persistenceDailyPoints: 2 }
const H = 3600
const NOW = 1_792_000_800
const COLL = '0x' + '3'.repeat(40)
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const MSUSD = '0xab5eb14c09d416f0ac63661e57edb7aecdb9befa'
const NOPEG = '0x' + '9'.repeat(40)

const hourly = (gaps: (number | null)[]) =>
  gaps.map((gap, i) => ({ ts: NOW - (gaps.length - 1 - i) * H, gap }))

const mkt = (o: Partial<OracleGapMarketView> = {}): OracleGapMarketView => ({
  claim: 'possible-leading-signal',
  market: '0x' + 'a'.repeat(64),
  marketName: 'AZND/USDC (86% LLTV)',
  collateral: COLL,
  loan: USDC,
  collateralSymbol: 'AZND',
  loanSymbol: 'USDC',
  oracle: '0x' + '4'.repeat(40),
  locked: false,
  vaults: [],
  i3: { state: 'below', currentGap: 0.001, hoursAboveConsecutive: 0, persistence: 24 },
  series: hourly([0.001]),
  loanSide: { symbol: 'USDC', ref: 'USD', loanUsd: 0.9998, pegUsd: 1, gap: -0.0002 },
  ...o,
})

const peers = (o: Partial<PeerMoves> = {}): PeerMoves => ({
  h24: { count: 0, curators: [] },
  d7: { count: 0, curators: [] },
  feedFromTs: NOW - 90 * 86400,
  feedToTs: NOW - 600,
  ...o,
})

const resp = (pm?: PeerMoves) => ({
  constants: C,
  record: REC,
  meta: { now: NOW },
  peerMoves: pm ? { [COLL]: pm } : {},
})

const byId = (m: OracleGapMarketView, pm?: PeerMoves) => {
  const s = marketSignals(m, resp(pm))
  return { s, row: Object.fromEntries(s.rows.map((r) => [r.id, r])) }
}

describe('the record line comes from the generated T2 record', () => {
  it('fired carriers by lead time, silent incidents, false alarms summed', () => {
    // From i3Record.generated.json: AZND 49.054 d (warned), sdeUSD 6.658 d (under 9 d),
    // Oct 10 2025 silent on every carrier, stETH 2 calm episode starts.
    expect(i3RecordLine(REC)).toBe(
      'Warned AZND 49d ahead · sdeUSD 6.7d (under 9 d) · not Oct 10 · 2 false alarms (stETH)',
    )
    expect(i3RecordTest(REC)).toBe('Q25 T2 · retrospective · FAIL overall, n = 3 incidents')
  })

  it('follows the record, not a constant: a changed record changes the line', () => {
    const r: I3Record = {
      ...REC,
      incidents: REC.incidents.map((x) => ({ ...x, calmEpisodeStarts: 0 })),
      incidentCount: 4,
    }
    expect(i3RecordLine(r)).toMatch(/· 0 false alarms$/)
    expect(i3RecordTest(r)).toMatch(/n = 4 incidents/)
  })
})

describe('which signals are on', () => {
  it('a calm market: nothing on, three counted, the depositor row withheld', () => {
    const { s, row } = byId(mkt(), peers())
    expect(s.on).toBe(0)
    expect(s.of).toBe(3)
    expect(s.headline).toBe('0 of 3 signals on for this market')
    expect(row.oracle.state).toBe('off')
    expect(row.oracle.now).toBe('+0.10%')
    expect(row.peers.state).toBe('off')
    expect(row.peers.now).toBe('none in 24 h')
    expect(row.peg.state).toBe('off')
    expect(row.peg.now).toBe('−0.02%')
  })

  it('oracle fired: on, with its hours, and the record from the data', () => {
    const m = mkt({
      i3: { state: 'fired', currentGap: 0.031, hoursAboveConsecutive: 30, persistence: 24 },
      series: hourly(Array(30).fill(0.031)),
    })
    const { row } = byId(m, peers())
    expect(row.oracle.state).toBe('on')
    expect(row.oracle.now).toBe('+3.10% for 30 h')
    expect(row.oracle.nowSub).toBe(
      '✖ fired · 30 h ≥ 2% above market · fires at ≥ 2% for 24 h · collateral side · loan token at its peg',
    )
    expect(row.oracle.record).toBe(i3RecordLine(REC))
    expect(row.oracle.recordTitle).toBe(REC.test)
  })

  it('below market by the line counts as on (either side)', () => {
    const m = mkt({
      i3: { state: 'below', currentGap: -0.05, hoursAboveConsecutive: 0, persistence: 24 },
      series: hourly([-0.05, -0.05, -0.05]),
    })
    const { row } = byId(m, peers())
    expect(row.oracle.state).toBe('on')
    expect(row.oracle.now).toBe('−5.00% for 3 h')
  })

  it('stale or unobserved oracle: not read, never off', () => {
    const m = mkt({
      i3: {
        state: 'stale',
        currentGap: 0.03,
        hoursAboveConsecutive: 30,
        persistence: 24,
        lastTs: NOW - 5 * H,
      },
    })
    const { s, row } = byId(m, peers())
    expect(row.oracle.state).toBe('unread')
    expect(row.oracle.now).toBe('░ not measured now')
    expect(row.oracle.nowSub).toBe('last point 5h old')
    expect(s.headline).toBe('0 of 3 signals on for this market · 1 not read now')
  })

  it('peer cuts in 24 h: on, count and names from the feed', () => {
    const { s, row } = byId(
      mkt(),
      peers({
        h24: { count: 2, curators: ['Steakhouse', 'Gauntlet'] },
        d7: { count: 3, curators: ['Steakhouse', 'Gauntlet', 'MEV Capital'] },
      }),
    )
    expect(row.peers.state).toBe('on')
    expect(row.peers.name).toBe('Curator cuts on AZND')
    expect(row.peers.now).toBe('2 cuts in 24 h')
    expect(row.peers.nowSub).toBe(
      'Steakhouse, Gauntlet · 7 d: 3 cuts · Steakhouse, Gauntlet, MEV Capital',
    )
    expect(row.peers.record).toBe(NOT_YET_TESTED)
    expect(s.on).toBe(1)
  })

  it('a feed that stops before the last 24 h: not read, with the feed’s own end', () => {
    const { row } = byId(mkt(), peers({ feedToTs: NOW - 5 * 86400 }))
    expect(row.peers.state).toBe('unread')
    expect(row.peers.now).toBe('░ last 24 h not read')
    expect(row.peers.nowSub).toMatch(
      /7 d: none in the part read · feed read to .* \(5d before now\)$/,
    )
  })

  it('a clock before the feed starts (a replay): not read', () => {
    const { row } = byId(mkt(), peers({ feedFromTs: NOW + 86400, feedToTs: NOW + 90 * 86400 }))
    expect(row.peers.state).toBe('unread')
  })

  it('no peer data for the collateral: not read', () => {
    const { row } = byId(mkt())
    expect(row.peers.state).toBe('unread')
    expect(row.peers.now).toBe('░ feed not read')
  })

  it('loan token off its peg (msUSD): on, loan-side gap and both prices', () => {
    const m = mkt({
      loan: MSUSD,
      loanSymbol: 'msUSD',
      loanSide: { symbol: 'msUSD', ref: 'USD', loanUsd: 0.885, pegUsd: 1, gap: -0.115 },
    })
    const { row } = byId(m, peers())
    expect(row.peg.state).toBe('on')
    expect(row.peg.name).toBe('msUSD off its peg')
    expect(row.peg.now).toBe('−11.50%')
    expect(row.peg.nowSub).toBe('msUSD $0.885 vs $1 · DefiLlama spot')
    expect(row.peg.record).toBe(NOT_YET_TESTED)
    // The oracle row says its figure is collateral-side.
    expect(row.oracle.nowSub).toMatch(/collateral side · loan token at its peg$/)
  })

  it('a pegged loan token with no stored reading: not read; no peg on file: does not apply', () => {
    // USDC is in PEGS but this point stored no loan price.
    const unread = byId(mkt({ loanSide: undefined }), peers()).row.peg
    expect(unread.state).toBe('unread')
    const none = byId(mkt({ loan: NOPEG, loanSymbol: 'XYZ', loanSide: undefined }), peers())
    expect(none.row.peg).toMatchObject({ state: 'none', nowSub: 'XYZ has no peg on file' })
    expect(none.s.of).toBe(2)
  })

  it('the depositor forecast is withheld with no number', () => {
    const { row } = byId(mkt(), peers())
    expect(row.depositors.state).toBe('withheld')
    expect(row.depositors.now).toBe(DEPOSITORS_WITHHELD)
    expect(row.depositors.now).not.toMatch(/\$|%|\d+\s?(h|d|M|k)\b/)
  })
})

describe('the actions are design only', () => {
  it('three, each with what it would do and who', () => {
    expect(SIGNAL_ACTIONS.map((a) => a.label)).toEqual([
      'Vote to freeze new borrowing',
      'Lower your cap',
      'Alert me',
    ])
    for (const a of SIGNAL_ACTIONS) expect(a.note.length).toBeGreaterThan(20)
    expect(SIGNAL_ACTIONS.filter((a) => a.id !== 'alert').every((a) => /Who:/.test(a.note))).toBe(
      true,
    )
  })
})

describe('peer moves from the feed', () => {
  const V1 = '0x' + '1'.repeat(40)
  const V2 = '0x' + '2'.repeat(40)
  const T = '0x' + 'b'.repeat(64)
  let n = 0
  const act = (o: Record<string, unknown>) => ({
    id: `0xtx${n++}:0`,
    protocol: 'morpho-v1',
    vault: V1,
    kind: 'cap_cut',
    scope: 'market',
    target: T,
    collateral: [COLL],
    block: 1000 + n,
    ts: NOW - H,
    tx: '0xtx',
    ...o,
  })
  const feed = (actions: unknown[]) =>
    ({
      meta: { fromTs: NOW - 30 * 86400, toTs: NOW - 60 },
      entities: {
        tokens: {},
        markets: {},
        vaults: {
          [V1]: { name: 'Steak USDC', curatorKey: 'steak' },
          [V2]: { name: 'G USDC', curatorKey: 'gaunt' },
        },
        curators: { steak: { name: 'Steakhouse' }, gaunt: { name: 'Gauntlet' } },
        aaveMarkets: {},
      },
      actions,
    }) as unknown as FeedFile

  it('counts cuts in 24 h and 7 d, names the curators, ignores raises and other collaterals', () => {
    const f = feed([
      act({ vault: V1, ts: NOW - 2 * H }),
      act({ vault: V2, kind: 'cap_zero', ts: NOW - 3 * H, target: '0x' + 'c'.repeat(64) }),
      act({ vault: V2, kind: 'market_removed', ts: NOW - 3 * 86400 }),
      act({ vault: V1, kind: 'cap_raise', ts: NOW - H }), // not a cut
      act({ vault: V1, collateral: ['0x' + '5'.repeat(40)], ts: NOW - H }), // other collateral
      act({ vault: V1, ts: NOW - 8 * 86400 }), // older than 7 d
      act({ vault: V1, ts: NOW + H }), // after the clock (a pinned replay)
    ])
    const p = peerMovesOf(f, new Set([COLL]), NOW)[COLL]
    expect(p.h24).toEqual({ count: 2, curators: ['Gauntlet', 'Steakhouse'] })
    expect(p.d7).toEqual({ count: 3, curators: ['Gauntlet', 'Steakhouse'] })
    expect(p.feedFromTs).toBe(NOW - 30 * 86400)
    expect(p.feedToTs).toBe(NOW - 60)
  })

  it('a collateral with no cuts still gets a row (zero, with the feed span)', () => {
    const p = peerMovesOf(feed([]), new Set([COLL]), NOW)[COLL]
    expect(p.h24.count).toBe(0)
    expect(p.d7.count).toBe(0)
  })
})
