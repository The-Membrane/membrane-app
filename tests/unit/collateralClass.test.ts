// lib/position-sim/collateralClass.ts — THE one definition of stable collateral and of the
// Membrane delay class, read by both the Oct 10 census (scripts/build-evidence.ts) and the
// per-address simulator (lib/position-sim/compare.ts, scenario.ts).
//
// Contract truth it mirrors (membrane-solidity master 16e12329): the class is DERIVED from a
// listing's immutable max_ltv_cap — `_noDelay(cap) = cap > MAX_LTV_HARD_CAP`
// (Collateral.sol:424-426) — and a position may not mix the classes (Cdp.sol:1650-1651).

import { describe, expect, it } from 'vitest'

import {
  MEASURED_STABLES,
  NO_DELAY_LTV_HARD_CAP,
  OFF_PEG_STABLES,
  STABLE_SYMBOLS,
  delayClassOf,
  YIELD_BEARING_STABLES,
  hardCapFor,
  heldAtOne,
  heldAtReadPrice,
  heldFlat,
  isNoDelayCollateral,
  isStable,
  lineIsNoDelay,
} from '@/lib/position-sim/collateralClass'
import { MAX_LTV_HARD_CAP, MEMBRANE_ASSET_LTV, membraneMaxLtv } from '@/lib/position-sim/membrane'
import { HELD_AT_ONE } from '@/lib/position-sim/scenario'

describe('the stable definition', () => {
  it('is the union of the two old lists, the deploy launch stables and the synthetic dollars', () => {
    const oldHeldAtOne = ['USDC', 'USDT', 'DAI', 'USDS', 'GHO', 'sDAI', 'sUSDS']
    const oldCensusStables = [
      'USDC',
      'USDT',
      'USD₮0',
      'USDT0',
      'DAI',
      'GHO',
      'LUSD',
      'USDS',
      'sUSD',
      'FRAX',
      'USDC.e',
      'crvUSD',
      'MAI',
      'USDbC',
    ]
    // DeployFullSystem.s.sol:269-271 lists sUSDS, syrupUSDC and scrvUSD at the 96% cap.
    const deployLaunchStables = ['sUSDS', 'syrupUSDC', 'scrvUSD']
    const union = new Set([
      ...oldHeldAtOne,
      ...oldCensusStables,
      ...deployLaunchStables,
      'USDe',
      'sUSDe',
    ])
    expect(new Set(STABLE_SYMBOLS)).toEqual(union)
    expect(STABLE_SYMBOLS.length).toBe(union.size)
  })

  it('holds the yield-bearing receipts flat at their read price, not at $1', () => {
    // syrupUSDC reads ~$1.12: a $1.00 pin would mark it ~11% under and sell it at minute 0.
    expect([...YIELD_BEARING_STABLES]).toEqual(['sDAI', 'sUSDS', 'syrupUSDC', 'scrvUSD'])
    for (const s of YIELD_BEARING_STABLES) {
      expect(heldAtOne(s)).toBe(false)
      expect(heldAtReadPrice(s)).toBe(true)
      expect(heldFlat(s)).toBe(true)
      expect(HELD_AT_ONE).not.toContain(s)
      expect(isNoDelayCollateral(s)).toBe(true)
    }
    expect(heldAtReadPrice('USDC')).toBe(false)
    expect(heldFlat('USDC')).toBe(true)
    expect(heldFlat('USDe')).toBe(false)
  })

  it('keeps USDe and sUSDe stable for the class but measured, never held at $1', () => {
    expect([...MEASURED_STABLES]).toEqual(['USDe', 'sUSDe'])
    for (const s of MEASURED_STABLES) {
      expect(isStable(s)).toBe(true)
      expect(isNoDelayCollateral(s)).toBe(true)
      expect(heldAtOne(s)).toBe(false)
    }
  })

  it('keeps sUSD stable for the class but off its peg: not held at $1, and unpriced', () => {
    expect([...OFF_PEG_STABLES]).toEqual(['sUSD'])
    expect(isStable('sUSD')).toBe(true)
    expect(isNoDelayCollateral('sUSD')).toBe(true)
    expect(heldAtOne('sUSD')).toBe(false)
  })

  it('is what scenario.ts HELD_AT_ONE is derived from', () => {
    expect([...HELD_AT_ONE]).toEqual(STABLE_SYMBOLS.filter((s) => heldAtOne(s)))
    expect(HELD_AT_ONE).not.toContain('USDe')
  })

  it('treats every volatile or unknown symbol as delayed collateral', () => {
    for (const s of ['WETH', 'wstETH', 'WBTC', 'cbBTC', 'LINK', 'AAVE', 'NOT_A_TOKEN']) {
      expect(isStable(s)).toBe(false)
      expect(isNoDelayCollateral(s)).toBe(false)
    }
  })
})

