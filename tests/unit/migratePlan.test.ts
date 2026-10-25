// Q41 migrate plan: the rows, the Membrane LTV gate (trim), the blockers and the signature count
// per venue. Pure — every input is a position object built here or the demo borrower fixture.

import { describe, expect, it } from 'vitest'

import { demoBorrowerPosition } from '@/lib/position-sim/demoBorrower'
import { membraneBorrowLtv, membraneMaxLtv } from '@/lib/position-sim/membrane'
import { stamp } from '@/lib/position-sim/types'
import {
  FLASH_BUFFER_BPS,
  buildDeployPlan,
  buildMigrationPlan,
  signatureSteps,
  trimFor,
} from '@/lib/migrate/plan'
import { troveToSource } from '@/lib/migrate/liquity'
import type { MigrateSource } from '@/lib/migrate/types'

function position(over: Partial<MigrateSource> & { collUsd?: number; debtUsd?: number; debtSymbol?: string } = {}): MigrateSource {
  const collUsd = over.collUsd ?? 20_000
  const debtUsd = over.debtUsd ?? 12_000
  const debtSymbol = over.debtSymbol ?? 'USDC'
  return {
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral: [
      { symbol: 'WETH', address: '0x1', decimals: 18, amount: collUsd / 2000, priceUsd: 2000, valueUsd: collUsd, liquidationThreshold: 0.83, maxLtv: 0.805, liquidationBonus: 0.05 },
    ],
    debt: [{ symbol: debtSymbol, address: '0x2', decimals: 6, amount: debtUsd, priceUsd: 1, valueUsd: debtUsd, borrowApr: null }],
    totalCollateralUsd: collUsd,
    totalDebtUsd: debtUsd,
    ltv: debtUsd / collUsd,
    liquidationLtv: 0.83,
    healthFactor: (0.83 * collUsd) / debtUsd,
    provenance: stamp('mock', 'test'),
    ...over,
  }
}

const WETH_BORROW = membraneBorrowLtv(membraneMaxLtv('WETH')!)

describe('buildMigrationPlan — ready', () => {
  it('the demo borrower (Aave WETH/USDC, 68.4%) migrates with no trim and exact rows', () => {
    const src = demoBorrowerPosition()
    const plan = buildMigrationPlan(src)
    expect(plan.venue).toBe('aave-v3')
    expect(plan.blocked).toBeNull()
    expect(plan.trim).toBeNull()
    expect(plan.membrane.ltv).toBeCloseTo(src.totalDebtUsd / src.totalCollateralUsd, 12)
    expect(plan.membrane.borrowLtv).toBeCloseTo(WETH_BORROW, 12)
    expect(plan.fees.flashFeeUsd).toBe(0)
    expect(plan.repay).toEqual([{ symbol: 'USDC', amount: src.debt[0].amount, valueUsd: src.debt[0].valueUsd }])
    expect(plan.move[0]).toMatchObject({ symbol: 'WETH', amount: src.collateral[0].amount })
    const keys = plan.rows.map((r) => r.key)
    expect(keys).toEqual(['repay-USDC', 'move-WETH', 'ltv', 'borrow', 'flash-fee', 'gas'])
    expect(plan.rows.find((r) => r.key === 'ltv')!.value).toBe('68.4%')
    expect(plan.rows.find((r) => r.key === 'gas')!.value).toBe('after simulation')
    expect(plan.rows.find((r) => r.key === 'repay-USDC')!.detail).toContain(`${FLASH_BUFFER_BPS} bps`)
  })

  it('gas appears once simulated', () => {
    const plan = buildMigrationPlan(position(), { gasUnits: 1_234_567n })
    expect(plan.rows.find((r) => r.key === 'gas')!.value).toBe('1,234,567 units')
  })
})

describe('the Membrane LTV gate', () => {
  it('at exactly the borrow LTV there is no trim', () => {
    expect(trimFor(20_000, WETH_BORROW * 20_000, WETH_BORROW)).toBeNull()
  })

  it('82% on WETH: trim = debt − borrowLtv × collateral, or the collateral that would cover it', () => {
    const plan = buildMigrationPlan(position({ debtUsd: 16_400 }))
    expect(plan.blocked).toBeNull()
    expect(plan.trim).not.toBeNull()
    expect(plan.trim!.debtUsd).toBeCloseTo(16_400 - WETH_BORROW * 20_000, 9)
    expect(plan.trim!.targetLtv).toBeCloseTo(WETH_BORROW, 12)
    expect(plan.trim!.reason).toMatch(/Repay \$1,000 on the venue first, or add \$1,299 of collateral/)
    expect(plan.rows.find((r) => r.key === 'ltv')!.tone).toBe('danger')
    // after the trim the position sits exactly on the borrow LTV
    expect((16_400 - plan.trim!.debtUsd) / 20_000).toBeCloseTo(WETH_BORROW, 12)
  })
})

