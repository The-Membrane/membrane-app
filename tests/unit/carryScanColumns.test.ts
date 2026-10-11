import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  apyToApr,
  carryAOf,
  carryBOf,
  carryBPair,
  checkedShare,
  reportedAtSize,
  SIZE_OVER_TVL_NOTE,
  venueColumnsFromLlama,
  WITH_REWARDS_NOTE,
} from '@/lib/carryScan/columns'
import { CARRY_SCAN_NOTES } from '@/lib/carryScan/copy'
import { formatCarryB, parseSharePct, ZERO_OR_FREE } from '@/lib/carryScan/format'
import { NOT_DEPLOYABLE_LABEL } from '@/lib/carryScan/readiness'
import {
  SIZE_KEYS,
  type BenchRef,
  type CarryScanFile,
  type LlamaPool,
  type Valued,
} from '@/lib/carryScan/types'
import { membraneSplit } from '@/lib/netApy/breakdown'
import { aprToApy } from '@/lib/netApy/fixedPoint'

const fallback = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile
const bench = (apy: number): BenchRef => ({
  venue: 'SparkLend USDC',
  stable: 'USDC',
  apy,
  labelClass: 'projected',
  source: 'onchain',
})
const valued = (apy: number): Valued => ({ apy, apr: apyToApr(apy), labelClass: 'projected' })

describe('(a) market carry', () => {
  it('is venue net at size minus the same-stable benchmark at that size', () => {
    expect(carryAOf(valued(0.07), bench(0.0437))).toEqual({
      apy: 0.07 - 0.0437,
      bound: 'exact',
      labelClass: 'projected',
    })
    expect(carryAOf(valued(0.07), null)).toBeNull()
    expect(
      carryAOf(
        { apy: null, apr: null, labelClass: 'projected', note: SIZE_OVER_TVL_NOTE },
        bench(0.04),
      ),
    ).toBeNull()
  })

  it('carries a label class: the weaker of the venue figure and the benchmark', () => {
    const reported: BenchRef = { ...bench(0.04), labelClass: 'reported', source: 'defillama' }
    expect(carryAOf(valued(0.07), reported)?.labelClass).toBe('reported')
    expect(carryAOf(valued(0.07), bench(0.04))?.labelClass).toBe('projected')
    const measured: Valued = { ...valued(0.07), labelClass: 'measured' }
    expect(carryAOf(measured, bench(0.04))?.labelClass).toBe('projected')
  })

  it('prices a DeFiLlama row at size as apy × TVL/(TVL+size), unpriced above 5% of TVL', () => {
    const v = reportedAtSize(0.06, 50e6, 1e6)
    expect(v.apy).toBeCloseTo((0.06 * 50e6) / 51e6, 15)
    expect(v.labelClass).toBe('projected')
    expect(reportedAtSize(0.06, 50e6, 10e6)).toMatchObject({ apy: null, note: SIZE_OVER_TVL_NOTE })
  })

  it('keeps a base-only figure beside the incentive-inclusive one', () => {
    const p = { apy: 6, apyBase: 5, apyReward: 1, tvlUsd: 50e6 } as LlamaPool
    const cols = venueColumnsFromLlama(p)
    expect(cols.venueNet['100k'].apy).toBeGreaterThan(cols.venueNetBase['100k'].apy!)
    expect(cols.venueNetBase['100k'].apy).toBeCloseTo((0.05 * 50e6) / (50e6 + 1e5), 15)
  })
})