describe('lineIsNoDelay', () => {
  it('is strict at the 90% hard cap, like Collateral.sol:425', () => {
    expect(MAX_LTV_HARD_CAP).toBe(0.9)
    expect(lineIsNoDelay(0.9)).toBe(false)
    expect(lineIsNoDelay(0.9000001)).toBe(true)
    expect(lineIsNoDelay(0.85)).toBe(false)
    expect(lineIsNoDelay(0.96)).toBe(true)
  })
})

describe('delayClassOf', () => {
  it('classes all-stable collateral as no-delay', () => {
    expect(delayClassOf(['USDC'])).toBe('no-delay')
    expect(delayClassOf(['USDC', 'DAI', 'USDC'], 0.8)).toBe('no-delay')
  })

  it('classes volatile collateral as delayed unless its line is above 90%', () => {
    expect(delayClassOf(['WETH'], 0.8)).toBe('delayed')
    expect(delayClassOf(['WETH'], 0.9)).toBe('delayed')
    expect(delayClassOf(['WETH'], 0.95)).toBe('no-delay')
    expect(delayClassOf(['WETH'])).toBe('delayed')
  })

  it('calls stable + volatile mixed, whatever the line', () => {
    expect(delayClassOf(['WETH', 'USDC'])).toBe('mixed')
    expect(delayClassOf(['USDe', 'wstETH'], 0.95)).toBe('mixed')
  })

  it('judges an empty symbol list on the line alone', () => {
    expect(delayClassOf([], 0.91)).toBe('no-delay')
    expect(delayClassOf([], 0.9)).toBe('delayed')
    expect(delayClassOf([])).toBe('delayed')
  })
})

describe('the class hard caps', () => {
  it('caps a no-delay listing at 96% and a delayed one at 90% (lib/Constants.sol:23,32)', () => {
    expect(NO_DELAY_LTV_HARD_CAP).toBe(0.96)
    expect(hardCapFor('USDC')).toBe(NO_DELAY_LTV_HARD_CAP)
    expect(hardCapFor('WETH')).toBe(MAX_LTV_HARD_CAP)
  })

  it('is the clamp membraneMaxLtv applies', () => {
    for (const sym of Object.keys(MEMBRANE_ASSET_LTV)) {
      expect(membraneMaxLtv(sym)).toBeLessThanOrEqual(hardCapFor(sym))
    }
    const saved = { WETH: MEMBRANE_ASSET_LTV.WETH, USDC: MEMBRANE_ASSET_LTV.USDC }
    try {
      MEMBRANE_ASSET_LTV.WETH = 0.99
      MEMBRANE_ASSET_LTV.USDC = 0.99
      expect(membraneMaxLtv('WETH')).toBe(0.9)
      expect(membraneMaxLtv('USDC')).toBe(0.96)
    } finally {
      MEMBRANE_ASSET_LTV.WETH = saved.WETH
      MEMBRANE_ASSET_LTV.USDC = saved.USDC
    }
  })
})
