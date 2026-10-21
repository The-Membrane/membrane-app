/**
 * A position the simulator does not walk (the full-scope Oct 10-11 census walks every one, but
 * the live engine may open one before it can walk it): it counts in coverage with a short
 * reason, is drawn on neither side, and stays out of both sides' totals (the reducer's job).
 */
import { describe, expect, it } from 'vitest'

import { aavePid, morphoPid } from '@/lib/wavefront/pid'
import type { MemRecord, OpenRecord, RealRecord, StreamRecord } from '@/lib/wavefront/stream'
import { WavefrontTimeline } from '@/components/Wavefront/model'
import { fmtPctFloor, notComparedLine } from '@/components/Wavefront/format'

const T0 = 1760131200 // 2025-10-10T21:20Z
const A = aavePid('mainnet', '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', '0x01')
const B = aavePid('mainnet', '0x4e033931ad43597d96D6bcc25c280717730B58B1', '0x02')
const C = morphoPid('base', '0xabc', '0x03')

const open = (seq: number, pid: string, walked: boolean, reason?: string): OpenRecord => ({
  kind: 'open',
  seq,
  pid,
  protocol: pid.startsWith('aave') ? 'aave-v3' : 'morpho-blue',
  chain: pid.split(':')[1],
  block: 1,
  ts: T0,
  legs: [{ symbol: 'WETH', usd: 1000 }],
  debtLegs: [{ symbol: 'USDC', usd: 800 }],
  debtUsd: 800,
  collUsd: 1000,
  line: 0.79,
  ltv0: 0.8,
  delayClass: 'delayed',
  cluster: 'ETH',
  walked,
  ...(walked ? { t0: { block: 1, ts: T0, minute: 1280 } } : { reason }),
})
const real = (seq: number, pid: string, repaidUsd: number): RealRecord => ({
  kind: 'real',
  seq,
  pid,
  ts: T0,
  block: 1,
  tx: '0x',
  logIndex: 0,
  repaidUsd,
  seizedUsd: repaidUsd * 1.05,
  ...(pid.startsWith('morpho') ? { badDebtUsd: 0 } : {}),
})
const sell = (seq: number, pid: string, repaidUsd: number): MemRecord => ({
  kind: 'mem',
  seq,
  pid,
  ts: T0 + 60,
  minute: 1281,
  event: 'sell',
  why: 'band',
  repaidUsd,
  soldUsd: repaidUsd,
  ltv: 0.83,
})

const records: StreamRecord[] = [
  open(1, A, true),
  open(2, B, false, 'not located: HF at block N >= 1 on every event (1)'),
  open(3, C, false, 'no price series for the loan token'),
  real(4, A, 500),
  real(5, B, 300),
  real(6, C, 200),
  sell(7, A, 120),
]

describe('wavefront: positions not compared', () => {
  const tl = new WavefrontTimeline()
  tl.append(records)
  const f = tl.frameAt(T0 + 600)

  it('counts them in coverage with a short reason, and draws only the walked one', () => {
    expect(f.coverage).toEqual({ walked: 1, total: 3 })
    expect(f.n).toBe(1)
    expect(f.real).toHaveLength(1)
    expect(f.mem).toHaveLength(1)
    expect(f.clusters).toEqual([{ index: 0, name: 'ETH', count: 1 }])
    expect(f.notCompared.count).toBe(2)
    expect(f.notCompared.inStream).toBe(2)
    expect(notComparedLine(f.notCompared)).toBe(
      '2 not compared: 1 no price path yet · 1 not liquidatable when rechecked',
    )
  })

  it('both sides total the same (walked) positions: the reducer leaves the rest out', () => {
    expect(f.totals.real.positions).toBe(1)
    expect(f.totals.real.repaidUsd).toBe(500)
    expect(f.totals.mem.repaidUsd).toBe(120)
    expect(f.totals.mem.positionsSold).toBe(1)
  })

  it('one reason reads as one phrase; none leaves a blank line that keeps its height', () => {
    expect(
      notComparedLine({ count: 6, reasons: [{ reason: 'not simulated yet', count: 6 }] }),
    ).toBe('6 not compared: not simulated yet')
    expect(notComparedLine({ count: 0, reasons: [] })).toBe(' ')
  })

  it('coverage percentages floor to 0.1 and print a whole number plainly', () => {
    expect(fmtPctFloor(3197, 3197)).toBe('100%')
    expect(fmtPctFloor(3157, 3163)).toBe('99.8%')
    expect(fmtPctFloor(9997, 10000)).toBe('99.9%')
    expect(fmtPctFloor(0, 0)).toBe('0%')
  })
})
