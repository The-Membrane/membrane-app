/**
 * Wavefront states and copy that the Oct 10-11 replay cannot exercise on its own:
 *   - the reducer's `pending` state (a walked position the engine has not decided on yet —
 *     live only) is neither sold, armed nor kept, and is drawn neutral;
 *   - live (stream) mode keeps the reducer's state and the per-position index, not records;
 *   - "Live" appears only when live, fresh and on every position; stale withholds the
 *     headline; a failed live request says the replay is shown;
 *   - exact boundaries of the age buckets and the last-hour window (mutation killers);
 *   - sold marks never fade under 3:1 against the page, in either theme (styles/themes.css).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { aavePid } from '@/lib/wavefront/pid'
import {
  applyRecord,
  createReplayState,
  decodeCompact,
  type CompactReplay,
  type MemRecord,
  type OpenRecord,
  type RealRecord,
  type StreamRecord,
  type TickRecord,
} from '@/lib/wavefront/stream'
import { BIN_SECONDS, MARK, WavefrontTimeline } from '@/components/Wavefront/model'
import {
  coverageText,
  headlineCount,
  kickerText,
  memStates,
  type KickerInput,
} from '@/components/Wavefront/copy'
import { fmtUsd } from '@/components/Wavefront/format'
import {
  ageAlphas,
  blend,
  contrastRatio,
  MIN_MARK_CONTRAST,
  parseColor,
} from '@/components/Wavefront/marks'

const BIN0 = 2_933_600 // a 10-minute bin
const T0 = BIN0 * BIN_SECONDS + 120 // 2 minutes into it
const pid = (n: number) =>
  aavePid('mainnet', '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', `0x${n}`)

const open = (seq: number, n: number, ts = T0): OpenRecord => ({
  kind: 'open',
  seq,
  pid: pid(n),
  protocol: 'aave-v3',
  chain: 'mainnet',
  block: 1,
  ts,
  legs: [{ symbol: 'WETH', usd: 1000 }],
  debtLegs: [{ symbol: 'USDC', usd: 800 }],
  debtUsd: 800,
  collUsd: 1000,
  line: 0.79,
  ltv0: 0.8,
  delayClass: 'delayed',
  cluster: 'ETH',
  walked: true,
  t0: { block: 1, ts, minute: 1 },
})
const real = (seq: number, n: number, ts = T0): RealRecord => ({
  kind: 'real',
  seq,
  pid: pid(n),
  ts,
  block: 1,
  tx: '0x',
  logIndex: 0,
  repaidUsd: 100,
  seizedUsd: 105,
})
const mem = (seq: number, n: number, event: MemRecord['event'], ts = T0): MemRecord => ({
  kind: 'mem',
  seq,
  pid: pid(n),
  ts,
  minute: 1,
  event,
  ...(event === 'sell' ? { why: 'band' as const } : {}),
  repaidUsd: event === 'sell' ? 50 : 0,
  soldUsd: event === 'sell' ? 50 : 0,
  ltv: 0.81,
})

describe('reducer: pending (walked, no decision yet)', () => {
  it('is its own state: not kept, and it leaves the Totals (and so the ticks) alone', () => {
    const s = createReplayState()
    applyRecord(s, open(1, 1))
    expect(s.pending).toBe(1)
    expect(s.totals.mem).toMatchObject({ positionsKept: 0, positionsArmed: 0, positionsSold: 0 })
    applyRecord(s, mem(2, 1, 'arm'))
    expect(s.pending).toBe(0)
    expect(s.totals.mem.positionsArmed).toBe(1)
    applyRecord(s, mem(3, 1, 'save'))
    expect(s.totals.mem).toMatchObject({ positionsKept: 1, positionsArmed: 0 })
    applyRecord(s, open(4, 2))
    applyRecord(s, mem(5, 2, 'sell'))
    expect(s.pending).toBe(0)
    expect(s.totals.mem.positionsSold).toBe(1)
    // sold + armed + kept + pending == walked
    const m = s.totals.mem
    expect(m.positionsSold + m.positionsArmed + m.positionsKept + s.pending).toBe(s.coverage.walked)
    expect(Object.keys(s.totals.mem)).not.toContain('positionsPending')
  })

  it('is drawn neutral, and counted apart from kept', () => {
    const tl = new WavefrontTimeline()
    tl.append([open(1, 1), real(2, 1), open(3, 2), real(4, 2), mem(5, 2, 'arm')])
    const f = tl.frameAt(T0 + 1)
    expect(f.pending).toBe(1)
    expect(Array.from(f.mem)).toEqual([MARK.pending, MARK.armed])
    expect(memStates(f).map((d) => [d.kind, d.count])).toEqual([
      ['sold', 0],
      ['armed', 1],
      ['kept', 0],
      ['pending', 1],
    ])
  })
})

describe('frames: exact boundaries', () => {
  // one position opened at T0 (in bin BIN0)
  const tl = new WavefrontTimeline()
  tl.append([open(1, 1), real(2, 1), mem(3, 1, 'sell')])

  it('age buckets: same bin, then 1, 3, 13 and 73 bins later', () => {
    const at = (bins: number) => tl.frameAt((BIN0 + 1 + bins) * BIN_SECONDS).real[0] - MARK.sold
    // the playhead at the END of bin BIN0 + bins sees the sale `bins` bins old
    expect([0, 1, 2, 3, 12, 13, 72, 73].map(at)).toEqual([0, 1, 1, 2, 2, 3, 3, 4])
    expect(tl.frameAt(T0 + 1).real[0]).toBe(MARK.sold)
    expect(tl.frameAt((BIN0 + 1) * BIN_SECONDS + 1).real[0]).toBe(MARK.sold + 1)
  })

  it('last hour: open ts strictly after t − 3600', () => {
    expect(tl.frameAt(T0 + 3600).lastHour).toBe(0)
    expect(tl.frameAt(T0 + 3599).lastHour).toBe(1)
    expect(tl.frameAt(T0 + 1).lastHour).toBe(1)
  })

  it('an empty frame shows no scale ("max 0" is not "max 1")', () => {
    const f = new WavefrontTimeline().frameAt(T0)
    expect(f.n).toBe(0)
    expect(f.bars.max).toBe(0)
  })
})

describe('live (stream mode): memory is the reducer state, not the records', () => {
  const compact: CompactReplay = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../../public/data/oct10-2025/wavefront-replay.json'),
      'utf8',
    ),
  )
  const records = decodeCompact(compact)
  const end = compact.window.startTs + compact.window.stepSeconds * compact.window.minutes

  it('folds every page as it arrives, drops the records, and ends at the same frame', () => {
    const live = new WavefrontTimeline({ retain: false })
    for (let i = 0; i < records.length; i += 1500) live.append(records.slice(i, i + 1500))
    const replayTl = new WavefrontTimeline()
    replayTl.append(records)
    const a = live.frameAt(end + 1)
    const b = replayTl.frameAt(end + 1)
    expect(a.totals).toEqual(b.totals)
    expect(Array.from(a.mem)).toEqual(Array.from(b.mem))
    expect(live.length).toBe(records.length)
    expect((live as unknown as { recs: StreamRecord[] }).recs).toHaveLength(0)
    const lastTick = [...records].reverse().find((r): r is TickRecord => r.kind === 'tick')!
    expect(live.lastTickTs).toBe(lastTick.ts)
  })

  it('refuses a record the reducer refuses, without indexing it', () => {
    const live = new WavefrontTimeline({ retain: false })
    live.append([open(1, 1)])
    expect(() => live.append([open(2, 1)])).toThrow(/opened twice/)
    expect(live.frameAt(T0 + 1).n).toBe(1)
  })
})

describe('copy: what the kicker and headline may say', () => {
  const complete = { coverage: { walked: 10, total: 10 } }
  const partial = { coverage: { walked: 9, total: 10 } }
  const base: KickerInput = {
    mode: 'live',
    status: 'ready',
    frame: complete,
    windowRange: null,
    updatedAt: 1760131800,
    stale: false,
    staleSince: null,
    liveUnavailable: false,
  }

  it('"Live" only when live, fresh and every position simulated', () => {
    expect(kickerText(base)).toBe('Live · updated Oct 10 21:30 UTC')
    expect(kickerText({ ...base, frame: partial })).toBe('Streaming · updated Oct 10 21:30 UTC')
    expect(kickerText({ ...base, stale: true, staleSince: 1760131200 })).toBe(
      'Stale since Oct 10 21:20 UTC',
    )
    for (const k of [
      kickerText({ ...base, frame: partial }),
      kickerText({ ...base, stale: true, staleSince: 1760131200 }),
      kickerText({
        ...base,
        mode: 'replay',
        windowRange: { startTs: 1760054400, endTs: 1760227200 },
      }),
    ])
      expect(k).not.toMatch(/^Live/)
  })

  it('a failed live request says the replay is shown', () => {
    const replay: KickerInput = {
      ...base,
      mode: 'replay',
      windowRange: { startTs: 1760054400, endTs: 1760227200 },
    }
    expect(kickerText(replay)).toBe('Replay · Oct 10–11, 2025')
    expect(kickerText({ ...replay, liveUnavailable: true })).toBe(
      'Live unavailable — showing the Oct 10–11, 2025 replay',
    )
  })

  it('stale withholds the headline number; coverage says n of N once', () => {
    expect(headlineCount(complete, false)).toBe('10')
    expect(headlineCount(complete, true)).toBe('—')
    expect(coverageText(complete)).toBe('Same positions on both sides (100%)')
    expect(coverageText(partial)).toBe('Same 9 positions on both sides (90%)')
  })

  it('$ to two significant figures', () => {
    expect([0, 840, 4_549, 186_004_821, 157_400_000, 1_234_567, 999_500].map(fmtUsd)).toEqual([
      '$0',
      '$840',
      '$4.5K',
      '$190M',
      '$160M',
      '$1.2M',
      '$1M',
    ])
  })
})

describe('contrast: sold marks never fade under 3:1, in either theme', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/themes.css'), 'utf8')
  const dark = css.slice(css.indexOf(':root,'), css.indexOf(":root[data-membrane-theme='light'] {"))
  const light = css.slice(css.indexOf(":root[data-membrane-theme='light'] {"))
  const token = (block: string, name: string) =>
    new RegExp(`--m-${name}:\\s*([^;]+);`).exec(block)![1].trim()

  for (const [theme, block] of [
    ['dark', dark],
    ['light', light],
  ] as const) {
    it(`${theme}`, () => {
      const bg = parseColor(token(block, 'bg-primary'))!
      const danger = token(block, 'danger')
      const alphas = ageAlphas(danger, token(block, 'bg-primary'))
      expect(alphas[0]).toBe(1)
      expect(alphas[alphas.length - 1]).toBeLessThan(1) // there is still a recency fade
      for (const a of alphas) {
        expect(contrastRatio(blend(parseColor(danger)!, bg, a), bg)).toBeGreaterThanOrEqual(
          MIN_MARK_CONTRAST,
        )
      }
      for (const name of ['warning', 'success', 'text-secondary']) {
        expect(contrastRatio(parseColor(token(block, name))!, bg)).toBeGreaterThanOrEqual(
          MIN_MARK_CONTRAST,
        )
      }
    })
  }
})
