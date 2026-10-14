/**
 * The wavefront page's data source (components/Wavefront/model.ts + live.ts, used by
 * hooks/useWavefrontStream.ts): every count and $ total it shows is the stream reducer's fold
 * up to the playhead — equal to `replay()` over the same records and to the tick stamped at
 * that time — however the playhead got there (forward, back, mid-bin); and live polling
 * merges overlapping, repeated or shuffled pages idempotently by seq.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  decodeCompact,
  replay,
  totalsClose,
  type CompactReplay,
  type StreamRecord,
  type TickRecord,
} from '@/lib/wavefront/stream'
import {
  BIN_SECONDS,
  MARK,
  WavefrontTimeline,
  ageBucket,
  reasonPhrase,
} from '@/components/Wavefront/model'
import { pollInto, type StreamPage } from '@/components/Wavefront/live'

const DIR = path.join(__dirname, '../../public/data/oct10-2025')
const compact: CompactReplay = JSON.parse(
  fs.readFileSync(path.join(DIR, 'wavefront-replay.json'), 'utf8'),
)
const summary = JSON.parse(fs.readFileSync(path.join(DIR, 'coverage-summary.json'), 'utf8'))
const records = decodeCompact(compact)
const W = compact.window
const START = W.startTs
const END = W.startTs + W.stepSeconds * W.minutes
const at = (k: number) => START + k * BIN_SECONDS

/** The playhead rule, written independently: ts < T, plus the tick stamped T. */
const included = (T: number) => records.filter((r) => r.ts < T || (r.ts === T && r.kind === 'tick'))
const tickAt = (T: number) =>
  records.find((r): r is TickRecord => r.kind === 'tick' && r.ts === T) ?? null

function freshTimeline() {
  const tl = new WavefrontTimeline()
  tl.append(records)
  return tl
}

