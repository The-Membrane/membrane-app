import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { bigintReviver, bpsToRay, RAY, SECONDS_PER_YEAR, WAD, wExp } from '@/lib/netApy/fixedPoint'
import {
  aaveBorrowRateAtUsage,
  aaveV2Rates,
  adaptiveCurveBorrowRate,
  curve,
  decodeReserveConfig,
  eulerUtilization,
  kinkUtilization,
  linearKinkRateAtUtilization,
  MAX_RATE_AT_TARGET,
  newRateAtTarget,
  ratesAtSize,
  ratesAtUtilization,
  ratesNow,
  SizeError,
  storedRateDriftBps,
  UINT32_MAX,
} from '@/lib/netApy/irm'
import { DAY_S, ratePath, rateSpikeAxis } from '@/lib/netApy/ratePath'
import type { AaveV2StrategyIrm, EulerLinearKinkIrm, VenueSnapshot } from '@/lib/netApy/types'
import { NET_APY_VENUES, usdToRaw } from '@/lib/netApy/venues'

import { cashOf, localRates, PINNED_BLOCK, type IrmCase } from './netApyCases'

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'), bigintReviver) as {
  anchor: VenueSnapshot['anchor']
  snapshots: VenueSnapshot[]
  cases: IrmCase[]
}
const snap = (key: string): VenueSnapshot => {
  const s = fixture.snapshots.find((x) => x.venueKey === key)
  if (!s) throw new Error(`fixture has no ${key}`)
  return s
}

// ---------------------------------------------------------------- the pin

describe('IRM math vs the on-chain getters (fixture pinned at block 26,120,000)', () => {
  it('the fixture is the pinned block and covers every registered venue', () => {
    expect(fixture.anchor.blockNumber).toBe(PINNED_BLOCK)
    expect(fixture.snapshots.map((s) => s.venueKey).sort()).toEqual(NET_APY_VENUES.map((v) => v.venueKey).sort())
    for (const s of fixture.snapshots) expect(s.anchor.blockNumber).toBe(PINNED_BLOCK)
  })

  it('reproduces every recorded on-chain rate exactly (107 cases, both sides, $0 → $500M)', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(100)
    for (const c of fixture.cases) {
      expect({ c: c.venueKey, side: c.side, size: c.sizeRaw, ...localRates(snap(c.venueKey), c.side, c.sizeRaw) }).toEqual({
        c: c.venueKey,
        side: c.side,
        size: c.sizeRaw,
        ...c.onchain,
      })
    }
  })

  it('every protocol is exercised with non-zero sizes on both sides', () => {
    for (const model of ['aave-rate-strategy-v2', 'spark-variable-borrow', 'morpho-adaptive-curve', 'euler-linear-kink']) {
      const keys = fixture.snapshots.filter((s) => s.irm.model === model).map((s) => s.venueKey)
      expect(keys.length).toBeGreaterThan(0)
      for (const side of ['supply', 'borrow'] as const) {
        expect(fixture.cases.some((c) => keys.includes(c.venueKey) && c.side === side && c.sizeRaw > 0n)).toBe(true)
      }
    }
  })

  it('the reconstructed current rate sits within 25 bps of the rate the venue stored', () => {
    // The stored rate is from the venue's last update; balances accrue after it, so the
    // two are close, not equal. A model bug shows up as a gap of whole percent.
    for (const s of fixture.snapshots) {
      const drift = storedRateDriftBps(s)
      if (drift === null) continue
      expect({ v: s.venueKey, ok: Math.abs(drift) < 25 }).toEqual({ v: s.venueKey, ok: true })
    }
  })
})

// --------------------------------------------------------------- formulas

const aaveIrm = (o: Partial<AaveV2StrategyIrm> = {}): AaveV2StrategyIrm => ({
  model: 'aave-rate-strategy-v2',
  strategy: '0x0000000000000000000000000000000000000001',
  optimalUsageRatioBps: 9_000n,
  baseVariableBorrowRateBps: 0n,
  variableRateSlope1Bps: 400n,
  variableRateSlope2Bps: 6_000n,
  ...o,
})

