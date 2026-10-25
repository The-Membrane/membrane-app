/**
 * oracleRounds — Chainlink phase windows and the phase HANDOVER round (refuter finding
 * 2026-10-06: at a proxy phase switch the hourly columns carried the OLD aggregator's last
 * value until the new one's first in-phase round, though the proxy served the new
 * aggregator's pre-switch round from the switch block on).
 *
 * Fixture, modelled on ETH/USD phase 3 (switch block 11008985, 2020-10-07 13:52:36Z; the new
 * aggregator's latest round was 341.1598 from 12:09:23, its first in-phase round 15:09:08).
 * Two aggregators, 8 decimals; the switch is block 1000 at 10:40 on day 0.
 */
import { describe, expect, it } from 'vitest'

import {
  aggregateHours,
  decodeRounds,
  handoverRow,
  inPhase,
  withHandovers,
  type AnswerLog,
  type PhaseHandover,
  type PhaseWindow,
} from '@/lib/position-sim/oracleRounds'

const H = 3600
const t = (h: number, m = 0) => h * H + m * 60
const OLD = '0xAAAA000000000000000000000000000000000001'
const NEW = '0xBBBB000000000000000000000000000000000002'
const px = (x: number) => BigInt(Math.round(x * 1e8))

const PHASES: PhaseWindow[] = [
  { phase: 1, address: OLD, logSource: OLD, fromBlock: '0', toBlock: '999' },
  { phase: 2, address: NEW, logSource: NEW, fromBlock: '1000', toBlock: null },
]

function log(address: string, block: number, logIndex: number, ts: number, price: number) {
  return {
    address,
    blockNumber: BigInt(block),
    logIndex,
    args: { current: px(price), updatedAt: BigInt(ts) },
  } satisfies AnswerLog
}

const LOGS: AnswerLog[] = [
  log(OLD, 800, 0, t(8, 10), 341.5),
  log(NEW, 820, 0, t(8, 20), 341.1598), // the new aggregator's latest before the switch
  log(OLD, 850, 0, t(9, 10), 342.0),
  log(OLD, 900, 0, t(10, 10), 341.72), // the old phase's last in-window round
  log(OLD, 1010, 0, t(10, 45), 345.0), // old aggregator still emitting after the switch
  log(NEW, 1300, 0, t(13, 5), 340.0), // the new aggregator's first in-phase round
]

const HANDOVER: PhaseHandover = {
  phase: 2,
  fromBlock: '1000',
  switchTs: t(10, 40),
  answer: String(px(341.1598)),
  updatedAt: t(8, 20),
}

describe('decodeRounds', () => {
  it('keeps each log only inside its own phase window', () => {
    expect(inPhase(PHASES[0], 999n)).toBe(true)
    expect(inPhase(PHASES[0], 1000n)).toBe(false)
    expect(inPhase(PHASES[1], 1000n)).toBe(true)
    const { rows, outOfPhase } = decodeRounds(LOGS, PHASES, 8)
    expect(outOfPhase).toBe(2) // NEW@820 (before its phase), OLD@1010 (after its phase)
    expect(rows.map((r) => r[0])).toEqual([800, 850, 900, 1300])
    expect(rows[2]).toEqual([900, 0, t(10, 10), 341.72])
  })

  it('without the handover the old value is carried past the switch (the bug)', () => {
    const hours = aggregateHours(decodeRounds(LOGS, PHASES, 8).rows)
    // Hour 10 closes on the OLD phase's 341.72 although the proxy served 341.1598 from 10:40.
    expect(hours.get(t(10))![1]).toBe(341.72)
  })
})

describe('phase handover', () => {
  it('adds the new phase’s pre-switch round at the switch block, stamped at the switch time', () => {
    const logged = decodeRounds(LOGS, PHASES, 8).rows
    const { rows, added } = withHandovers(logged, PHASES, [HANDOVER], 8)
    expect(added).toBe(1)
    expect(rows.map((r) => r[0])).toEqual([800, 850, 900, 1000, 1300])
    expect(rows[3]).toEqual([1000, -1, t(10, 40), 341.1598])
    const hours = aggregateHours(rows)
    // Hours 8 and 9 are untouched: the proxy still served the old phase then (stamping the
    // handover at its 08:20 updatedAt would have closed hour 8 on it).
    expect(hours.get(t(8))!.slice(1, 4)).toEqual([341.5, 341.5, 341.5])
    expect(hours.get(t(9))![1]).toBe(342.0)
    // Hour 10: old 341.72 until 10:40, then the handover value — the close is what the proxy
    // served at the hour's end, the low and high span both.
    expect(hours.get(t(10))!.slice(1, 4)).toEqual([341.1598, 341.1598, 341.72])
    expect(hours.get(t(13))![1]).toBe(340.0)
  })

  it('sorts ahead of a round the new aggregator logged inside the switch block', () => {
    const sameBlock = [...LOGS, log(NEW, 1000, 3, t(10, 40), 341.3)]
    const logged = decodeRounds(sameBlock, PHASES, 8).rows
    const { rows } = withHandovers(logged, PHASES, [HANDOVER], 8)
    const at = rows.filter((r) => r[0] === 1000)
    expect(at.map((r) => r[1])).toEqual([-1, 3])
    expect(aggregateHours(rows).get(t(10))![1]).toBe(341.3)
  })

  it('adds nothing when the new aggregator had no round yet', () => {
    const none: PhaseHandover = { ...HANDOVER, answer: null, updatedAt: null }
    expect(handoverRow(none, 8)).toBeNull()
    const logged = decodeRounds(LOGS, PHASES, 8).rows
    expect(withHandovers(logged, PHASES, [none], 8).added).toBe(0)
  })

  it('refuses a switch with no handover read, or one read for another switch block', () => {
    const logged = decodeRounds(LOGS, PHASES, 8).rows
    expect(() => withHandovers(logged, PHASES, [], 8)).toThrow(/--phase=handover/)
    expect(() => withHandovers(logged, PHASES, [{ ...HANDOVER, fromBlock: '999' }], 8)).toThrow()
    // A single-phase feed needs none.
    expect(withHandovers(logged, PHASES.slice(0, 1), [], 8).added).toBe(0)
  })

  it('scales by the feed decimals (stETH/ETH: 18)', () => {
    const h: PhaseHandover = {
      phase: 2,
      fromBlock: '20435611',
      switchTs: 1722538379,
      answer: '1000047226402391600',
      updatedAt: 1722498479,
    }
    expect(handoverRow(h, 18)![3]).toBeCloseTo(1.0000472264, 9)
  })
})
