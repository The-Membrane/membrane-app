import { describe, expect, it } from 'vitest'

import {
  LTV_GLIDE_PERIOD_S,
  MAX_LTV_MOVE_PER_PERIOD,
  WAD,
  decodeDenom,
  discoFloor,
  fmtPp,
  fmtToken,
  fmtWadPct,
  glideRuleSentence,
  glidedValue,
  historyRows,
  projectGlide,
  targetSource,
  waterfallRows,
  type Glide,
} from '@/lib/riskDesk/riskLogic'

const pct = (n: number) => (BigInt(Math.round(n * 100)) * WAD) / 10_000n
const CAP = pct(90)
const P = LTV_GLIDE_PERIOD_S
const g = (applied: bigint, committed: bigint, windowStart = 1_000n): Glide => ({ applied, committed, windowStart, seeded: true })

/** Independent restatement of Collateral._glidedValue (Collateral.sol:568-582). */
function contract(cap: bigint, gl: Glide, now: bigint): bigint {
  const elapsed = now - gl.windowStart
  let moved = gl.committed
  if (elapsed < P) {
    const q = (moved < 0n ? -moved : moved) * elapsed / P // |x|/P floors
    moved = moved < 0n ? -q : q // Solidity signed division truncates toward zero
  }
  const v = gl.applied + moved
  if (v <= 0n) return 0n
  return v > cap ? cap : v
}

describe('glide math = Collateral._glidedValue', () => {
  it('is linear inside the window and flat after it', () => {
    const gl = g(pct(80), MAX_LTV_MOVE_PER_PERIOD)
    expect(glidedValue(CAP, gl, 1_000n)).toBe(pct(80))
    expect(glidedValue(CAP, gl, 1_000n + P / 2n)).toBe(pct(82.5))
    expect(glidedValue(CAP, gl, 1_000n + P)).toBe(pct(85))
    expect(glidedValue(CAP, gl, 1_000n + 10n * P)).toBe(pct(85))
  })

  it('handles a negative committed move, truncating toward zero', () => {
    const gl = g(pct(80), -MAX_LTV_MOVE_PER_PERIOD)
    expect(glidedValue(CAP, gl, 1_000n + P / 2n)).toBe(pct(77.5))
    // 1 second in: -5e16 * 1 / 1_209_600 = -41_335_978_835.97… → -41_335_978_835 (toward zero)
    expect(glidedValue(CAP, gl, 1_001n)).toBe(pct(80) - 41_335_978_835n)
    expect(glidedValue(CAP, gl, 1_000n + P)).toBe(pct(75))
  })

  it('clamps at the cap and at zero', () => {
    expect(glidedValue(CAP, g(pct(88), MAX_LTV_MOVE_PER_PERIOD), 1_000n + P)).toBe(CAP)
    expect(glidedValue(CAP, g(pct(3), -MAX_LTV_MOVE_PER_PERIOD), 1_000n + P)).toBe(0n)
    expect(glidedValue(CAP, g(0n, 0n), 5_000n)).toBe(0n)
  })

  it('matches an independent restatement across a sweep', () => {
    const moves = [-MAX_LTV_MOVE_PER_PERIOD, -12_345_678_901_234_567n, -1n, 0n, 1n, 33_333_333_333_333_333n, MAX_LTV_MOVE_PER_PERIOD]
    const applieds = [0n, 1n, pct(2), pct(50), pct(87.5), CAP]
    const times = [1_000n, 1_001n, 1_000n + 7n, 1_000n + P / 3n, 1_000n + P - 1n, 1_000n + P, 1_000n + 3n * P]
    for (const m of moves) for (const a of applieds) for (const t of times) {
      expect(glidedValue(CAP, g(a, m), t)).toBe(contract(CAP, g(a, m), t))
    }
  })
})

describe('projectGlide', () => {
  it('reports now, end, direction and % of cap', () => {
    const p = projectGlide(CAP, g(pct(80), -MAX_LTV_MOVE_PER_PERIOD), 1_000n + P / 4n)
    expect(p.now).toBe(pct(78.75))
    expect(p.end).toBe(pct(75))
    expect(p.direction).toBe('down')
    expect(p.progress).toBeCloseTo(0.25, 6)
    expect(p.windowOpen).toBe(true)
    expect(p.windowEnd).toBe(1_000n + P)
    expect(p.pctOfCapEnd).toBeCloseTo((75 / 90) * 100, 3)
  })
  it('a flat window is flat and closes', () => {
    const p = projectGlide(CAP, g(pct(80), 0n), 1_000n + 2n * P)
    expect(p.direction).toBe('flat')
    expect(p.windowOpen).toBe(false)
    expect(p.progress).toBe(1)
    expect(p.now).toBe(p.end)
  })
})

