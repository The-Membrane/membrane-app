// The Membrane line the simulator page may judge a position at.
//
// - The deploy's three launch stables carry the deploy script's OWN bootstrap max LTV
//   (membrane-solidity 16e12329, script/DeployFullSystem.s.sol:243-251), not a modelled
//   one. GHO has none, and nothing is invented for it.
// - A position whose collateral has NO line is not run (lib hasMembraneLine; the page
//   says why on its hero line).
// - The max-LTV slider and URL ?ltv stop at the class cap of the position on screen: 96%
//   when every collateral leg is a no-delay stable (NO_DELAY_LTV_HARD_CAP), else 90%.
//   (The slider's rendered max is checked in scripts/tests/position-sim.test.ts, which
//   runs under tsx: vitest here does not transform TSX.)

import { describe, expect, it } from 'vitest'

import { positionLtvCap } from '@/lib/position-sim/collateralClass'
import {
  DEPLOY_LAUNCH_LTV,
  MEMBRANE_DEPLOY_LTV_PROVENANCE,
  MEMBRANE_LTV_PROVENANCE,
  clampMembraneLtv,
  hasMembraneLine,
  membraneMaxLtv,
  weightedMembraneLine,
} from '@/lib/position-sim/membrane'

describe('the launch stables’ max LTV is the deploy script’s own', () => {
  it('sUSDS 88%, syrupUSDC 86%, scrvUSD 86% — DeployFullSystem.s.sol:243, :247, :251', () => {
    expect({ ...DEPLOY_LAUNCH_LTV }).toEqual({ sUSDS: 0.88, syrupUSDC: 0.86, scrvUSD: 0.86 })
    expect(membraneMaxLtv('sUSDS')).toBe(0.88)
    expect(membraneMaxLtv('syrupUSDC')).toBe(0.86)
    expect(membraneMaxLtv('scrvUSD')).toBe(0.86)
    expect(MEMBRANE_DEPLOY_LTV_PROVENANCE.kind).not.toBe('modelled')
    expect(MEMBRANE_DEPLOY_LTV_PROVENANCE.detail).toContain('DeployFullSystem.s.sol:243')
    expect(MEMBRANE_LTV_PROVENANCE.detail).toContain('except sUSDS, syrupUSDC and scrvUSD')
  })

  it('invents nothing for GHO; an all-GHO position has no line and is not run', () => {
    expect(membraneMaxLtv('GHO')).toBeNull()
    expect(weightedMembraneLine([{ symbol: 'GHO', valueUsd: 1 }]).maxLtv).toBe(0)
    expect(hasMembraneLine(['GHO'])).toBe(false)
    expect(hasMembraneLine(['GHO', 'USDC'])).toBe(true)
  })
})

describe('the user line stops at the position’s class cap', () => {
  it('96% when every collateral leg is stable, else 90%', () => {
    expect(positionLtvCap(['USDC', 'syrupUSDC'])).toBe(0.96)
    expect(positionLtvCap(['WETH'])).toBe(0.9)
    expect(positionLtvCap(['USDC', 'WETH'])).toBe(0.9)
    expect(clampMembraneLtv(0.99, ['USDC'])).toBe(0.96)
    expect(clampMembraneLtv(0.95, ['WETH'])).toBe(0.9)
    expect(clampMembraneLtv(0.95, ['USDC'])).toBe(0.95)
  })
})
