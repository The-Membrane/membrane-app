/**
 * Network-gated end-to-end smoke test. Runs only with ORACLE_MANIP_LIVE=1 so CI stays
 * hermetic. It re-reads the PT-reUSD leaf live and asserts the pipeline still produces a
 * verdict with its two Morpho readers — i.e. the mainnet shapes the engine depends on
 * (Pendle readState, the Ojo min-wrapper, Morpho oracle decode) have not drifted.
 */

import { describe, it, expect } from 'vitest'
import { Rpc } from '@/lib/oracleRegistry/manipulation/chain/rpc'
import { analyzeOneLeaf } from '@/lib/oracleRegistry/manipulation/analyzeOne'

const LIVE = process.env.ORACLE_MANIP_LIVE === '1'

describe.skipIf(!LIVE)('PT-reUSD live pipeline', () => {
  it('finds the two Morpho readers and returns a verdict', async () => {
    const rpc = new Rpc()
    const out = await analyzeOneLeaf(rpc, '0x13285bcbc27f92b47b4edb99d744c07b48c977c0', 'latest', { volClass: 'stable', minBorrowUsd: 1_000_000 })
    expect(out).not.toBeNull()
    const c = out!.card
    expect(c.kind).toBe('pendle-market')
    expect(c.readerCount).toBeGreaterThanOrEqual(2)
    expect(c.trees.some((t) => t.includes('min(') && t.includes('twap'))).toBe(true)
    expect(['red', 'yellow', 'green']).toContain(c.verdict)
    // The leaf is a 900s Pendle TWAP against a thin pool behind a nine-figure book:
    // it must not read green while that book exists.
    expect(c.verdict).not.toBe('green')
  }, 180_000)
})
