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
const card = (window: Window = WINDOW) => {
  const out = buildSubject(subject, raw(window), {
    registry,
    eidName: () => 'arbitrum',
    roleName: (h) => h,
    endpoint: '0x1a44076050125825900e736c501f859c50fe728c',
  })
  return buildConfigCard({ subject, state: out.state, changes: [], queue: [] })
}
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
    // (control) the same card already lists the unread blocks as a read gap
    expect(c.readGaps?.some((g) => g.includes('after block 26,129,366 not read'))).toBe(true)
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
    (c.readGaps ?? []).some((g) => g.startsWith('oracle governance events after block'))
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
