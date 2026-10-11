import { describe, expect, it } from 'vitest'

import { coveredBlocks, formatScorecard, pieceVerdicts, scorecard, type LedgerRow } from '@/lib/position-sim/rpcScorecard'

const row = (o: Partial<LedgerRow>): LedgerRow => ({
  piece: 1,
  host: 'a.example',
  role: 'first',
  outcome: 'logs',
  logs: 10,
  ms: 100,
  verdict: 'single',
  contradicted: false,
  fromBlock: 0n,
  toBlock: 9_999n,
  ...o,
})

describe('rpc scorecard', () => {
  it('rates a host only over answers a second endpoint checked', () => {
    const rows = [
      // pocket: 4 empties, 3 checked, 2 of those false; 1 empty unverified; 1 spot-checked short answer.
      row({ piece: 1, host: 'pocket', outcome: 'empty', logs: 0, verdict: 'recovered', contradicted: true }),
      row({ piece: 1, host: 'tenderly', role: 'recheck', verdict: 'recovered' }),
      row({ piece: 2, host: 'pocket', outcome: 'empty', logs: 0, verdict: 'recovered', contradicted: true }),
      row({ piece: 2, host: 'tenderly', role: 'recheck', verdict: 'recovered' }),
      row({ piece: 3, host: 'pocket', outcome: 'empty', logs: 0, verdict: 'agreed' }),
      row({ piece: 3, host: 'tenderly', role: 'recheck', outcome: 'empty', logs: 0, verdict: 'agreed' }),
      row({ piece: 4, host: 'pocket', outcome: 'empty', logs: 0, verdict: 'unverified' }),
      row({ piece: 5, host: 'pocket', verdict: 'recovered', contradicted: true, logs: 3 }),
      row({ piece: 5, host: 'tenderly', role: 'spot', verdict: 'recovered' }),
      row({ piece: 6, host: 'pocket', verdict: 'single' }),
      // an error, then the piece fails
      row({ piece: 7, host: 'tenderly', outcome: 'error', logs: 0, ms: 5, verdict: 'failed' }),
    ]
    const by = Object.fromEntries(scorecard(rows).map((s) => [s.host, s]))

    expect(by.pocket).toMatchObject({
      calls: 6, errors: 0, answers: 6, empty: 4,
      emptyChecked: 3, falseEmpty: 2, falseEmptyRate: 2 / 3,
      logsChecked: 1, short: 1, shortRate: 1,
      blocks: 60_000,
    })
    expect(by.tenderly).toMatchObject({
      calls: 5, errors: 1, errorRate: 0.2, answers: 4, empty: 1,
      emptyChecked: 1, falseEmpty: 0, falseEmptyRate: 0, logsChecked: 3, short: 0, shortRate: 0,
    })
    expect(pieceVerdicts(rows)).toEqual({ agreed: 1, recovered: 3, single: 1, unverified: 1, failed: 1 })
    expect(formatScorecard(scorecard(rows)).split('\n')).toHaveLength(3)
  })

  it('says null, not zero, when nothing was checked', () => {
    const [s] = scorecard([row({ verdict: 'single' }), row({ piece: 2, outcome: 'empty', logs: 0, verdict: 'unverified' })])
    expect(s.falseEmptyRate).toBeNull()
    expect(s.shortRate).toBeNull()
  })

  it('keeps runs apart when grouping pieces', () => {
    const rows = [row({ run: 'r1', piece: 1, verdict: 'agreed' }), row({ run: 'r2', piece: 1, verdict: 'single' })]
    expect(pieceVerdicts(rows)).toMatchObject({ agreed: 1, single: 1 })
  })

  it('counts covered blocks once across overlapping and adjacent ranges', () => {
    expect(
      coveredBlocks([
        { fromBlock: 100n, toBlock: 199n },
        { fromBlock: 150n, toBlock: 249n },
        { fromBlock: 250n, toBlock: 299n },
        { fromBlock: 1_000n, toBlock: 1_009n },
      ]),
    ).toBe(210n)
    expect(coveredBlocks([])).toBe(0n)
  })
})
