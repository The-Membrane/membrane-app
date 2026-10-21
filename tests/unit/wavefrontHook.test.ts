/**
 * The live data source as the page runs it: the real useWavefrontStream hook (react-dom's
 * client renderer on a stub container — the probe renders nothing), a fake API and a fake
 * clock. Ticks are 10 minutes apart, as the stream writes them: the page reads "Live" between
 * on-time ticks, and "Stale" only when a tick is overdue or the API stops answering. A page
 * in another schema falls back (status 'unavailable', which the page turns into the replay).
 */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  emptyTotals,
  STREAM_SCHEMA,
  type StreamRecord,
  type TickRecord,
} from '@/lib/wavefront/stream'
import {
  useWavefrontStream,
  type WavefrontStream,
} from '@/components/Wavefront/hooks/useWavefrontStream'
import {
  httpPageFetcher,
  LIVE_NO_ANSWER_STALE_S,
  TICK_INTERVAL_S,
  TICK_OVERDUE_S,
  type StreamPage,
} from '@/components/Wavefront/live'
import { kickerText } from '@/components/Wavefront/copy'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const act = (React as unknown as { act: (fn: () => Promise<void>) => Promise<void> }).act

/** Just enough of a DOM element for react-dom to mount a component that renders nothing. */
const container = () => {
  const doc = { nodeType: 9, addEventListener: () => {}, removeEventListener: () => {} }
  return {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    ownerDocument: doc,
    childNodes: [],
    firstChild: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Element
}

const W0 = 1760054400
const T0 = W0 + 100 * TICK_INTERVAL_S // a tick time

const tick = (seq: number, ts: number): TickRecord => ({
  kind: 'tick',
  seq,
  ts,
  minute: (ts - W0) / 60 - 1,
  coverage: { walked: 0, total: 0 },
  totals: emptyTotals(),
})

/** A fake /api/wavefront/stream. */
const api = () => {
  const s = { records: [] as StreamRecord[], down: false, calls: 0 }
  const fetchPage = async (after: number): Promise<StreamPage> => {
    s.calls++
    if (s.down) throw new TypeError('network down')
    return {
      schema: STREAM_SCHEMA,
      after,
      records: s.records.filter((r) => r.seq > after),
      next: null,
    }
  }
  return { s, fetchPage }
}

let root: Root | null = null
const out: { current: WavefrontStream | null } = { current: null }

async function mount(opts: Parameters<typeof useWavefrontStream>[0]) {
  function Probe() {
    out.current = useWavefrontStream(opts)
    return null
  }
  root = createRoot(container())
  await act(async () => {
    root!.render(React.createElement(Probe))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}
/** Move the clock to T0 + s seconds, running every timer (polls, the 15 s clock) on the way. */
async function at(s: number) {
  const ms = (T0 + s) * 1000 - Date.now()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const kicker = () =>
  kickerText({
    mode: out.current!.mode,
    status: out.current!.status,
    frame: out.current!.frame,
    windowRange: out.current!.window,
    updatedAt: out.current!.updatedAt,
    stale: out.current!.stale,
    staleSince: out.current!.staleSince,
    liveUnavailable: false,
  })

beforeEach(() => {
  vi.stubGlobal('window', { event: undefined, HTMLIFrameElement: class {} })
  vi.useFakeTimers()
})
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  out.current = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useWavefrontStream (live): fresh between 10-minute ticks, stale only when late', () => {
  it('reads Live 150 s and 560 s after a tick, and through the next on-time tick', async () => {
    const { s, fetchPage } = api()
    s.records.push(tick(1, T0))
    vi.setSystemTime((T0 + 150) * 1000)
    await mount({ mode: 'live', fetchPage, pollMs: 30_000 })
    expect(out.current!.status).toBe('ready')
    expect(out.current!.stale).toBe(false)
    expect(kicker()).toMatch(/^Live · updated /)

    await at(560)
    expect(out.current!.stale).toBe(false)
    expect(kicker()).toMatch(/^Live · /)

    // the next tick lands on time
    await at(TICK_INTERVAL_S)
    s.records.push(tick(2, T0 + TICK_INTERVAL_S))
    await at(TICK_INTERVAL_S + 150)
    expect(out.current!.stale).toBe(false)
    await at(TICK_INTERVAL_S + 560)
    expect(out.current!.stale).toBe(false)
    expect(s.calls).toBeGreaterThan(20) // it kept polling
  })

  it('reads Stale once the next tick is overdue, though the API still answers', async () => {
    const { s, fetchPage } = api()
    s.records.push(tick(1, T0))
    vi.setSystemTime((T0 + 30) * 1000)
    await mount({ mode: 'live', fetchPage, pollMs: 30_000 })
    await at(TICK_OVERDUE_S - 20)
    expect(out.current!.stale).toBe(false)
    await at(TICK_OVERDUE_S + 30)
    expect(out.current!.stale).toBe(true)
    expect(out.current!.staleSince).toBe(T0)
    expect(kicker()).toBe('Stale since Oct 10 16:40 UTC')
  })

  it('reads Stale when the API stops answering, though the last tick is recent', async () => {
    const { s, fetchPage } = api()
    s.records.push(tick(1, T0))
    vi.setSystemTime((T0 + 10) * 1000)
    await mount({ mode: 'live', fetchPage, pollMs: 30_000 })
    await at(60)
    expect(out.current!.stale).toBe(false)
    s.down = true
    await at(60 + LIVE_NO_ANSWER_STALE_S - 40)
    expect(out.current!.stale).toBe(false)
    await at(60 + LIVE_NO_ANSWER_STALE_S + 30)
    expect(out.current!.status).toBe('ready') // what was folded is kept...
    expect(out.current!.stale).toBe(true) // ...and marked stale
    expect(kicker()).toMatch(/^Stale since /)
    // answering again (with a fresh tick) clears it
    s.down = false
    s.records.push(tick(2, T0 + TICK_INTERVAL_S))
    await at(TICK_INTERVAL_S + 60)
    expect(out.current!.stale).toBe(false)
  })

  it('a page in another schema is not live: the page falls back to the replay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ schema: 1, after: 0, records: [tick(1, T0)], next: null }),
        text: async () => '',
      })),
    )
    vi.setSystemTime((T0 + 10) * 1000)
    await mount({ mode: 'live', fetchPage: httpPageFetcher(), pollMs: 30_000 })
    expect(out.current!.status).toBe('unavailable')
    expect(out.current!.error).toMatch(/schema 1/)
  })
})
