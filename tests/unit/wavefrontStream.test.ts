/**
 * The wavefront stream, schema v1 (lib/wavefront/stream.ts): both file forms round-trip, and
 * the ONE reducer's invariants hold over the whole served Oct 10-11 replay
 * (public/data/oct10-2025/wavefront-replay.json) — every position opened exactly once and
 * before anything else about it, ticks equal to the fold, the sold / armed / kept partition,
 * totals equal to the sum over positions, and the served summary equal to the fold.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  applyRecord,
  createReplayState,
  decodeCompact,
  decodeJsonl,
  encodeCompact,
  encodeJsonl,
  replay,
  roundRecord,
  type CompactReplay,
  type MemRecord,
  type OpenRecord,
  type StreamRecord,
  type StreamWindow,
} from '@/lib/wavefront/stream'

const DIR = path.join(__dirname, '../../public/data/oct10-2025')
const compact: CompactReplay = JSON.parse(
  fs.readFileSync(path.join(DIR, 'wavefront-replay.json'), 'utf8'),
)
const summary = JSON.parse(fs.readFileSync(path.join(DIR, 'coverage-summary.json'), 'utf8'))
const records = decodeCompact(compact)
const W = compact.window

describe('wavefront stream: file forms', () => {
  it('compact -> records -> compact is the identity', () => {
    expect(encodeCompact(W, records)).toEqual(compact)
  })

  it('JSONL round-trips the records exactly', () => {
    const text = encodeJsonl(W, records)
    const back = decodeJsonl(text)
    expect(back.header.schema).toBe(1)
    expect(back.header.window).toEqual(W)
    expect(back.records).toEqual(records)
  })

  it('every record is already rounded the way the stream stores it', () => {
    for (const r of records) expect(roundRecord(r)).toEqual(r)
  })

  it('the served replay is under 2 MB', () => {
    expect(fs.statSync(path.join(DIR, 'wavefront-replay.json')).size).toBeLessThan(2_000_000)
  })
})

describe('wavefront stream: reducer invariants over the whole Oct 10-11 replay', () => {
  const state = createReplayState()
  const opened = new Map<string, number>()
  const walked = new Set<string>()
  let lastTs = -Infinity
  let lastSeq = 0
  let partitionChecks = 0
  for (const r of records) {
    // seq is 1, 2, 3, … and ts never goes back
    expect(r.seq).toBe(lastSeq + 1)
    expect(r.ts).toBeGreaterThanOrEqual(lastTs)
    lastSeq = r.seq
    lastTs = r.ts
    if (r.kind === 'open') {
      opened.set(r.pid, (opened.get(r.pid) ?? 0) + 1)
      if (r.walked) walked.add(r.pid)
    } else if (r.kind === 'real' || r.kind === 'mem') {
      expect(opened.has(r.pid), `${r.kind} before open: ${r.pid}`).toBe(true)
      if (r.kind === 'mem') expect(walked.has(r.pid)).toBe(true)
    }
    applyRecord(state, r) // verifies every tick against the fold
    if (r.kind === 'tick') {
      const m = r.totals.mem
      expect(m.positionsSold + m.positionsArmed + m.positionsKept).toBe(r.coverage.walked)
      expect(r.coverage.walked).toBeLessThanOrEqual(r.coverage.total)
      partitionChecks++
    }
  }

  it('opens every position exactly once', () => {
    expect([...opened.values()].every((n) => n === 1)).toBe(true)
    expect(opened.size).toBe(state.positions.size)
    expect(state.coverage.total).toBe(3163)
  })

  it('ticks every 10 minutes across the whole window, the last at the window end', () => {
    expect(state.ticks).toBe(W.minutes / 10)
    expect(partitionChecks).toBe(state.ticks)
    const last = records[records.length - 1]
    expect(last.kind).toBe('tick')
    expect(last.ts).toBe(W.startTs + W.stepSeconds * W.minutes)
  })

  it('coverage partitions the total: walked + not walked, and sold + armed + kept = walked', () => {
    const notWalked = [...state.positions.values()].filter((p) => !p.open.walked)
    expect(state.coverage.walked + notWalked.length).toBe(state.coverage.total)
    for (const p of notWalked) expect(p.open.reason).toBeTruthy()
    const T = state.totals.mem
    expect(T.positionsSold + T.positionsArmed + T.positionsKept).toBe(state.coverage.walked)
    // the grid-end sale resolves every running delay
    expect(T.positionsArmed).toBe(0)
  })

  it('totals equal the sum over positions, on both sides', () => {
    const ps = [...state.positions.values()]
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.02)
    near(
      state.totals.real.repaidUsd,
      ps.reduce((a, p) => a + p.real.repaidUsd, 0),
    )
    near(
      state.totals.real.soldUsd,
      ps.reduce((a, p) => a + p.real.seizedUsd, 0),
    )
    near(
      state.totals.real.badDebtUsd,
      ps.reduce((a, p) => a + p.real.badDebtUsd, 0),
    )
    near(
      state.totals.mem.repaidUsd,
      ps.reduce((a, p) => a + p.mem.repaidUsd, 0),
    )
    near(
      state.totals.mem.soldUsd,
      ps.reduce((a, p) => a + p.mem.soldUsd, 0),
    )
    expect(state.totals.real.positions).toBe(ps.filter((p) => p.real.events > 0).length)
    expect(state.totals.mem.positionsSold).toBe(ps.filter((p) => p.mem.sales > 0).length)
    // every position has its real liquidations in the stream
    expect(ps.every((p) => p.real.events > 0)).toBe(true)
  })

  it('the served summary is the fold', () => {
    expect(summary.coverage.total).toBe(state.coverage.total)
    expect(summary.coverage.walked).toBe(state.coverage.walked)
    expect(summary.coverage.uncovered.length).toBe(state.coverage.total - state.coverage.walked)
    const walkedPs = [...state.positions.values()].filter((p) => p.open.walked)
    const realWalked = walkedPs.reduce((a, p) => a + p.real.repaidUsd, 0)
    expect(Math.abs(summary.totals.walked.real.repaidUsd - realWalked)).toBeLessThan(0.05)
    expect(Math.abs(summary.totals.walked.mem.repaidUsd - state.totals.mem.repaidUsd)).toBeLessThan(
      0.05,
    )
    expect(summary.totals.walked.mem.positionsSold).toBe(state.totals.mem.positionsSold)
  })

  it('a split position carries two halves whose shares sum to 1', () => {
    const splits = [...state.positions.values()].filter((p) => p.open.subs)
    expect(splits.length).toBeGreaterThan(100)
    for (const p of splits) {
      expect(p.open.delayClass).toBe('mixed')
      expect(p.open.subs!.map((s) => s.sub)).toEqual([0, 1])
      expect(Math.abs(p.open.subs!.reduce((a, s) => a + s.share, 0) - 1)).toBeLessThan(1e-5)
    }
  })
})

describe('wavefront stream: the reducer refuses what the schema forbids', () => {
  const W0: StreamWindow = { startTs: 1000, stepSeconds: 60, minutes: 20 }
  const open = (seq: number, pid: string, walked = true): OpenRecord => ({
    kind: 'open',
    seq,
    pid,
    protocol: 'aave-v3',
    chain: 'mainnet',
    block: 1,
    ts: 1000,
    legs: [{ symbol: 'WETH', usd: 100 }],
    debtLegs: [{ symbol: 'USDC', usd: 85 }],
    debtUsd: 85,
    collUsd: 100,
    line: 0.83,
    ltv0: 0.85,
    delayClass: 'delayed',
    cluster: 'ETH',
    walked,
    ...(walked ? { t0: { block: 1, ts: 1000, minute: 0 } } : { reason: 'test' }),
  })
  const mem = (seq: number, pid: string, event: MemRecord['event']): MemRecord => ({
    kind: 'mem',
    seq,
    pid,
    ts: 1000,
    minute: 0,
    event,
    repaidUsd: event.startsWith('sell') ? 10 : 0,
    soldUsd: event.startsWith('sell') ? 10 : 0,
    ltv: 0.85,
  })
  const run = (rs: StreamRecord[]) => () => replay(rs)

  it('accepts a minimal valid stream and moves a position kept -> armed -> sold', () => {
    const s = replay([open(1, 'aave-v3:mainnet:0xa'), mem(2, 'aave-v3:mainnet:0xa', 'arm')])
    expect(s.totals.mem.positionsArmed).toBe(1)
    applyRecord(s, mem(3, 'aave-v3:mainnet:0xa', 'sell'))
    expect(s.totals.mem.positionsSold).toBe(1)
    expect(s.totals.mem.positionsArmed).toBe(0)
    expect(s.totals.mem.repaidUsd).toBe(10)
  })
  it('a second open of the same pid', () => {
    expect(run([open(1, 'aave-v3:mainnet:0xa'), open(2, 'aave-v3:mainnet:0xa')])).toThrow(
      /opened twice/,
    )
  })
  it('a record before its open', () => {
    expect(run([mem(1, 'aave-v3:mainnet:0xa', 'arm')])).toThrow(/before open/)
  })
  it('a mem record for a position not walked', () => {
    expect(
      run([open(1, 'aave-v3:mainnet:0xa', false), mem(2, 'aave-v3:mainnet:0xa', 'arm')]),
    ).toThrow(/not walked/)
  })
  it('a seq that does not increase', () => {
    expect(run([open(2, 'aave-v3:mainnet:0xa'), open(2, 'aave-v3:mainnet:0xb')])).toThrow(/seq/)
  })
  it('a tick that is not the fold', () => {
    const t: StreamRecord = {
      kind: 'tick',
      seq: 2,
      ts: 1600,
      minute: 9,
      coverage: { walked: 5, total: 5 },
      totals: replay([]).totals,
    }
    expect(run([open(1, 'aave-v3:mainnet:0xa'), t])).toThrow(/coverage/)
    void W0
  })
})