describe('Aave v3 rate strategy V2', () => {
  it('is base + slope1 exactly at the optimal ratio, and base + slope1 + slope2 at 100%', () => {
    const irm = aaveIrm({ baseVariableBorrowRateBps: 25n })
    expect(aaveBorrowRateAtUsage(irm, bpsToRay(9_000n))).toBe(bpsToRay(425n))
    expect(aaveBorrowRateAtUsage(irm, RAY)).toBe(bpsToRay(6_425n))
  })

  it('splits gross yield into supply rate and reserve factor: liquidity = borrow × usage × (1 − RF)', () => {
    // 50% usage, slope1 4% at 90% optimal → borrow = 4% × 0.5/0.9; RF 10%.
    const r = aaveV2Rates(aaveIrm(), {
      unbacked: 0n,
      liquidityAdded: 0n,
      liquidityTaken: 0n,
      totalDebt: 500n * WAD,
      reserveFactor: 1_000n,
      virtualUnderlyingBalance: 500n * WAD,
    })
    expect(Number(r.variableBorrowRate) / 1e27).toBeCloseTo((0.04 * 0.5) / 0.9, 12)
    expect(Number(r.liquidityRate) / 1e27).toBeCloseTo(((0.04 * 0.5) / 0.9) * 0.5 * 0.9, 12)
  })

  it('returns base and zero supply rate with no debt; refuses a borrow larger than the pool', () => {
    const irm = aaveIrm({ baseVariableBorrowRateBps: 50n })
    const params = { unbacked: 0n, liquidityAdded: 0n, liquidityTaken: 0n, totalDebt: 0n, reserveFactor: 0n, virtualUnderlyingBalance: 10n }
    expect(aaveV2Rates(irm, params)).toMatchObject({ liquidityRate: 0n, variableBorrowRate: bpsToRay(50n) })
    expect(() => aaveV2Rates(irm, { ...params, totalDebt: 5n, liquidityTaken: 11n })).toThrow(/exceeds available liquidity/)
  })

  it('decodes decimals, reserve factor and caps from the configuration bitmap', () => {
    const cfg = (6n << 48n) | (1_000n << 64n) | (2_500_000_000n << 80n) | (3_000_000_000n << 116n) | 0xffffn
    expect(decodeReserveConfig(cfg)).toEqual({ decimals: 6, reserveFactorBps: 1_000n, borrowCapWhole: 2_500_000_000n, supplyCapWhole: 3_000_000_000n })
  })
})

describe('Morpho AdaptiveCurveIrm', () => {
  const rat = (4n * WAD) / 100n / SECONDS_PER_YEAR // 4%/yr at target

  it('curve: rateAtTarget at 90%, a quarter of it at 0%, four times it at 100%', () => {
    expect(curve(rat, 0n)).toBe(rat)
    // rat is ~1.27e9 wei/s, so truncation toward zero shows at the 1e-9 level.
    expect(Number(curve(rat, -WAD)) / Number(rat)).toBeCloseTo(0.25, 6)
    expect(Number(curve(rat, WAD)) / Number(rat)).toBeCloseTo(4, 6)
  })

  it('wExp is exact at 0 and ln2, ~0 below ln(1e-18), and within 1% of e^x elsewhere', () => {
    expect(wExp(0n)).toBe(WAD)
    expect(wExp(693_147_180_559_945_309n)).toBe(2n * WAD)
    expect(wExp(-42n * WAD)).toBe(0n)
    for (const x of [-5, -1, -0.3, 0.3, 1, 3, 10]) {
      const got = Number(wExp(BigInt(Math.round(x * 1e6)) * 10n ** 12n)) / 1e18
      expect(Math.abs(got / Math.exp(x) - 1)).toBeLessThan(0.01)
    }
  })

  it('at 100% utilization rateAtTarget doubles in ln2/50 of a year (~5.1 days), and is capped at 200%/yr', () => {
    const t = BigInt(Math.round((Math.LN2 / 50) * 365 * DAY_S))
    const speed = (50n * WAD) / SECONDS_PER_YEAR // × err = 1
    const doubled = newRateAtTarget(rat, speed * t)
    expect(Number(doubled) / Number(rat)).toBeCloseTo(2, 2)
    expect(newRateAtTarget(rat, speed * 10_000n * BigInt(DAY_S))).toBe(MAX_RATE_AT_TARGET)
  })

  it('first interaction (rateAtTarget 0) uses the 4%/yr initial rate', () => {
    const r = adaptiveCurveBorrowRate(0n, { totalSupplyAssets: 100n, totalBorrowAssets: 90n, lastUpdate: 0n }, 1_000n)
    expect(r.endRateAtTarget).toBe((4n * WAD) / 100n / SECONDS_PER_YEAR)
  })
})

describe('Euler IRMLinearKink', () => {
  const irm: EulerLinearKinkIrm = {
    model: 'euler-linear-kink',
    irm: '0x0000000000000000000000000000000000000002',
    baseRate: 7n,
    slope1: 3n,
    slope2: 50n,
    kink: (UINT32_MAX * 9n) / 10n,
  }

  it('is linear up to and including the kink, then adds slope2 per step above it', () => {
    expect(linearKinkRateAtUtilization(irm, irm.kink)).toBe(7n + irm.kink * 3n)
    expect(linearKinkRateAtUtilization(irm, irm.kink + 1n)).toBe(7n + irm.kink * 3n + 50n)
    expect(linearKinkRateAtUtilization(irm, UINT32_MAX)).toBe(7n + irm.kink * 3n + 50n * (UINT32_MAX - irm.kink))
  })

  it('quantises utilization to uint32 and treats an empty vault as 0%', () => {
    expect(eulerUtilization(0n, 0n)).toBe(0n)
    expect(eulerUtilization(1n, 1n)).toBe(UINT32_MAX / 2n)
    expect(eulerUtilization(0n, 5n)).toBe(UINT32_MAX)
  })
})

