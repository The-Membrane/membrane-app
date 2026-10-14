/**
 * Live wavefront engine — sinks. The Postgres sink's SQL (no network: an executor that records
 * the statements), the file sink's crash safety (a torn / uncommitted tail is truncated back to
 * the committed state), and the memory sink used by the engine tests.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  FileSink,
  GUARD_SQL,
  INSERT_BATCH,
  MemorySink,
  PostgresSink,
  insertStatements,
  type LiveHeader,
  type LiveRecord,
  type SqlExecutor,
  type SqlStatement,
} from '@/lib/wavefront/live'
import { decodeJsonl } from '@/lib/wavefront/stream'

const HEADER: LiveHeader = {
  kind: 'header',
  format: 'wavefront-stream',
  schema: 2,
  window: { startTs: 1_700_000_040, stepSeconds: 60, minutes: 0 },
  engine: 'wavefront-live',
  mode: 'live',
  chains: ['base'],
  createdAt: '2026-10-14T00:00:00.000Z',
}

const tick = (seq: number): LiveRecord => ({
  kind: 'tick',
  seq,
  ts: 1_700_000_040 + 60 * seq,
  minute: seq,
  coverage: { walked: 0, total: 0 },
  totals: {
    real: { positions: 0, repaidUsd: 0, soldUsd: 0, badDebtUsd: 0, unpricedEvents: 0 },
    mem: { positionsSold: 0, positionsArmed: 0, positionsKept: 0, repaidUsd: 0, soldUsd: 0, unpricedSales: 0 },
  },
})
const real = (seq: number, pid = 'aave-v3:base:0xabc'): LiveRecord => ({
  kind: 'real',
  seq,
  pid,
  ts: 1_700_000_100 + seq,
  block: 1000 + seq,
  tx: '0x' + seq.toString(16).padStart(64, '0'),
  logIndex: 1,
  repaidUsd: 10,
  seizedUsd: 10.5,
  backfilled: true,
})

class Recorder implements SqlExecutor {
  queries: SqlStatement[] = []
  transactions: SqlStatement[][] = []
  rows: Record<string, Record<string, unknown>[]> = {}
  async query(text: string, params: unknown[]) {
    this.queries.push({ text, params })
    for (const [k, v] of Object.entries(this.rows)) if (text.includes(k)) return v
    return []
  }
  async transaction(stmts: SqlStatement[]) {
    this.transactions.push(stmts)
  }
}

describe('live engine: Postgres sink (SQL only, no network; the real-Postgres test is wavefrontLivePostgres)', () => {
  it('creates the state row explicitly, then commits guard FIRST + inserts in one transaction', async () => {
    const db = new Recorder()
    const sink = new PostgresSink(db, 'test')
    expect(await sink.load()).toBeNull()
    expect(db.queries[0].text).toBe('SELECT version, seq, state FROM wavefront_engine_state WHERE stream = $1')
    expect(db.queries[0].params).toEqual(['test'])
    expect(db.queries[1].text).toBe('SELECT COALESCE(MAX(seq), 0) AS max FROM wavefront_events WHERE stream = $1')
    await sink.create(HEADER, '{"s":0}')
    expect(db.transactions[0]).toEqual([
      {
        text: 'INSERT INTO wavefront_engine_state (stream, header, version, seq, state, updated_at) VALUES ($1, $2::jsonb, 0, 0, $3, now())',
        params: ['test', JSON.stringify(HEADER), '{"s":0}'],
      },
    ])
    await sink.commit([real(1), tick(2)], '{"s":2}')
    const tx = db.transactions[1]
    expect(tx).toHaveLength(2)
    expect(tx[0]).toEqual({ text: GUARD_SQL, params: ['test', 0, 1, 2, '{"s":2}'] })
    expect(GUARD_SQL).toBe(
      'WITH upd AS (UPDATE wavefront_engine_state SET version = $3, seq = $4, state = $5, updated_at = now() WHERE stream = $1 AND version = $2 RETURNING 1) SELECT 1 / (SELECT count(*)::int FROM upd) AS ok',
    )
    expect(tx[1].text).toBe(
      'INSERT INTO wavefront_events (stream, seq, ts, kind, pid, body) VALUES ($1, $2, to_timestamp($3), $4, $5, $6::jsonb), ($1, $7, to_timestamp($8), $9, $10, $11::jsonb)',
    )
    expect(tx[1].params).toEqual([
      'test',
      1,
      real(1).ts,
      'real',
      'aave-v3:base:0xabc',
      JSON.stringify(real(1)),
      2,
      tick(2).ts,
      'tick',
      null,
      JSON.stringify(tick(2)),
    ])
    expect(JSON.parse(tx[1].params[5] as string).backfilled).toBe(true)
    // The next commit's guard expects version 1; a record-less one still moves the version.
    await sink.commit([], '{"s":2b}')
    expect(db.transactions[2]).toEqual([{ text: GUARD_SQL, params: ['test', 1, 2, 2, '{"s":2b}'] }])
    await sink.commit([real(3)], '{"s":3}')
    expect(db.transactions[3][0].params).toEqual(['test', 2, 3, 3, '{"s":3}'])
  })

  it('splits a large minute into batches of INSERT_BATCH rows', () => {
    const recs = Array.from({ length: 2 * INSERT_BATCH + 7 }, (_, i) => real(i + 1))
    const st = insertStatements('s', recs)
    expect(st).toHaveLength(3)
    expect(st.map((x) => x.params.length)).toEqual([1 + 5 * INSERT_BATCH, 1 + 5 * INSERT_BATCH, 36])
    expect(st[2].params[1]).toBe(2 * INSERT_BATCH + 1)
  })

  it('refuses to resume when the events table and the state disagree (per stream)', async () => {
    const db = new Recorder()
    db.rows['FROM wavefront_engine_state'] = [{ version: '9', seq: '5', state: '{"x":1}' }]
    db.rows['MAX(seq)'] = [{ max: '7' }]
    await expect(new PostgresSink(db).load()).rejects.toThrow(/max seq 7 != committed state seq 5/)
    db.rows['MAX(seq)'] = [{ max: '5' }]
    expect(await new PostgresSink(db).load()).toBe('{"x":1}')
    expect(db.queries.at(-1)!.params).toEqual(['main'])
    // Records without a state row: refused rather than overwritten by a new stream.
    db.rows['FROM wavefront_engine_state'] = []
    await expect(new PostgresSink(db).load()).rejects.toThrow(/no state row/)
  })

  it('reads no DATABASE_URL at import time', async () => {
    const before = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    const mod = await import('@/lib/wavefront/live/sinks')
    expect(typeof mod.neonExecutor).toBe('function')
    if (before !== undefined) process.env.DATABASE_URL = before
  })
})

describe('live engine: file sink', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-live-')), 'stream.jsonl')

  it('appends records after the header and truncates an uncommitted tail on load', async () => {
    const file = tmp()
    const a = new FileSink(file)
    expect(await a.load()).toBeNull()
    await a.create(HEADER, 'state-0')
    await a.commit([real(1), real(2)], 'state-2')
    await a.commit([], 'state-2b')
    // A crash after the records were written but before the state: an extra record and a torn line.
    fs.appendFileSync(file, JSON.stringify(real(3)) + '\n{"kind":"re')
    const b = new FileSink(file)
    expect(await b.load()).toBe('state-2b')
    const { header, records } = decodeJsonl(fs.readFileSync(file, 'utf8'))
    expect(header.window).toEqual(HEADER.window)
    expect(records.map((r) => r.seq)).toEqual([1, 2])
    await b.commit([real(3), tick(4)], 'state-4')
    expect(decodeJsonl(fs.readFileSync(file, 'utf8')).records.map((r) => r.seq)).toEqual([1, 2, 3, 4])
    const c = new FileSink(file)
    expect(await c.load()).toBe('state-4')
    // The open-once index comes from the stream itself (a multi-byte symbol included).
    const open = { ...real(5, 'p:₮'), kind: 'open', walked: true } as unknown as LiveRecord
    await c.commit([open], 'state-5')
    expect(await c.opened()).toEqual(new Map([['p:₮', true]]))
  })

  it('refuses a gap in seq and a stream file without its state', async () => {
    const file = tmp()
    const a = new FileSink(file)
    await a.create(HEADER, 's')
    await expect(a.commit([real(2)], 's')).rejects.toThrow(/seq 2 after 0/)
    const other = tmp()
    fs.writeFileSync(other, JSON.stringify(HEADER) + '\n')
    await expect(new FileSink(other).load()).rejects.toThrow(/without/)
  })

  it('memory sink drops records of a commit that failed before its state', async () => {
    const m = new MemorySink()
    await m.create(HEADER, 's0')
    await m.commit([real(1)], 's1')
    m.failNextBetween = true
    await expect(m.commit([real(2)], 's2')).rejects.toThrow(/simulated crash/)
    expect(await m.load()).toBe('s1')
    expect(m.records.map((r) => r.seq)).toEqual([1])
  })
})
