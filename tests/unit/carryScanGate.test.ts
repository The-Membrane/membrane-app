import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkBenchmarks,
  checkChurn,
  checkUniverseCount,
  checkVerification,
} from '@/lib/carryScan/gate'
import { readPastWeeks, writeOutcome } from '@/lib/carryScan/publish'
import { isoWeek, runCarryScan } from '@/lib/carryScan/scan'
import type { BenchmarkTable } from '@/lib/carryScan/types'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'carry-scan-test-'))
  dirs.push(d)
  return d
}

describe('the fail-closed publish gate', () => {
  it('a mocked source failure leaves latest.json untouched and writes only status.json', async () => {
    const out = tmp()
    const live = { schemaVersion: 1, week: '2026-W40', asOf: 1, rows: [] }
    writeFileSync(join(out, 'latest.json'), JSON.stringify(live))
    writeFileSync(
      join(out, 'status.json'),
      JSON.stringify({
        lastAttempt: 1,
        week: '2026-W40',
        ok: true,
        reason: null,
        lastGoodWeek: '2026-W40',
      }),
    )
    const before = readFileSync(join(out, 'latest.json'), 'utf8')

    const nowMs = Date.UTC(2026, 9, 12, 6, 17)
    const outcome = await runCarryScan({
      fetch: (async () => new Response('upstream down', { status: 503 })) as typeof fetch,
      rpc: () => {
        throw new Error('the RPC must not be reached when a source fails')
      },
      nowMs: () => nowMs,
      appSha: null,
      pastWeeks: [],
      lastLatest: null,
      acceptChurn: false,
      sleep: async () => {},
      fetchMerkl: async () => [],
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toMatch(/^gate 1: source failed/)

    const { code, status } = writeOutcome(out, outcome, nowMs, isoWeek(nowMs))
    expect(code).toBe(1)
    expect(readFileSync(join(out, 'latest.json'), 'utf8')).toBe(before)
    expect(existsSync(join(out, 'weeks'))).toBe(false)
    expect(status).toMatchObject({ ok: false, week: '2026-W42', lastGoodWeek: '2026-W40' })
    expect(JSON.parse(readFileSync(join(out, 'status.json'), 'utf8')).reason).toMatch(/HTTP 503/)
  })

  it('a held result also writes only status.json, with held=true and exit code 2', () => {
    const out = tmp()
    writeFileSync(join(out, 'latest.json'), '{"keep":true}')
    const file = { week: '2026-W42' } as never
    const { code, status } = writeOutcome(
      out,
      { kind: 'held', reason: 'gate 4 (churn): 20 NEW rows (> 15)', file, benchmarks: {} as never },
      Date.now(),
      '2026-W42',
    )
    expect(code).toBe(2)
    expect(status.held).toBe(true)
    expect(readFileSync(join(out, 'latest.json'), 'utf8')).toBe('{"keep":true}')
  })

  it('reads back only well-formed weekly files, oldest first', () => {
    const out = tmp()
    mkdirSync(join(out, 'weeks'))
    writeFileSync(
      join(out, 'weeks', '2026-W40.json'),
      JSON.stringify({
        week: '2026-W40',
        rows: [{ key: '1:0xab', list: 'ranked' }],
        counts: { ranked: 1 },
      }),
    )
    writeFileSync(
      join(out, 'weeks', '2026-W39.json'),
      JSON.stringify({ week: '2026-W39', rows: [] }),
    )
    writeFileSync(join(out, 'weeks', 'notes.txt'), 'x')
    expect(readPastWeeks(out).map((w) => w.week)).toEqual(['2026-W39', '2026-W40'])
  })
})

describe('gate checks', () => {
  it('1: the Ethereum stablecoin pool count within ±30% of last week (1,313 baseline)', () => {
    expect(checkUniverseCount(1315, null).ok).toBe(true)
    expect(checkUniverseCount(800, null).ok).toBe(false)
    expect(checkUniverseCount(1700, 1313).ok).toBe(true)
    expect(checkUniverseCount(1800, 1313).ok).toBe(false)
  })

  it('2: USDC, USDT, USDS and DAI need a benchmark; USDC/USDT sources must agree within 0.5pp', () => {
    const ref = (s: string) => ({
      venue: 'v',
      stable: s,
      apy: 0.04,
      labelClass: 'reported' as const,
      source: 'defillama' as const,
    })
    const table: BenchmarkTable = {}
    for (const s of ['USDC', 'USDT', 'USDS', 'DAI'])
      table[s] = { bySize: { '100k': ref(s), '1m': ref(s), '10m': null }, candidates: [] }
    expect(checkBenchmarks(table, {}).ok).toBe(true)
    expect(checkBenchmarks(table, { USDC: { diffPp: 0.6 } })).toMatchObject({ ok: false })
    const noDai = {
      ...table,
      DAI: { ...table.DAI, bySize: { '100k': null, '1m': null, '10m': null } },
    }
    expect(checkBenchmarks(noDai, {})).toEqual({
      ok: false,
      reason: 'gate 2: no eligible borrow benchmark for DAI',
    })
  })

  it('3: at least half the finalists checked on-chain must verify', () => {
    expect(checkVerification(20, 10).ok).toBe(true)
    expect(checkVerification(20, 9).ok).toBe(false)
    expect(checkVerification(0, 0).ok).toBe(true)
  })

  it('3: finalists with not one resolved address fail closed (resolution itself broke)', () => {
    expect(checkVerification(0, 0, 41)).toEqual({
      ok: false,
      reason: 'gate 3: none of 41 finalists resolved to an address',
    })
    expect(checkVerification(0, 0, 0).ok).toBe(true)
    expect(checkVerification(19, 16, 41).ok).toBe(true)
  })

  it('4: churn holds the result until accept_churn; the baseline run (no history) is exempt', () => {
    expect(checkChurn(16, 20, 18, false).held).toBe(true)
    expect(checkChurn(3, 31, 20, false).held).toBe(true)
    expect(checkChurn(3, 29, 20, false).held).toBe(false)
    expect(checkChurn(16, 20, 18, true)).toMatchObject({ held: false })
    expect(checkChurn(40, 40, null, false).held).toBe(false)
  })

  it('ISO weeks', () => {
    expect(isoWeek(Date.UTC(2026, 9, 10))).toBe('2026-W41')
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe('2026-W53')
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe('2026-W01')
  })
})
