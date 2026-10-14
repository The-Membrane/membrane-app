import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'

import { M0_THRESHOLDS, M0_THRESHOLDS_FILE as T } from '@/lib/regime/thresholds'
// The builder's own statistics, so the test recomputes exactly what it wrote.
import { m0Thresholds, quantileSorted } from '@/scripts/regime/m0Stats.mjs'

// The generated thresholds file (scripts/regime/build-m0-thresholds.mjs) against its
// source in the private datasets repo ($MEMBRANE_DATASETS_DIR or ../membrane-datasets,
// board rule N18). The source checks are skipped when the datasets clone is absent.

const DIR = resolve(
  process.env.MEMBRANE_DATASETS_DIR || join(process.cwd(), '..', 'membrane-datasets'),
)
const FILE = join(DIR, T.source.path)
const has = existsSync(FILE)

describe('quantileSorted (type 7)', () => {
  it('interpolates between order statistics', () => {
    const x = [1, 2, 3, 4, 5]
    expect(quantileSorted(x, 0)).toBe(1)
    expect(quantileSorted(x, 1)).toBe(5)
    expect(quantileSorted(x, 0.5)).toBe(3)
    // h = 4 × 0.95 = 3.8 → 4 + 0.8 × (5 − 4)
    expect(quantileSorted(x, 0.95)).toBeCloseTo(4.8, 12)
    expect(quantileSorted([7], 0.999)).toBe(7)
    expect(() => quantileSorted([], 0.5)).toThrow()
  })
})

describe('m0Thresholds.generated.json', () => {
  it('is internally consistent', () => {
    expect(T.gapP999).toBeGreaterThan(T.gapP99)
    expect(T.gapP99).toBeGreaterThan(0)
    expect(T.move24hP95).toBeGreaterThan(0)
    expect(T.move24hP95).toBeLessThan(1)
    expect(T.gapQuantile).toBe('p99.9')
    expect(T.n.move24h).toBeGreaterThan(50_000)
    expect(T.n.gap).toBeGreaterThan(50_000)
    expect(Date.parse(T.period.from)).toBeLessThan(Date.parse(T.period.to))
    expect(T.source.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(T.source.commit).toMatch(/^[0-9a-f]{40}$/)
    // The rule reads the p99.9 band.
    expect(M0_THRESHOLDS).toEqual({ move24hP95: T.move24hP95, gapBand: T.gapP999 })
  })

  describe.skipIf(!has)('against the datasets clone', () => {
    it("records the sha256 that PROVENANCE.md lists for the file, and the file's own", () => {
      const prov = readFileSync(join(DIR, 'price-history', 'PROVENANCE.md'), 'utf8')
      const row = prov.split('\n').find((l) => l.includes('`eth-usd-1h.json`'))
      expect(row?.match(/`([0-9a-f]{64})`/)?.[1]).toBe(T.source.sha256)
      const sha = createHash('sha256').update(readFileSync(FILE)).digest('hex')
      expect(sha).toBe(T.source.sha256)
    })

    it('recomputes to the recorded quantiles and sample sizes', () => {
      const doc = JSON.parse(readFileSync(FILE, 'utf8'))
      const t = m0Thresholds({
        startTs: doc.startTs,
        stepSeconds: doc.stepSeconds,
        oracle: doc.columns.oracle,
        coinbase: doc.columns.coinbase,
      })
      expect(t.move24hP95).toBe(T.move24hP95)
      expect(t.gapP99).toBe(T.gapP99)
      expect(t.gapP999).toBe(T.gapP999)
      expect(t.n).toEqual(T.n)
    })
  })
})