describe('wavefront timeline: the reducer fold at the playhead', () => {
  // 00:10, 10:30, 20:00, 21:20 (peak armed), 21:30 (mid-crash), 22:00, 01:00, the end
  const STEPS = [1, 63, 120, 128, 129, 132, 150, 288]

  it('totals at each 10-minute playhead equal replay() and the tick stamped there', () => {
    const tl = freshTimeline()
    for (const k of STEPS) {
      const T = at(k)
      const f = tl.frameAt(T)
      const ref = replay(included(T))
      expect(f.totals, `k=${k}`).toEqual(ref.totals)
      expect(f.coverage).toEqual(ref.coverage)
      expect(f.seq).toBe(ref.seq)
      const tick = tickAt(T)!
      expect(tick, `tick at k=${k}`).not.toBeNull()
      expect(totalsClose(f.totals, tick.totals)).toBe(true)
      expect(f.coverage).toEqual(tick.coverage)
    }
  })

  it('scrubbing back and forth (and mid-bin) gives the same fold as a fresh one', () => {
    const tl = freshTimeline()
    const order = [288, 129, 1, 150, 128, 129, 63, 288, 0]
    for (const k of order) {
      const T = at(k)
      expect(tl.frameAt(T).totals, `k=${k}`).toEqual(freshTimeline().frameAt(T).totals)
    }
    const mid = at(129) + 137 // 21:32:17
    expect(tl.frameAt(mid).totals).toEqual(replay(included(mid)).totals)
    expect(tl.frameAt(mid).coverage).toEqual(replay(included(mid)).coverage)
  })

  it('only walked positions are drawn, on both sides, and the marks match the reducer', () => {
    const tl = freshTimeline()
    for (const k of [100, 128, 129, 140, 288]) {
      const T = at(k)
      const f = tl.frameAt(T)
      const count = (a: Uint8Array, pred: (c: number) => boolean) =>
        a.reduce((n, c) => n + (pred(c) ? 1 : 0), 0)
      const m = f.totals.mem
      // the same positions on both sides: every walked position opened so far, nothing else
      const walkedOpened = included(T).filter((r) => r.kind === 'open' && r.walked).length
      expect(f.n).toBe(walkedOpened)
      expect(f.n).toBe(f.coverage.walked)
      expect(f.real).toHaveLength(f.n)
      expect(f.mem).toHaveLength(f.n)
      expect(count(f.real, (c) => c >= MARK.sold)).toBe(f.n)
      // the reducer's sold = drawn sold + drawn grid-end (a window open at the data end)
      expect(count(f.mem, (c) => c >= MARK.sold)).toBe(m.positionsSold - f.gridEnd)
      expect(count(f.mem, (c) => c === MARK.gridEnd)).toBe(f.gridEnd)
      expect(count(f.mem, (c) => c === MARK.armed)).toBe(m.positionsArmed)
      expect(count(f.mem, (c) => c === MARK.kept)).toBe(m.positionsKept)
      expect(count(f.mem, (c) => c === MARK.pending)).toBe(f.pending)
      // the recorded census decides every position at its open: nothing pending at a tick
      expect(f.pending).toBe(0)
      expect(m.positionsSold + m.positionsArmed + m.positionsKept).toBe(f.coverage.walked)
      expect(f.clusters.reduce((s, c) => s + c.count, 0)).toBe(f.n)
      expect(f.notCompared.count).toBe(f.coverage.total - f.coverage.walked)
      expect(f.notCompared.reasons.reduce((s, r) => s + r.count, 0)).toBe(f.notCompared.count)
    }
  })

  it('the end of the replay is the census (figures read from the served summary)', () => {
    const f = freshTimeline().frameAt(END)
    const walked = summary.totals.walked
    expect(f.coverage).toEqual({ walked: summary.coverage.walked, total: summary.coverage.total })
    expect(f.totals).toEqual(replay(records).totals)
    expect(f.totals.mem.repaidUsd).toBeCloseTo(walked.mem.repaidUsd, 1)
    expect(f.totals.mem.positionsSold).toBe(walked.mem.positionsSold)
    expect(f.totals.mem.positionsKept).toBe(walked.mem.positionsKept)
    expect(f.totals.mem.positionsArmed).toBe(0)
    // grid-end, drawn apart: positions whose FIRST sale is the grid-end sale (from the records)
    const first = new Map<string, string | undefined>()
    for (const r of records)
      if (r.kind === 'mem' && r.event.startsWith('sell') && !first.has(r.pid))
        first.set(r.pid, r.why)
    const gridEndFirst = [...first.values()].filter((w) => w === 'grid-end').length
    expect(gridEndFirst).toBeGreaterThan(0)
    expect(f.gridEnd).toBe(gridEndFirst)
    // ...and none of them before the data end
    expect(freshTimeline().frameAt(END - 600).gridEnd).toBe(0)
    expect(f.notCompared.count).toBe(summary.coverage.notWalked)
    expect(f.notCompared.inStream).toBe(summary.coverage.notWalked)
    // each census reason maps to one short reader-facing phrase
    const expected = new Map<string, number>()
    for (const u of summary.coverage.uncovered ?? []) {
      const why = reasonPhrase(u.reason)
      expected.set(why, (expected.get(why) ?? 0) + 1)
    }
    if (summary.coverage.uncovered?.length === summary.coverage.notWalked) {
      expect(new Map(f.notCompared.reasons.map((r) => [r.reason, r.count]))).toEqual(expected)
    }
  })

  it('bars count drawn positions by their first sale in each 10-minute bin', () => {
    const tl = freshTimeline()
    const T = at(132) // 22:00, the 12 h window covers the crash
    const f = tl.frameAt(T)
    const s = replay(included(T))
    const from = f.bars.fromTs
    let real = 0
    for (const p of s.positions.values()) if (p.open.walked && p.open.ts >= from) real++
    expect(f.bars.real.reduce((a, b) => a + b, 0)).toBe(real)
    expect(f.bars.real).toHaveLength(72)
    expect(f.bars.toTs).toBe(T)
    expect(f.bars.max).toBe(Math.max(...f.bars.real, ...f.bars.mem))
    const firstSales = new Map<string, { ts: number; why?: string }>()
    for (const r of included(T))
      if (r.kind === 'mem' && r.event.startsWith('sell') && !firstSales.has(r.pid))
        firstSales.set(r.pid, { ts: r.ts, why: r.why })
    const inWindow = [...firstSales.values()].filter(
      (x) => x.ts >= from && x.why !== 'grid-end',
    ).length
    expect(f.bars.mem.reduce((a, b) => a + b, 0)).toBe(inWindow)
  })

  it('last-hour count and age buckets', () => {
    const tl = freshTimeline()
    const T = at(129)
    const f = tl.frameAt(T)
    const s = replay(included(T))
    const lastHour = [...s.positions.values()].filter(
      (p) => p.open.walked && p.open.ts > T - 3600,
    ).length
    expect(f.lastHour).toBe(lastHour)
    expect([0, 0.5, 1, 2.9, 3, 12, 13, 72, 73, 500].map(ageBucket)).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 4, 4,
    ])
  })
})

