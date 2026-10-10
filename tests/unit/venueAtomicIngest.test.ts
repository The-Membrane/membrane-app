import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildAtomicVenueEvents,
  commitAtomicVenueSnapshot,
  isAtomicFinalizedSource,
} from '../../scripts/lib/venue-atomic-ingest.mjs'

const HASH = `0x${'a'.repeat(64)}`
const sealed = (
  block: bigint,
  values: Record<string, unknown> = {},
  instantUsd: number | null = 100,
) => ({
  id: block === 100n ? '11111111-1111-4111-8111-111111111111' : undefined,
  block,
  instant_usd: instantUsd,
  instantUsd,
  recorder_atomic_v1: true,
  coolingUsd: null,
  strandedUsd: null,
  params: {
    ...values,
    read_block_finalized: true,
    read_block_pinned: true,
    read_block_number: String(block),
    read_block_hash: HASH,
    read_block_time: 1_780_000_000,
  },
})

describe('venue atomic-v1 event payload', () => {
  it('starts with a quiet baseline and rejects unsealed/nonmonotonic comparisons', () => {
    const next = sealed(101n, { cooldownDuration: 100 }, 120)
    expect(buildAtomicVenueEvents(null, next)).toEqual([])
    expect(isAtomicFinalizedSource(next)).toBe(true)
    expect(() =>
      buildAtomicVenueEvents({ ...sealed(100n), recorder_atomic_v1: null }, next),
    ).toThrow('legacy_predecessor')
    expect(() => buildAtomicVenueEvents({ ...sealed(100n), params: {} }, next)).toThrow('unsealed')
    expect(() => buildAtomicVenueEvents(sealed(101n), next)).toThrow('nonmonotonic')
  })

  it('emits discrete terms and both directions of >20% instant capacity', () => {
    const previous = sealed(100n, { cooldownDuration: 100, totalAssets: '100' }, 100)
    const up = sealed(101n, { cooldownDuration: 200, totalAssets: '119' }, 121)
    expect(buildAtomicVenueEvents(previous, up)).toEqual([
      {
        kind: 'cooldown_duration_changed',
        prev: { cooldownDuration: 100 },
        next: { cooldownDuration: 200 },
        note: 'cooldownDuration: 100 -> 200',
      },
      {
        kind: 'instant_liquidity_shift',
        prev: { instant_usd: 100 },
        next: { instant_usd: 121 },
        note: 'instant_usd 21.0%',
      },
    ])
    expect(buildAtomicVenueEvents(sealed(100n, {}, 100), sealed(101n, {}, 79))).toMatchObject([
      { kind: 'instant_liquidity_shift', note: 'instant_usd -21.0%' },
    ])
  })

  it('does not turn missing readings, source stamps, or exactly 20% into news', () => {
    const previous = sealed(100n, { silo: 'old', totalAssets: '100' }, 100)
    const next = sealed(101n, { totalAssets: '120' }, 120)
    next.params.read_block_hash = `0x${'b'.repeat(64)}`
    expect(buildAtomicVenueEvents(previous, next)).toEqual([])
  })

  it('sends no caller event payload and returns the database conflict status', async () => {
    const calls: { query: string; values: unknown[] }[] = []
    const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ query: parts.join('?'), values })
      return [
        { result: { status: 'conflict', predecessor_id: '22222222-2222-4222-8222-222222222222' } },
      ]
    }
    const previous = sealed(100n, {}, 100)
    const result = await commitAtomicVenueSnapshot(sql, {
      venue: 'sUSDe',
      previous,
      next: sealed(101n, {}, 121),
    })
    expect(result.status).toBe('conflict')
    expect(calls).toHaveLength(1)
    expect(calls[0].query).toContain('ingest_venue_snapshot_atomic_v1(')
    expect(calls[0].values).toHaveLength(8)
    expect(calls[0].values.at(-1)).toBe(previous.id)
    expect(calls[0].values).not.toContain('instant_liquidity_shift')
  })
})

describe('additive migration contract (static; not a DB concurrency test)', () => {
  const ddl = readFileSync(
    fileURLToPath(new URL('../../scripts/apply-venue-recorder-atomic-ddl.mjs', import.meta.url)),
    'utf8',
  )
  it('leaves legacy rows nullable and gives marked venue/block rows a partial unique key', () => {
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS recorder_atomic_v1 boolean')
    expect(ddl).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS venue_snapshots_atomic_v1_venue_chain_block_idx/,
    )
    expect(ddl).toContain('WHERE recorder_atomic_v1 IS TRUE')
    expect(ddl).not.toMatch(/UPDATE venue_snapshots SET recorder_atomic_v1/)
  })
  it('serializes, re-reads, CAS-checks, validates source, and derives events inside the function', () => {
    expect(ddl).toContain('CREATE OR REPLACE FUNCTION ingest_venue_snapshot_atomic_v1(')
    expect(ddl).toContain('pg_advisory_xact_lock')
    expect(ddl).toContain('v_previous.id IS DISTINCT FROM p_expected_predecessor_id')
    expect(ddl).not.toContain('p_events')
    expect(ddl).toContain('IF v_previous.id IS NOT NULL THEN')
    expect(ddl).toContain('jsonb_object_keys(v_previous.params)')
    expect(ddl).toContain('jsonb_object_keys(p_params)')
    expect(ddl).toContain('v_old IS NULL OR v_new IS NULL')
    expect(ddl).toContain("v_old = 'null'::jsonb")
    expect(ddl).toContain("'read_block_hash'")
    expect(ddl).toContain("'depthMarkets'")
    expect(ddl).toContain("'totalAssets', 'totalSupply', 'underlyingBalance'")
    expect(ddl).toContain('ABS(v_new_num - v_old_num) / ABS(v_old_num) <= 0.2')
    expect(ddl).toContain("CASE WHEN v_key = 'cooldownDuration' THEN 'cooldown_duration_changed'")
    expect(ddl).toContain('ABS(p_instant_usd - v_previous.instant_usd)')
    expect(ddl).toContain("jsonb_build_object('instant_usd', v_previous.instant_usd)")
    expect(ddl).toContain("'read_block_finalized'")
    expect(ddl).toContain("'read_block_pinned'")
    expect(ddl).toContain("'read_block_hash'")
    expect(ddl).toContain('p_block <= v_previous.block')
    expect(ddl).toContain("interval '10 minutes'")
    expect(ddl).toContain('INSERT INTO venue_snapshots')
    expect(ddl).toContain('INSERT INTO venue_events')
  })
})
