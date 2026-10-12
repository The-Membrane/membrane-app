// Config cards — F6 (weETH re-collect, bot data commit d88410c5, head 26,173,524 on Oct 12): the
// Oracles block said "N config changes · last 180 d" from the window's LENGTH alone. The oracle
// collector (scripts/oracle-registry/collect.mjs) last wrote data/oracle-registry/changes.json at
// block 26,129,366 (2026-10-05T23:10Z, endTs 1,791,241,811) and nothing refreshes it, so every
// config card re-collected since read "last 180 d" over a window that ends 6 days before its head.
// The card's read-gap line already named the unread blocks; the heading claimed the opposite. Now
// "last N d" needs a window that ends within a day of the card's head; otherwise the heading says
// where the window ends ("180 d to Oct 5"). Each test failed on the code before the fix unless it
// is marked (control). Synthetic fixtures; the window and head copy state/weeth.json.
//
// R5 (2026-10-12, review of F6: two thresholds — the engine lists an oracle-window read gap 300
// blocks below the head, the heading said "last" up to a day (7,200 blocks) below it, so a window
// 1,000 blocks short read "last 180 d" beside its own read-gap line): ONE threshold, the engine's
// exported ORACLE_WINDOW_GAP_BLOCKS — "last N d" only when the engine lists no oracle-window gap.
// The end date carries its time zone ("180 d to Oct 5 UTC").

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { oracleAside } from '@/components/OracleRegistry/configViewModel'
import type { ConfigCardView } from '@/lib/oracleRegistry/config/apiTypes'
import {
  buildSubject,
  ORACLE_WINDOW_GAP_BLOCKS,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import type { ConfigSubject } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { buildConfigCard } from '@/lib/oracleRegistry/config/view'

// data/oracle-registry/changes.json `window` (collect.mjs:974-975), as state/weeth.json carries it
const WINDOW = { startBlock: 24_833_366, endBlock: 26_129_366, days: 180, endTs: 1_791_241_811 }
// state/weeth.json asOf (bot data commit d88410c5): 2026-10-12T02:53:47Z
const HEAD = { block: 26_173_524, ts: 1_791_773_627 }
const DAY = 86_400

const subject: ConfigSubject = {
  key: 'weeth',
  label: 'weETH',
  oracleAssetKey: 'weeth',
  class: 'lrt',
  contracts: [],
  lzOApps: [],
  ccipPools: [],
  powers: [],
  params: [],
  timelocks: [],
  safes: [],
  govChannels: [],
}
const registry: DvnRegistry = {
  byChain: { 1: {} },
  dead: { 1: [] },
  libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
}
type Window = { startBlock: number; endBlock: number; days: number; endTs?: number }
const raw = (window: Window) =>
  ({
    version: 1,
    subjectKey: 'weeth',
    head: HEAD,
    scan: { from: 1, to: HEAD.block },
    lz: {
      events: [],
      headRoutes: [],
      headDefaults: {},
      remote: [],
      codeProbes: {},
      dvnSigner: [],
      dvnHead: {},
    },
    admin: {
      events: [],
      controllers: {},
      powers: [],
      timelockAdmins: [],
      implHistory: {},
      owners: {},
      delegates: {},
      minDelays: {},
    },
    params: { head: {}, transitions: [] },
    queues: { ops: [], safe: [], safeStatus: [] },
    ccip: { pools: [] },
    oracle: { events: [], window },
    warnings: [],
  }) as RawSubject
const cardOf = (r: RawSubject, s: ConfigSubject = subject) => {
  const out = buildSubject(s, r, {
    registry,
    eidName: () => 'arbitrum',
    roleName: (h) => h,
    endpoint: '0x1a44076050125825900e736c501f859c50fe728c',
  })
  return buildConfigCard({ subject: s, state: out.state, changes: [], queue: [] })
}
const card = (window: Window = WINDOW) => cardOf(raw(window))
const oracle = (o: Partial<ConfigCardView['oracle']> = {}): ConfigCardView['oracle'] => ({
  oracleSlug: 'weeth',
  entries: 3,
  changes: 2,
  collected: true,
  windowDays: 180,
  windowEnd: { block: WINDOW.endBlock, ts: WINDOW.endTs },
  ...o,
})
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('F6: the Oracles heading says where the oracle window ends when it ends before the head', () => {
  it('weETH: the heading names the window end — "180 d to Oct 5 UTC" (was "last 180 d" over a window ending 44,158 blocks, 6 days, below the head; R5: was "to Oct 5", no time zone)', () => {
    const c = card()
    expect(c.asOf).toEqual(HEAD)
    expect(oracleAside(c.oracle, c.asOf)).toBe('0 config changes · 180 d to Oct 5 UTC')
    // (control) the same card already lists the unread blocks as a read gap (S4: in the reader's
    // words, was "oracle governance events after block 26,129,366 not read (…)")
    expect(c.readGaps?.some((g) => g.includes('(after Oct 5 UTC, block 26,129,366)'))).toBe(true)
  })

  it('the card carries where the window ends, block and time (was its length only)', () => {
    expect(card().oracle.windowEnd).toEqual({ block: 26_129_366, ts: 1_791_241_811 })
    // a changes.json written without endTs: the block alone, never an invented time
    const { endTs: _drop, ...noTs } = WINDOW
    void _drop
    expect(card(noTs).oracle.windowEnd).toEqual({ block: 26_129_366, ts: null })
  })

  it('R5: the end TIME no longer decides — 301 blocks below the head is not "last" even an hour behind (was "last 180 d" up to a day); 300 or fewer is (control)', () => {
    const at = (lagBlocks: number, lagSec: number) =>
      oracleAside(
        oracle({ windowEnd: { block: HEAD.block - lagBlocks, ts: HEAD.ts - lagSec } }),
        HEAD,
      )
    expect(at(301, 3_612)).toBe('2 config changes · 180 d to Oct 12 UTC')
    expect(at(300, 3_600)).toBe('2 config changes · last 180 d')
    expect(at(0, 0)).toBe('2 config changes · last 180 d')
    // a window that ends after the card's head covers it (control)
    expect(at(-50, -600)).toBe('2 config changes · last 180 d')
  })

  it('no end time: judged in blocks, and the heading names the end block (was "last 180 d")', () => {
    const at = (endBlock: number) =>
      oracleAside(oracle({ windowEnd: { block: endBlock, ts: null } }), HEAD)
    expect(at(WINDOW.endBlock)).toBe('2 config changes · 180 d to block 26,129,366')
    // R5: the engine's 300 blocks, not a day (was "last 180 d" up to 7,200 blocks below the head)
    expect(at(HEAD.block - 7_200)).toBe('2 config changes · 180 d to block 26,166,324')
    expect(at(HEAD.block - 301)).toBe('2 config changes · 180 d to block 26,173,223')
    expect(at(HEAD.block - 300)).toBe('2 config changes · last 180 d')
  })

  it('a window that ends in an earlier year than the head names its year (was "last 180 d")', () => {
    const lastYear = WINDOW.endTs - 365 * DAY // 2025-10-05
    expect(oracleAside(oracle({ windowEnd: { block: 22_000_000, ts: lastYear } }), HEAD)).toBe(
      '2 config changes · 180 d to Oct 5, 2025 UTC',
    )
  })

  it('an unknown end or head never earns "last" (was "last 180 d")', () => {
    expect(oracleAside(oracle({ windowEnd: null }), HEAD)).toBe('2 config changes · 180 d')
    expect(oracleAside(oracle(), { block: 0, ts: 0 })).toBe(
      '2 config changes · 180 d to Oct 5, 2026 UTC',
    )
  })

  it('(control) not collected, or no window, reads as before', () => {
    expect(
      oracleAside(
        oracle({ oracleSlug: null, collected: false, windowDays: null, windowEnd: null }),
        HEAD,
      ),
    ).toBe('not collected')
    expect(oracleAside(oracle({ windowDays: null, windowEnd: null }), HEAD)).toBe(
      '2 config changes',
    )
  })

  it('the card renders the heading against its own head (was the window length only)', () => {
    expect(src('components/OracleRegistry/ConfigCard.tsx')).toMatch(
      /oracleAside\(view\.oracle, view\.asOf\)/,
    )
  })
})

// R5 (2026-10-12): the heading and the read-gap line judge the same window by the same rule.
describe('R5: one threshold — "last N d" only when the engine lists no oracle-window gap', () => {
  const oracleWindowGap = (c: ReturnType<typeof card>) =>
    (c.readGaps ?? []).some((g) => g.startsWith('oracle governance changes: last '))
  const lagged = (lagBlocks: number) =>
    card({ ...WINDOW, endBlock: HEAD.block - lagBlocks, endTs: HEAD.ts - lagBlocks * 12 })

  it('a window 1,000 blocks (3 h 20 m) below the head: "180 d to Oct 11 UTC" beside its read gap (was "last 180 d")', () => {
    const c = lagged(1_000)
    expect(oracleWindowGap(c)).toBe(true)
    expect(oracleAside(c.oracle, c.asOf)).toBe('0 config changes · 180 d to Oct 11 UTC')
  })

  it('at every lag the heading says "last" exactly when the card lists no oracle-window gap (was "last" up to 7,200 blocks)', () => {
    for (const lag of [-50, 0, 1, 299, 300, 301, 1_000, 7_200, 7_201, 44_158]) {
      const c = lagged(lag)
      expect([lag, oracleAside(c.oracle, c.asOf).includes('· last ')]).toEqual([
        lag,
        !oracleWindowGap(c),
      ])
    }
    // the boundary itself (control: the engine's own rule, unchanged)
    expect(oracleWindowGap(lagged(300))).toBe(false)
    expect(oracleWindowGap(lagged(301))).toBe(true)
  })

  it("the threshold is the engine's, exported once (was a second one-day threshold in the view model)", () => {
    expect(ORACLE_WINDOW_GAP_BLOCKS).toBe(300)
    const vm = src('components/OracleRegistry/configViewModel.ts')
    expect(vm).not.toMatch(/ORACLE_WINDOW_LAG_(SEC|BLOCKS)/)
    expect(vm).toMatch(/ORACLE_WINDOW_GAP_BLOCKS|oracleWindowGap/)
    expect(src('lib/oracleRegistry/config/engine.ts')).not.toMatch(/raw\.head\.block - 300\b/)
  })
})

// S4 (2026-10-12): the oracle-window read gap, engine side. (a) An end block that is not a finite
// number (NaN, null, a string — or no window at all in an events file that WAS read): the
// threshold compare `NaN < head - 300` is false, so the engine listed no gap while the card hedged
// "180 d" over it — an unknown read that was neither listed nor counted. (b) The line spoke the
// collector's language ("oracle governance events after block 26,129,366 not read (the oracle
// collector's window ends 44,158 blocks below head)"); it now says how much is missing and from
// when, in the heading's own date format, and keeps the block for auditors. Each test failed on
// the code before the fix unless it is marked (control).
describe("S4: the oracle-window read gap in the reader's words; an unknown end fails closed", () => {
  const windowGaps = (c: ReturnType<typeof card>) =>
    (c.readGaps ?? []).filter((g) => g.startsWith('oracle governance changes: '))
  const atHead = { ...WINDOW, endBlock: HEAD.block, endTs: HEAD.ts }

  it('weETH: "last 6 days not read (after Oct 5 UTC, block 26,129,366)" (was "oracle governance events after block 26,129,366 not read (the oracle collector\'s window ends 44,158 blocks below head)")', () => {
    const c = card()
    expect(windowGaps(c)).toEqual([
      'oracle governance changes: last 6 days not read (after Oct 5 UTC, block 26,129,366)',
    ])
    // the line and the heading name the same day, in the same words
    expect(oracleAside(c.oracle, c.asOf)).toBe('0 config changes · 180 d to Oct 5 UTC')
  })

  it('the hole is floored: hours under a day, singular units (was blocks below head)', () => {
    const at = (lagBlocks: number, lagSec: number) =>
      windowGaps(card({ ...WINDOW, endBlock: HEAD.block - lagBlocks, endTs: HEAD.ts - lagSec }))
    // 1,000 blocks, 3 h 20 m
    expect(at(1_000, 12_000)).toEqual([
      'oracle governance changes: last 3 hours not read (after Oct 11 UTC, block 26,172,524)',
    ])
    expect(at(301, 3_612)).toEqual([
      'oracle governance changes: last 1 hour not read (after Oct 12 UTC, block 26,173,223)',
    ])
    expect(at(7_300, DAY + 600)).toEqual([
      'oracle governance changes: last 1 day not read (after Oct 11 UTC, block 26,166,224)',
    ])
  })

  it('a window ending in an earlier year names its year (was blocks below head)', () => {
    const c = card({ ...WINDOW, endBlock: 22_000_000, endTs: WINDOW.endTs - 365 * DAY })
    expect(windowGaps(c)).toEqual([
      'oracle governance changes: last 371 days not read (after Oct 5, 2025 UTC, block 22,000,000)',
    ])
  })

  it('no usable end time: the hole in blocks, never an invented time (was "… the oracle collector\'s window ends … below head")', () => {
    const { endTs: _drop, ...noTs } = WINDOW
    void _drop
    const blocks = [
      'oracle governance changes: last 44,158 blocks not read (after block 26,129,366)',
    ]
    expect(windowGaps(card(noTs))).toEqual(blocks)
    // an end time after the head's (clock skew), or under an hour, says blocks too
    expect(windowGaps(card({ ...WINDOW, endTs: HEAD.ts + 60 }))).toEqual(blocks)
    expect(windowGaps(card({ ...WINDOW, endTs: HEAD.ts - 3_000 }))).toEqual(blocks)
    expect(windowGaps(card({ ...WINDOW, endTs: NaN }))).toEqual(blocks)
  })

  it('(a) an end block that is not a finite number is a listed, counted read gap (was none: the card hedged "180 d" over a gap it never listed)', () => {
    const base = card(atHead).counts.readGaps ?? 0
    for (const endBlock of [NaN, undefined, null, '26129366', Infinity]) {
      const c = card({ ...WINDOW, endBlock } as unknown as Window)
      expect([String(endBlock), windowGaps(c)]).toEqual([
        String(endBlock),
        ['oracle governance changes: window end not read'],
      ])
      expect([String(endBlock), c.counts.readGaps]).toEqual([String(endBlock), base + 1])
      // (control) the heading's hedge, unchanged
      expect(oracleAside(c.oracle, c.asOf)).toBe('0 config changes · 180 d')
    }
  })

  it('(a) an events file read with no window at all is a listed, counted read gap (was none)', () => {
    const c = cardOf({ ...raw(WINDOW), oracle: { events: [] } })
    expect(windowGaps(c)).toEqual(['oracle governance changes: window end not read'])
    expect(c.counts.readGaps).toBe((card(atHead).counts.readGaps ?? 0) + 1)
  })

  it('(control) a window that reaches the head lists no oracle-window line', () => {
    expect(windowGaps(card(atHead))).toEqual([])
    expect(
      windowGaps(card({ ...WINDOW, endBlock: HEAD.block - ORACLE_WINDOW_GAP_BLOCKS })),
    ).toEqual([])
  })

  it('(control) changes.json not read: its own line only, never a second window line', () => {
    const c = cardOf({ ...raw(WINDOW), oracle: { events: [], unread: 'changes.json missing' } })
    expect(c.readGaps?.filter((g) => g.startsWith('oracle governance'))).toEqual([
      'oracle governance events not read (changes.json missing)',
    ])
  })

  it('(control) a subject outside the oracle catalog lists no oracle line, whatever the window', () => {
    const s = { ...subject, oracleAssetKey: null }
    for (const w of [WINDOW, { ...WINDOW, endBlock: NaN }])
      expect((cardOf(raw(w), s).readGaps ?? []).filter((g) => g.startsWith('oracle'))).toEqual([])
  })
})