describe('blockers', () => {
  it('non-USDC debt', () => {
    expect(buildMigrationPlan(position({ debtSymbol: 'USDT' })).blocked).toMatch(/The debt is USDT/)
  })
  it('Spark: no deployed migration adapter', () => {
    expect(buildMigrationPlan(position({ protocol: 'spark', label: 'Spark' })).blocked).toMatch(/No Bundler3 migration adapter/)
  })
  it('Compound V3 is not a migration source', () => {
    const p = buildMigrationPlan(position({ protocol: 'compound-v3', label: 'Compound V3' }))
    expect(p.venue).toBeNull()
    expect(p.blocked).toMatch(/not a migration source yet/)
    expect(p.signatures).toEqual([])
  })
  it('multi-asset positions', () => {
    const base = position()
    const p = buildMigrationPlan({ ...base, collateral: [...base.collateral, { ...base.collateral[0], symbol: 'wstETH' }] })
    expect(p.blocked).toMatch(/2 collateral and 1 debt/)
  })
  it('collateral Membrane has no assumption for', () => {
    const base = position()
    expect(buildMigrationPlan({ ...base, collateral: [{ ...base.collateral[0], symbol: 'PEPE' }] }).blocked).toMatch(/no listing assumption for PEPE/)
  })
  it('Liquity: owner-only troves and LUSD debt', () => {
    const src = troveToSource('0x9C141191AF1ECEE536EaaFEd87EE483a69986A47', 6011996852737083858703n, 14700000000000000000n, 2330680000000000000000n)
    const p = buildMigrationPlan(src)
    expect(p.venue).toBe('liquity')
    expect(p.blocked).toMatch(/only be closed or adjusted by their owner/)
  })
})

describe('signatures per venue (plain EOA)', () => {
  it('Aave V3: operator (once) + aToken permit + proceeds permit + bundle', () => {
    const s = signatureSteps('aave-v3')
    expect(s.map((x) => x.id)).toEqual(['operator', 'atoken-permit', 'proceeds-permit', 'bundle'])
    expect(s.filter((x) => x.kind === 'tx')).toHaveLength(2)
    expect(s.filter((x) => x.kind === 'typed-data')).toHaveLength(2)
    // with the operator grant standing: three prompts, one of them a transaction that costs gas
    expect(s.filter((x) => x.skippedWhen === null)).toHaveLength(3)
  })
  it('Morpho Blue: operator + authorization sig + proceeds permit + bundle', () => {
    const s = signatureSteps('morpho-blue')
    expect(s.map((x) => x.id)).toEqual(['operator', 'morpho-auth', 'proceeds-permit', 'bundle'])
    // both grants standing: two prompts (proceeds permit + bundle)
    expect(s.filter((x) => x.skippedWhen === null).map((x) => x.id)).toEqual(['proceeds-permit', 'bundle'])
  })
})

describe('liquity reader conversion', () => {
  it('values the trove from the read amounts and the MCR line', () => {
    const src = troveToSource('0x9C141191AF1ECEE536EaaFEd87EE483a69986A47', 6011996852737083858703n, 14700000000000000000n, 2330680000000000000000n)
    expect(src.totalDebtUsd).toBeCloseTo(6011.996852737, 6)
    expect(src.totalCollateralUsd).toBeCloseTo(14.7 * 2330.68, 6)
    expect(src.liquidationLtv).toBeCloseTo(1 / 1.1, 12)
    expect(src.debt[0].borrowApr).toBeNull()
  })
})

describe('buildDeployPlan', () => {
  it('prefills the replayed collateral and borrow', () => {
    const p = buildDeployPlan(position())
    expect(p.kind).toBe('deploy')
    expect(p.membrane.debtUsd).toBe(12_000)
    expect(p.signatures.map((s) => s.id)).toEqual(['approve', 'deposit', 'borrow'])
  })
  it('caps the borrow at the borrow LTV and says so', () => {
    const p = buildDeployPlan(position({ debtUsd: 18_000 }))
    expect(p.membrane.debtUsd).toBeCloseTo(WETH_BORROW * 20_000, 9)
    expect(p.rows.find((r) => r.key === 'borrow')!.tone).toBe('warn')
  })
})
