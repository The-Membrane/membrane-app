import { describe, expect, it } from 'vitest'

import {
  DATELINE_MAX_CHARS,
  datelineLabel,
  localIsoDate,
  regimeCredit,
  regimeRows,
  TAGLINE,
} from '@/components/Today/todayCopy'
import { M0_THRESHOLDS_FILE } from '@/lib/regime/thresholds'

// The Today edition's words: the dateline date and the method table, every figure read
// from the generated thresholds file.

describe('dateline date', () => {
  it('formats the local day with fixed names, never longer than the reserved slot', () => {
    expect(localIsoDate(new Date(2026, 9, 14, 23, 59))).toBe('2026-10-14')
    expect(datelineLabel('2026-10-14')).toBe('Wed 14 Oct 2026')
    expect(datelineLabel('2026-09-30')).toBe('Wed 30 Sep 2026')
    for (let m = 0; m < 12; m++) {
      for (const d of [1, 28]) {
        const label = datelineLabel(localIsoDate(new Date(2026, m, d)))
        expect(label.length).toBeLessThanOrEqual(DATELINE_MAX_CHARS)
      }
    }
  })
})

describe('method table', () => {
  it('reads every figure from the generated thresholds', () => {
    const rows = regimeRows()
    const v = (label: string) => rows.find((r) => r.label === label)?.value
    expect(v('ETH 24h move')).toBe(
      `≥ ${(M0_THRESHOLDS_FILE.move24hP95 * 100).toFixed(2)}% (p95) · n ${M0_THRESHOLDS_FILE.n.move24h.toLocaleString('en-US')}`,
    )
    expect(v('Chainlink vs Coinbase')).toContain(
      `${(M0_THRESHOLDS_FILE.gapP999 * 100).toFixed(2)}% apart (p99.9)`,
    )
    expect(v('Liquidation volume')).toBe('Not counted — no live source')
    expect(v('Hold')).toBe('Holds 24h after the last trigger')
    expect(v('Withheld when')).toBe('an input is over 2h old, or under 20 of 24h have both prices')
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
    expect(rows.find((r) => r.label === 'ETH 24h move')?.value).toBe('≥ 10.00% (p95) · n 1,234')
    expect(rows.find((r) => r.label === 'History')?.value).toBe('hourly, 1 Mar 2021 – 31 Dec 2025')
    expect(regimeCredit(t)).toBe(
      'membrane-datasets price-history/eth-usd-1h.json · sha256 abcdef01 · measured',
    )
  })

  it('the tagline is the owner line on the guarantee band', () => {
    expect(TAGLINE).toBe('4%. Cross the line with time to spare.')
  })
})
