/**
 * Wiring: the page rendered server-side (react-dom/server) on a small stream, asserting which
 * reducer figure feeds which visible string — headline = coverage.total, Real "sold" =
 * coverage.walked, Membrane states = the reducer's partition with the grid-end positions drawn
 * apart, $ = totals.real / totals.mem repaidUsd at two significant figures — and that a failed
 * live request says the replay is shown, while stale live data withholds the headline.
 */
import React from 'react'
import { renderToString } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'
import { describe, expect, it } from 'vitest'

import theme from '@/theme'
import { aavePid } from '@/lib/wavefront/pid'
import type { MemRecord, OpenRecord, RealRecord, StreamRecord } from '@/lib/wavefront/stream'
import { WavefrontTimeline } from '@/components/Wavefront/model'
import { WavefrontView, type WavefrontViewProps } from '@/components/Wavefront/Wavefront'

const START = 1760054400
const END = START + 2880 * 60
const T0 = START + 1280 * 60
const pid = (n: number) =>
  aavePid('mainnet', '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', `0x${n}`)

let seq = 0
const open = (n: number, cluster: string, walked = true): OpenRecord => ({
  kind: 'open',
  seq: ++seq,
  pid: pid(n),
  protocol: 'aave-v3',
  chain: 'mainnet',
  block: 1,
  ts: T0,
  legs: [{ symbol: 'WETH', usd: 1000 }],
  debtLegs: [{ symbol: 'USDC', usd: 800 }],
  debtUsd: 800,
  collUsd: 1000,
  line: 0.79,
  ltv0: 0.8,
  delayClass: 'delayed',
  cluster,
  walked,
  ...(walked ? { t0: { block: 1, ts: T0, minute: 1280 } } : { reason: 'not located: x' }),
})
const real = (n: number, repaidUsd: number): RealRecord => ({
  kind: 'real',
  seq: ++seq,
  pid: pid(n),
  ts: T0,
  block: 1,
  tx: '0x',
  logIndex: 0,
  repaidUsd,
  seizedUsd: repaidUsd,
})
const mem = (
  n: number,
  event: MemRecord['event'],
  repaidUsd = 0,
  why?: MemRecord['why'],
  ts = T0,
): MemRecord => ({
  kind: 'mem',
  seq: ++seq,
  pid: pid(n),
  ts,
  minute: Math.floor((ts - START) / 60),
  event,
  ...(why ? { why } : {}),
  repaidUsd,
  soldUsd: repaidUsd,
  ltv: 0.81,
})

// 4 walked positions + 1 not walked: #1 sold, #2 armed then kept, #3 armed, #4 armed then
// sold only by the grid-end sale (a window still open at the data end).
const records: StreamRecord[] = [
  open(1, 'ETH'),
  open(2, 'ETH'),
  open(3, 'BTC'),
  open(4, 'BTC'),
  open(5, 'ETH', false),
  real(1, 1_234_567),
  real(2, 2_000_000),
  real(3, 450_000),
  real(4, 300_000),
  real(5, 99_999),
  mem(1, 'sell-instant', 640_000, 'instant'),
  mem(2, 'arm'),
  mem(3, 'arm'),
  mem(4, 'arm'),
  mem(2, 'save', 0, undefined, T0 + 60),
  mem(4, 'sell', 210_000, 'grid-end', END - 60),
]
const tl = new WavefrontTimeline()
tl.append(records)

const props = (t: number, extra: Partial<WavefrontViewProps> = {}): WavefrontViewProps => ({
  frame: tl.frameAt(t),
  mode: 'replay',
  status: 'ready',
  error: null,
  windowRange: { startTs: START, endTs: END },
  updatedAt: null,
  stale: false,
  staleSince: null,
  liveUnavailable: false,
  start: START,
  end: END,
  t,
  playing: false,
  onToggle: () => {},
  onSeek: () => {},
  protocols: ['aave-v3'],
  chains: ['mainnet'],
  clusterTotals: tl.clusterTotals().map((count, i) => ({ name: tl.clusterNames[i], count })),
  ...extra,
})

/** Visible text of the server-rendered page, tags stripped, whitespace collapsed. */
const text = (p: WavefrontViewProps) =>
  renderToString(
    React.createElement(ChakraProvider, { theme }, React.createElement(WavefrontView, p)),
  )
    .replace(/<!-- -->/g, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

describe('wavefront page wiring (server render)', () => {
  it('at the data end: each visible figure is the reducer figure it should be', () => {
    const f = tl.frameAt(END)
    expect(f.coverage).toEqual({ walked: 4, total: 5 })
    expect(f.gridEnd).toBe(1)
    const page = text(props(END))
    // headline: every liquidated position (coverage.total)
    expect(page).toContain('5 positions liquidated so far')
    // coverage: n of N, once
    expect(page).toContain('Same 4 positions on both sides (80%)')
    expect(page).toContain('1 not compared: not liquidatable when rechecked')
    // $: the reducer's totals, walked positions only, two significant figures
    expect(f.totals.real.repaidUsd).toBe(1_234_567 + 2_000_000 + 450_000 + 300_000)
    expect(page).toContain('Debt force-closed: real $4M · Membrane $850K†')
    // Real legend: coverage.walked; Membrane: the partition, grid-end drawn apart
    expect(page).toContain('4 sold')
    expect(page).toContain('Membrane (simulator)† 1 sold 1 in 8h window')
    expect(page).toContain('1 in 8h window')
    expect(page).toContain('1 window open at data end†')
    expect(page).toContain('1 kept')
    // the grid-end $ caveat, once, in the footer; the engine named once
    expect(page).toContain('Membrane $ counts them as sold at Oct 12 00:00 UTC†')
    expect(page).toContain('Membrane side†: the position simulator replaying cureWalk')
    expect(page).toContain('with no user action.')
    expect(page).toContain('Membrane (simulator)†')
    expect(page).toContain('Replay · Oct 10–11, 2025')
    expect(page).not.toMatch(/\bLive\b/)
    // the phone table carries the same figures
    expect(page).toContain('debt force-closed $4M $850K†')
  })

  it('before the data end there is no grid-end mark, legend or caveat', () => {
    const page = text(props(END - 600))
    expect(page).toContain('2 in 8h window')
    expect(page).not.toContain('open at data end')
    expect(page).not.toContain('counts them as sold')
  })

  it('a failed live request says the replay is shown', () => {
    const page = text(props(END, { liveUnavailable: true }))
    expect(page).toContain('Live unavailable — showing the Oct 10–11, 2025 replay')
  })

  it('stale live data withholds the headline number and never says "Live ·"', () => {
    const page = text(
      props(END, {
        mode: 'live',
        stale: true,
        staleSince: END - 600,
        updatedAt: END,
        windowRange: null,
      }),
    )
    expect(page).toContain('Stale since Oct 11 23:50 UTC')
    expect(page).toContain('— positions liquidated so far')
    expect(page).not.toContain('Live ·')
    // live has no scrub
    expect(page).not.toContain('Play')
  })
})