describe('wavefront timeline: live merge is idempotent by seq', () => {
  const reference = freshTimeline().frameAt(END + 1)

  /** A fake endpoint: pages of `size` after `after`, re-sending `overlap` older records. */
  const fakeEndpoint =
    (all: StreamRecord[], size: number, overlap: number, shuffle = false) =>
    async (after: number): Promise<StreamPage> => {
      const i = all.findIndex((r) => r.seq > after)
      if (i === -1) return { schema: 1, after, records: [], next: null }
      const from = Math.max(0, i - overlap)
      const page = all.slice(from, i + size)
      if (shuffle) page.reverse()
      const done = i + size >= all.length
      return { schema: 1, after, records: page, next: done ? null : page[page.length - 1].seq }
    }

  it('overlapping, shuffled pages fold to the same totals as the whole stream', async () => {
    const tl = new WavefrontTimeline()
    const added = await pollInto(tl, fakeEndpoint(records, 1000, 50, true), 1000)
    expect(added).toBe(records.length)
    expect(tl.length).toBe(records.length)
    expect(tl.frameAt(END + 1).totals).toEqual(reference.totals)
  })

  it('a repeated poll adds nothing; a later poll adds only the new records', async () => {
    const tl = new WavefrontTimeline()
    const half = records.slice(0, 9000)
    expect(await pollInto(tl, fakeEndpoint(half, 2000, 0), 1000)).toBe(9000)
    // live-like: fold to the newest record between polls
    const mid = tl.frameAt(half[half.length - 1].ts + 1)
    expect(mid.totals).toEqual(replay(half).totals)
    expect(await pollInto(tl, fakeEndpoint(half, 2000, 0), 1000)).toBe(0)
    expect(await pollInto(tl, fakeEndpoint(records, 2000, 300), 1000)).toBe(records.length - 9000)
    expect(tl.frameAt(END + 1).totals).toEqual(reference.totals)
  })

  it('appending the same batch twice, or duplicates inside a batch, adds each seq once', () => {
    const tl = new WavefrontTimeline()
    const batch = records.slice(0, 500)
    expect(tl.append([...batch, ...batch.slice(100, 200)])).toBe(500)
    expect(tl.append(batch)).toBe(0)
    expect(tl.lastSeq).toBe(500)
  })

  it('refuses a record whose time goes backwards', () => {
    const tl = new WavefrontTimeline()
    tl.append(records.slice(0, 10))
    const bad = { ...records[10], seq: 11, ts: records[0].ts - 1 } as StreamRecord
    expect(() => tl.append([bad])).toThrow(/goes back/)
  })
})
