import { describe, expect, it } from 'vitest'

import {
  DATELINE_MAX_CHARS,
  DATELINE_SHORT_MAX_CHARS,
  datelineLabel,
  datelineShort,
  localIsoDate,
  regimeCredit,
  regimeRows,
  TAGLINE,
} from '@/components/Today/todayCopy'
import { M0_THRESHOLDS_FILE, type M0ThresholdsFile } from '@/lib/regime/thresholds'

// The Today edition's words: the dateline date and the method table, every figure read
// from the generated thresholds file.

describe('dateline date', () => {
  it('formats the local day with fixed names, never longer than the reserved slot', () => {
    expect(localIsoDate(new Date(2026, 9, 14, 23, 59))).toBe('2026-10-14')
    expect(datelineLabel('2026-10-14')).toBe('Wed 14 Oct 2026')
    expect(datelineLabel('2026-09-30')).toBe('Wed 30 Sep 2026')
    expect(datelineShort('2026-10-14')).toBe('14 Oct')
    expect(datelineShort('2026-10-04')).toBe('4 Oct')
    for (let m = 0; m < 12; m++) {
      for (const d of [1, 28]) {
        const iso = localIsoDate(new Date(2026, m, d))
        expect(datelineLabel(iso).length).toBeLessThanOrEqual(DATELINE_MAX_CHARS)
        expect(datelineShort(iso).length).toBeLessThanOrEqual(DATELINE_SHORT_MAX_CHARS)
      }
    }
  })
})

describe('method table', () => {
  it('reads every figure from the generated thresholds', () => {
    const rows = regimeRows()
    const v = (label: string) => rows.find((r) => r.label === label)?.value
    const T = M0_THRESHOLDS_FILE
    const count = (n: number) => n.toLocaleString('en-US')
    // p95 → 1 day in 20; p99.9 → 1 hour in 1,000 (from the file's level labels).
    expect(v('ETH 24h move')).toBe(
      `≥ ${(T.move24hP95 * 100).toFixed(2)}% · seen 1 day in 20 (${count(T.n.move24h)} hours)`,
    )
    expect(v('Chainlink vs Coinbase')).toBe(
      `≥ ${(T.gapP999 * 100).toFixed(2)}% apart · seen 1 hour in 1,000 (${count(T.n.gap)} hours)`,
    )
    expect(v('Liquidation volume')).toBe('Not counted — no live source')
    expect(v('Hold')).toBe('Holds 24h after the last trigger')
    expect(v('Withheld when')).toBe('an input is over 2h old, or under 20 of 24h have both prices')
    // No signed figure in the table prints a hyphen for a minus.
    for (const r of rows) expect(r.value).not.toMatch(/-\d/)
  })

  it('prints no percentile jargon or verdict words (owner, PR #106)', () => {
    for (const r of regimeRows()) {
      const text = `${r.label} ${r.value}`
      expect(text).not.toMatch(/\bp\d|percentile|quantile|\(n\b|\bn \d/i)
      expect(text).not.toMatch(/\b(safe|odds)\b/i)
    }
  })

  it('follows the file it is given', () => {
    const t = {
      ...M0_THRESHOLDS_FILE,
      move24hP95: 0.1,
      n: { move24h: 1234, gap: 5 },
      period: {
        ...M0_THRESHOLDS_FILE.period,
        from: '2021-03-01T00:00:00Z',
        to: '2025-12-31T23:00:00Z',
      },
      source: { ...M0_THRESHOLDS_FILE.source, sha256: 'abcdef0123456789'.repeat(4) },
    }
    const rows = regimeRows(t)
    expect(rows.find((r) => r.label === 'ETH 24h move')?.value).toBe(
      '≥ 10.00% · seen 1 day in 20 (1,234 hours)',
    )
    // The 1 in N follows the file's level: the p99 band on file would read 1 in 100.
    const p99 = { ...t, gapP999: t.gapP99, gapQuantile: 'p99' } as unknown as M0ThresholdsFile
    expect(regimeRows(p99).find((r) => r.label === 'Chainlink vs Coinbase')?.value).toBe(
      `≥ ${(t.gapP99 * 100).toFixed(2)}% apart · seen 1 hour in 100 (5 hours)`,
    )
    expect(rows.find((r) => r.label === 'History')?.value).toBe('hourly, 1 Mar 2021 – 31 Dec 2025')
    expect(regimeCredit(t)).toBe(
      'membrane-datasets price-history/eth-usd-1h.json · sha256 abcdef01 · measured',
    )
  })

  it('the tagline is the owner line on the guarantee band', () => {
    expect(TAGLINE).toBe('4%. Cross the line with time to spare.')
  })
})