// ---------------------------------------------------------- size projection

describe('rates at the user’s size (fixture venues)', () => {
  it('a deposit lowers utilization and both rates; a borrow raises them', () => {
    for (const s of fixture.snapshots) {
      const now = ratesNow(s)
      const dep = ratesAtSize(s, { supply: usdToRaw(50_000_000, s.asset), borrow: 0n })
      expect({ v: s.venueKey, ok: dep.utilization < now.utilization && dep.borrowApr <= now.borrowApr && dep.supplyApr <= now.supplyApr }).toEqual({ v: s.venueKey, ok: true })
      // Half the venue's cash, capped at $1M: Euler eUSDC-2 held ~$0.19M at the pin.
      const cash = cashOf(s)
      const want = usdToRaw(1_000_000, s.asset)
      const bor = ratesAtSize(s, { supply: 0n, borrow: want < cash / 2n ? want : cash / 2n })
      expect({ v: s.venueKey, ok: bor.utilization > now.utilization && bor.borrowApr >= now.borrowApr }).toEqual({ v: s.venueKey, ok: true })
    }
  })

  it('rows add up: supplyApr = grossSupplyApr − venueFeeApr', () => {
    for (const s of fixture.snapshots) {
      const p = ratesAtSize(s, { supply: usdToRaw(1_000_000, s.asset), borrow: 0n })
      expect(p.grossSupplyApr - p.venueFeeApr).toBeCloseTo(p.supplyApr, 15)
      expect(p.venueFeeApr).toBeGreaterThanOrEqual(0)
    }
  })

  it('a borrow larger than the venue’s cash is a SizeError, not a rate', () => {
    const s = snap('euler-v2-eusdc-2')
    expect(() => ratesAtSize(s, { supply: 0n, borrow: usdToRaw(1e12, s.asset) })).toThrow(SizeError)
  })

  it('kink utilization per model: Aave optimal, Morpho 90%, Euler kink', () => {
    expect(kinkUtilization(snap('aave-v3-usdc'))).toBe(94n * 10n ** 16n) // 9400 bps, read on-chain
    expect(kinkUtilization(snap('morpho-blue-cbbtc-usdc-86'))).toBe(9n * 10n ** 17n)
    const e = snap('euler-v2-eusdc-2')
    expect(Number(kinkUtilization(e)) / 1e18).toBeCloseTo(0.9, 6)
  })
})

describe('rate path (the Risk Frontier hand-off)', () => {
  it('is flat on static curves and rises over time on Morpho at 100% utilization', () => {
    const aave = ratePath(snap('aave-v3-usdc'), { utilization: 1, horizonSeconds: 30 * DAY_S, steps: 6 })
    expect(new Set(aave.map((p) => p.borrowApr)).size).toBe(1)
    const morpho = ratePath(snap('morpho-blue-cbbtc-usdc-86'), { utilization: 1, horizonSeconds: 30 * DAY_S, steps: 6 })
    for (let i = 1; i < morpho.length; i++) expect(morpho[i].borrowApr).toBeGreaterThanOrEqual(morpho[i - 1].borrowApr)
    expect(morpho[morpho.length - 1].borrowApr).toBeGreaterThan(morpho[0].borrowApr * 8) // ~2^(30/5.1)
  })

  it('at t = 0 the path equals the rate at that utilization', () => {
    const s = snap('morpho-blue-wsteth-usdt-86')
    const p = ratePath(s, { utilization: 0.95, horizonSeconds: DAY_S, steps: 1 })
    expect(p[0].borrowApr).toBe(ratesAtUtilization(s, 95n * 10n ** 16n).borrowApr)
  })

  it('the spike axis carries the anchor, the projected label and the stated assumption', () => {
    const s = snap('spark-usdc')
    const axis = rateSpikeAxis(s, { size: { supply: 0n, borrow: usdToRaw(1_000_000, s.asset) } })
    expect(axis.anchor.blockNumber).toBe(PINNED_BLOCK)
    expect(axis.label).toBe('projected')
    expect(axis.assumption).toMatch(/held fixed/)
    expect(axis.levels.map((l) => l.name)).toEqual(['now', 'at-size', 'kink', 'stress', 'stress'])
    const full = axis.levels[axis.levels.length - 1]
    expect(full.utilization).toBe(1)
  })
})