describe('(b) Membrane carry', () => {
  it('goes through membraneSplit (the CuratorVault split) and has no borrow term', () => {
    const gain = valued(0.06)
    const share = { protocolShare: 0.1, curatorShare: 0.2 }
    const b = carryBOf(gain, share)
    expect(b.apy).toBeCloseTo(aprToApy(membraneSplit(gain.apr!, share).user), 15)
    expect(b.bound).toBe('exact')
  })

  it('carries the gain’s label class, priced or not', () => {
    expect(carryBOf(valued(0.06)).labelClass).toBe('projected')
    expect(carryBOf({ apy: null, apr: null, labelClass: 'reported' }).labelClass).toBe('reported')
    const pair = carryBPair(valued(0.05), { ...valued(0.065), labelClass: 'reported' })
    expect([pair.base.labelClass, pair.withRewards.labelClass]).toEqual(['projected', 'reported'])
  })

  it('is an upper bound when no share is given: the whole gain', () => {
    const b = carryBOf(valued(0.06))
    expect(b).toMatchObject({ bound: 'upper' })
    expect(b.apy).toBeCloseTo(0.06, 12)
  })

  it('throws on a share of 0 — it would print as a 0% Membrane charge', () => {
    expect(() => carryBOf(valued(0.06), { protocolShare: 0 })).toThrow(RangeError)
    expect(() => checkedShare({ curatorShare: 0 })).toThrow(/omit it to show "curator-set"/)
    expect(parseSharePct('0').error).toBeTruthy()
    expect(parseSharePct('')).toEqual({})
    expect(parseSharePct('12.5%').value).toBeCloseTo(0.125, 12)
  })

  it('owner Q2: shows base-only AND with-rewards, the latter labelled "if vaults claim rewards (not yet)"', () => {
    const pair = carryBPair(valued(0.05), valued(0.065))
    expect(pair.withRewards.note).toBe(WITH_REWARDS_NOTE)
    expect(WITH_REWARDS_NOTE).toBe('if vaults claim rewards (not yet)')
    expect(pair.base.apy!).toBeLessThan(pair.withRewards.apy!)
  })

  it('rendered (b) never states a zero or "free" charge', () => {
    const shown: string[] = []
    for (const v of [0, 1e-7, 0.00004, 0.0001, 0.001, 0.0099, 0.01, 0.1, 0.103, 0.25]) {
      shown.push(formatCarryB(carryBOf(valued(v))))
      shown.push(formatCarryB(carryBOf(valued(v), { protocolShare: 0.5, curatorShare: 0.5 })))
    }
    for (const r of fallback.rows)
      for (const k of SIZE_KEYS)
        shown.push(formatCarryB(r.carryB[k].base), formatCarryB(r.carryB[k].withRewards))
    for (const s of shown) expect(s).not.toMatch(ZERO_OR_FREE)
    // ...and the guard itself catches what it must, without flagging 10% or 4.30%.
    for (const bad of ['0%', '≤ 0.00%', '$0', 'free', 'Interest-free'])
      expect(bad).toMatch(ZERO_OR_FREE)
    for (const ok of ['≤ 10.00% · curator-set', '≤ 4.30% · curator-set', '$0.50', '$10'])
      expect(ok).not.toMatch(ZERO_OR_FREE)
  })
})

describe('fine print', () => {
  // "pays no interest" reads as "interest-free": Membrane is paid by a curator-set share of
  // venue yield (components/Simulator/FinePrint.tsx CARRY_TERMS), so say that instead.
  const NO_INTEREST = /\bno interest\b|interest[- ]free/i
  it('the notes never state a zero, free or interest-free charge — in the code or the snapshot', () => {
    for (const n of [...CARRY_SCAN_NOTES, ...fallback.notes]) {
      expect(n).not.toMatch(ZERO_OR_FREE)
      expect(n).not.toMatch(NO_INTEREST)
    }
    expect(CARRY_SCAN_NOTES.some((n) => /curator-set share/.test(n))).toBe(true)
  })

  it('every carry figure in the snapshot carries a label class', () => {
    for (const r of fallback.rows)
      for (const k of SIZE_KEYS) {
        if (r.carryA[k]) expect(r.carryA[k]!.labelClass).toBeTruthy()
        if (r.carryABase[k]) expect(r.carryABase[k]!.labelClass).toBeTruthy()
        expect(r.carryB[k].base.labelClass).toBeTruthy()
        expect(r.carryB[k].withRewards.labelClass).toBeTruthy()
      }
  })
})

describe('owner answers in the published snapshot (public/data/carry-scan-fallback.json)', () => {
  it('Q1: (b) is shown for ALL rows, every size, with no "no coverage" caveat', () => {
    expect(fallback.rows.length).toBeGreaterThan(0)
    for (const r of fallback.rows)
      for (const k of SIZE_KEYS) {
        expect(r.carryB[k].base).toBeDefined()
        expect(r.carryB[k].withRewards.note).toBe(WITH_REWARDS_NOTE)
      }
    expect(JSON.stringify(fallback)).not.toMatch(/no coverage|Cdp rate applies|scout intake/i)
  })

  it('Q3: every stable with a benchmark is ranked on (a); non-USDC rows are greyed "not deployable yet"', () => {
    const ranked = fallback.rows.filter((r) => r.list === 'ranked')
    expect(ranked.length).toBeGreaterThan(0)
    for (const r of ranked) {
      expect(r.bench['100k']).not.toBeNull()
      expect(r.stables).toContain(r.bench['100k']!.stable)
      if (r.stable !== 'USDC') {
        expect(r.readiness.tier).toBe('not-deployable')
        expect(r.readiness.route).toBe(NOT_DEPLOYABLE_LABEL)
      }
    }
  })

  it('Q3: stables with no benchmark are unranked with (b) only — never another stable’s rate', () => {
    for (const r of fallback.rows.filter((x) => x.list === 'no-benchmark')) {
      expect(r.rank).toBeNull()
      for (const k of SIZE_KEYS) {
        expect(r.bench[k]).toBeNull()
        expect(r.carryA[k]).toBeNull()
        // (b) is priced wherever the size is (≤ 5% of TVL); above that it carries the reason.
        if (r.carryB[k].base.apy === null) expect(r.carryB[k].base.note).toBe(SIZE_OVER_TVL_NOTE)
      }
      expect(r.carryB['100k'].base.apy).not.toBeNull()
    }
    // Any benchmark on any row is one of that row's own stables.
    for (const r of fallback.rows)
      for (const k of SIZE_KEYS) if (r.bench[k]) expect(r.stables).toContain(r.bench[k]!.stable)
  })
})
