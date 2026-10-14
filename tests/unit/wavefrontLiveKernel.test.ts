/**
 * Live wavefront engine — kernel snapshots. A kernel saved mid-walk (through the state's JSON
 * codec) and restored continues exactly as the uninterrupted one: same records, same result —
 * on random paths, both classes, with sales and walk-on. A snapshot whose fields no longer match
 * the kernel's is refused.
 */
import { describe, expect, it } from 'vitest'

import { MembraneKernel, type KernelLeg, type KernelSpec } from '@/lib/wavefront/kernel'
import {
  KernelSchemaChanged,
  parseState,
  restoreKernel,
  snapshotKernel,
  stringifyState,
  type KernelSnapshot,
} from '@/lib/wavefront/live'

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function spec(r: () => number, noDelay: boolean): KernelSpec {
  const line = noDelay ? 0.93 : 0.8 + r() * 0.06
  const ltv0 = line * (1 + (r() - 0.3) * 0.05)
  const coll = 10_000 + r() * 1e6
  return {
    pid: 'aave-v3:base:0x01',
    collateral: [
      { key: 'a', symbol: 'WETH', value0: coll * 0.7 },
      { key: 'b', symbol: 'cbBTC', value0: coll * 0.3 },
    ],
    debt: [{ key: 'u', symbol: 'USDC', value0: coll * ltv0 }],
    line,
    noDelay,
    band: 0.04,
    delaySteps: 480,
    gap: 0.03,
    debtMinimum: 2000,
    maxSales: 20,
    t0Minute: 100,
    t0Ts: 1_700_000_040 + 6000 + 17,
    startTs: 1_700_000_040,
    stepSeconds: 60,
    lastMinute: Number.MAX_SAFE_INTEGER,
    walkOnAfterT0BandSale: r() < 0.5,
  }
}

describe('live engine: kernel snapshot / restore', () => {
  it('a restored kernel continues exactly like the uninterrupted one (200 random walks)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      const s = spec(r, seed % 5 === 0)
      const steps = 600
      const path: Record<string, number>[] = []
      let pa = 1
      let pb = 1
      for (let i = 0; i < steps; i++) {
        pa *= 1 + (r() - 0.5) * 0.02
        pb *= 1 + (r() - 0.5) * 0.02
        path.push({ a: pa, b: r() < 0.05 ? NaN : pb, u: 1 })
      }
      const ratio = (i: number) => (leg: KernelLeg) => {
        const v = path[i][leg.key]
        return Number.isFinite(v) ? v : null
      }
      const a = new MembraneKernel(s)
      const outA = [...a.start()]
      for (let i = 0; i < steps; i++) outA.push(...a.step(101 + i, ratio(i)))

      const cut = Math.floor(r() * steps)
      let b = new MembraneKernel(s)
      const outB = [...b.start()]
      for (let i = 0; i < cut; i++) outB.push(...b.step(101 + i, ratio(i)))
      const snap = parseState<KernelSnapshot>(stringifyState(snapshotKernel(b)))
      b = restoreKernel(s, snap)
      for (let i = cut; i < steps; i++) outB.push(...b.step(101 + i, ratio(i)))

      expect(outB, `seed ${seed}`).toEqual(outA)
      expect(b.result(), `seed ${seed}`).toEqual(a.result())
      expect(b.isDone).toBe(a.isDone)
      expect(b.armed).toBe(a.armed)
    }
  })

  it('refuses a snapshot whose fields do not match the kernel', () => {
    const s = spec(rng(7), false)
    const k = new MembraneKernel(s)
    k.start()
    const snap = snapshotKernel(k)
    const { debt, ...fields } = snap.fields
    void debt
    expect(() => restoreKernel(s, { ...snap, fields })).toThrow(KernelSchemaChanged)
    const { startedAt, ...timer } = snap.timer
    void startedAt
    expect(() => restoreKernel(s, { ...snap, timer })).toThrow(KernelSchemaChanged)
  })
})