describe('the LTV-change sentence is derived from the constants', () => {
  it('reads 5 pp per 14 days', () => {
    expect(glideRuleSentence()).toBe(
      'The max LTV moves at most 5 percentage points per 14-day window, in either direction, and can never exceed the listing cap.',
    )
  })
})

describe('target source (Collateral.targetMaxLTV)', () => {
  const zero = '0x0000000000000000000000000000000000000000'
  const disco = '0x7a2088a1bFc9d81c55368AE168C2C02570cB814F'
  it('onboarding window wins first', () => {
    expect(targetSource({ nowS: 10n, onboardingWindowEnd: 20n, discoOracle: disco, discoAverage: pct(70) })).toBe('onboarding')
  })
  it('no Disco wired → listing LTV', () => {
    expect(targetSource({ nowS: 30n, onboardingWindowEnd: 20n, discoOracle: zero, discoAverage: 0n })).toBe('no-disco')
  })
  it('Disco returning 0 (below floor or no VT) → listing LTV', () => {
    expect(targetSource({ nowS: 30n, onboardingWindowEnd: 0n, discoOracle: disco, discoAverage: 0n })).toBe('disco-below-floor')
    expect(targetSource({ nowS: 30n, onboardingWindowEnd: 0n, discoOracle: disco, discoAverage: pct(70) })).toBe('disco')
  })
  it('asset floor can only raise the 1,000 MBRN code floor', () => {
    expect(discoFloor(0n)).toBe(1000n * WAD)
    expect(discoFloor(5000n * WAD)).toBe(5000n * WAD)
  })
})

describe('waterfall rows', () => {
  const rows = waterfallRows({
    reserve: 7n,
    pendingRevenue: 1000n * WAD,
    split: { disco: pct(20), junior: pct(64), senior: pct(16) },
    discoMbrn: 3n * WAD,
    juniorStaked: 11n,
    seniorStaked: 13n,
    outstandingHole: 17n,
  })
  it('is the 8-step cascade in order', () => {
    expect(rows.map((r) => r.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rows.map((r) => r.key)).toEqual(['reserve', 'disco-rev', 'disco-mbrn', 'junior-rev', 'junior-cap', 'senior-rev', 'senior-cap', 'hole'])
  })
  it('sizes revenue stops as pending × ratio', () => {
    expect(rows[1].amount).toBe(200n * WAD)
    expect(rows[3].amount).toBe(640n * WAD)
    expect(rows[5].amount).toBe(160n * WAD)
  })
  it('marks units and scope', () => {
    expect(rows.filter((r) => r.scope === 'global').map((r) => r.key)).toEqual(['reserve', 'hole'])
    expect(rows.find((r) => r.key === 'disco-mbrn')!.unit).toBe('MBRN')
    expect(rows.filter((r) => r.unit === 'CDT')).toHaveLength(7)
    expect(rows[7].kind).toBe('hole')
  })
  it('keeps zeros', () => {
    const z = waterfallRows({ reserve: 0n, pendingRevenue: 0n, split: { disco: 0n, junior: 0n, senior: 0n }, discoMbrn: 0n, juniorStaked: 0n, seniorStaked: 0n, outstandingHole: 0n })
    expect(z).toHaveLength(8)
    expect(z.every((r) => r.amount === 0n)).toBe(true)
  })
})

describe('history + formatting', () => {
  it('orders newest first and derives window end + landing value', () => {
    const rows = historyRows(
      [
        { blockNumber: 9n, logIndex: 0, txHash: '0xa', applied: pct(80), committed: 0n, windowStart: 100n },
        { blockNumber: 50n, logIndex: 1, txHash: '0xc', applied: pct(80), committed: -pct(5), windowStart: 200n },
        { blockNumber: 50n, logIndex: 0, txHash: '0xb', applied: pct(80), committed: 0n, windowStart: 200n },
      ],
      new Map([[9n, 100n], [50n, 200n]]),
    )
    expect(rows.map((r) => r.txHash)).toEqual(['0xc', '0xb', '0xa'])
    expect(rows[0].landsAt).toBe(pct(75))
    expect(rows[0].direction).toBe('down')
    expect(rows[0].windowEnd).toBe(200n + P)
    expect(rows[2].blockTime).toBe(100n)
  })
  it('decodes bytes32 denoms and formats numbers', () => {
    expect(decodeDenom('0x5745544800000000000000000000000000000000000000000000000000000000')).toBe('WETH')
    expect(fmtWadPct(pct(82.5))).toBe('82.50%')
    expect(fmtPp(-pct(5))).toBe('-5.00 pp')
    expect(fmtPp(pct(2.5))).toBe('+2.50 pp')
    expect(fmtToken(0n)).toBe('0')
    expect(fmtToken(1234n * WAD + WAD / 2n)).toBe('1,234.50')
  })
})
