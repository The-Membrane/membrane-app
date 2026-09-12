import { describe, expect, it } from 'vitest'

import { carryCost } from '@/lib/position-sim/carryCost'
import type { DebtLeg, ProtocolPosition } from '@/lib/position-sim/types'
import type { VenueDetection } from '@/lib/position-sim/venues'

const leg = (symbol: string, valueUsd: number, borrowApr: number | null): DebtLeg => ({
  symbol,
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  amount: valueUsd,
  priceUsd: 1,
  valueUsd,
  borrowApr,
})

const coll = (symbol: string, valueUsd: number) => ({
  symbol,
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  amount: valueUsd,
  priceUsd: 1,
  valueUsd,
  liquidationThreshold: 0.8,
  maxLtv: 0.75,
  liquidationBonus: 0.05,
})

const position = (debt: DebtLeg[], collateral: ReturnType<typeof coll>[] = []): ProtocolPosition =>
  ({
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral,
    debt,
    totalCollateralUsd: collateral.reduce((a, c) => a + c.valueUsd, 0),
    totalDebtUsd: debt.reduce((a, d) => a + d.valueUsd, 0),
    ltv: 0,
    liquidationLtv: 0,
    healthFactor: 0,
    provenance: { kind: 'onchain', label: 'test', at: 0 },
  }) as ProtocolPosition

/** A detection holding `totalUsd` in one venue. `underlying` matters: a venue whose
 *  underlying is already a collateral leg of the position is the position's own
 *  collateral seen twice, and carryCost must drop it. */
const detected = (totalUsd: number, underlying = 'USDS', symbol = 'sUSDS'): VenueDetection =>
  ({
    status: 'detected',
    detected: [
      { venue: { symbol, underlying, decimals: 18 }, amount: totalUsd, valueUsd: totalUsd },
    ],
    totalUsd,
    provenance: { kind: 'onchain', label: 'test', at: 0 },
  }) as unknown as VenueDetection

const none = (): VenueDetection =>
  ({
    status: 'none',
    detected: [],
    totalUsd: 0,
    provenance: { kind: 'onchain', label: 'test', at: 0 },
  }) as unknown as VenueDetection

describe('carryCost', () => {
  it('costs only the legs that expose a rate', () => {
    const c = carryCost(position([leg('USDC', 100_000, 0.05)]), detected(100_000))
    expect(c.annualCostUsd).toBeCloseTo(5_000, 6)
    expect(c.pricedDebtUsd).toBe(100_000)
    expect(c.unpricedDebtUsd).toBe(0)
    expect(c.aprWeighted).toBeCloseTo(0.05, 9)
  })

  it('no apr anywhere: no fixed cost on a covered slice, and the debt is reported as unpriced', () => {
    // Morpho Blue is the live case — its adapter returns borrowApr: null.
    const c = carryCost(position([leg('USDC', 250_000, null)]), detected(250_000))
    expect(c.fixedCostOnCoveredUsd).toBe(0)
    expect(c.annualCostUsd).toBe(0)
    expect(c.pricedDebtUsd).toBe(0)
    expect(c.unpricedDebtUsd).toBe(250_000)
    expect(c.coveredDebtUsd).toBe(0)
  })

  it('deployment larger than the debt is capped at the debt', () => {
    const c = carryCost(position([leg('USDC', 100_000, 0.06)]), detected(400_000))
    expect(c.deployedUsd).toBe(400_000)
    expect(c.coveredDebtUsd).toBe(100_000)
    expect(c.fixedCostOnCoveredUsd).toBeCloseTo(6_000, 6)
  })

  it('partial deployment covers proportionally, never more', () => {
    const c = carryCost(position([leg('USDC', 200_000, 0.05)]), detected(50_000))
    expect(c.coveredDebtUsd).toBe(50_000)
    expect(c.fixedCostOnCoveredUsd).toBeCloseTo(2_500, 6)
    // The full bill is still stated — the saving is only the deployed quarter of it.
    expect(c.annualCostUsd).toBeCloseTo(10_000, 6)
    expect(c.fixedCostOnCoveredUsd).toBeLessThan(c.annualCostUsd)
  })

  it('no deployment detected: the bill stands and nothing is covered', () => {
    const c = carryCost(position([leg('USDC', 200_000, 0.05)]), none())
    expect(c.annualCostUsd).toBeCloseTo(10_000, 6)
    expect(c.deployedUsd).toBe(0)
    expect(c.coveredDebtUsd).toBe(0)
    expect(c.fixedCostOnCoveredUsd).toBe(0)
  })

  it('a null detection is the same as no deployment', () => {
    expect(carryCost(position([leg('USDC', 200_000, 0.05)]), null).fixedCostOnCoveredUsd).toBe(0)
  })

  it('mixed priced and unpriced legs: only the priced ones are covered', () => {
    const c = carryCost(
      position([leg('USDC', 100_000, 0.04), leg('WBTC', 100_000, null)]),
      detected(200_000),
    )
    expect(c.pricedDebtUsd).toBe(100_000)
    expect(c.unpricedDebtUsd).toBe(100_000)
    // The deployment covers 200k, but only 100k of debt has a rate to save.
    expect(c.coveredDebtUsd).toBe(100_000)
    expect(c.fixedCostOnCoveredUsd).toBeCloseTo(4_000, 6)
  })

  it('weights the apr by leg value', () => {
    const c = carryCost(
      position([leg('USDC', 300_000, 0.06), leg('USDT', 100_000, 0.02)]),
      detected(400_000),
    )
    expect(c.aprWeighted).toBeCloseTo(0.05, 9)
    expect(c.annualCostUsd).toBeCloseTo(20_000, 6)
    expect(c.fixedCostOnCoveredUsd).toBeCloseTo(20_000, 6)
  })

  it('the covered slice carries its fixed interest today: covered × apr', () => {
    expect(carryCost(position([leg('USDC', 1, 0.5)]), detected(1)).fixedCostOnCoveredUsd).toBeCloseTo(0.5, 9)
  })

  it('a venue balance that IS the position\u2019s own collateral is not a deployment', () => {
    // The live shape this rule was written for: an Aave borrower who also supplied
    // USDC shows up holding aEthUSDC. Those are the collateral dollars, not deployed
    // debt, and crediting them would invent a carry.
    const c = carryCost(
      position([leg('WETH', 300_000, 0.02)], [coll('USDC', 295_000), coll('WBTC', 420_000)]),
      detected(295_000, 'USDC', 'aEthUSDC'),
    )
    expect(c.collateralDeployedUsd).toBe(295_000)
    expect(c.deployedUsd).toBe(0)
    expect(c.fixedCostOnCoveredUsd).toBe(0)
  })

  it('a venue unrelated to the collateral still counts', () => {
    const c = carryCost(
      position([leg('USDC', 100_000, 0.05)], [coll('WBTC', 400_000)]),
      detected(100_000, 'USDS', 'sUSDS'),
    )
    expect(c.collateralDeployedUsd).toBe(0)
    expect(c.deployedUsd).toBe(100_000)
    expect(c.fixedCostOnCoveredUsd).toBeCloseTo(5_000, 6)
  })

  it('an errored venue scan is not a deployment', () => {
    const errored = { status: 'error', detected: [], totalUsd: 0 } as unknown as VenueDetection
    expect(carryCost(position([leg('USDC', 100_000, 0.05)]), errored).fixedCostOnCoveredUsd).toBe(0)
  })
})
