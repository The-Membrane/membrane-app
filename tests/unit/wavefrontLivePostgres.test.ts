/**
 * Live wavefront engine — the Postgres sink against a REAL Postgres: a throwaway local cluster
 * (initdb + pg_ctl in a temp directory, unix socket only; tests/unit/wavefrontLivePg.ts), the
 * pending migration applied to it, the sink driven through a psql executor. Skipped, with the
 * reason printed, when no Postgres binaries are installed.
 *
 * Checked: the migration applies (twice); create / commit / load / resume, streams independent
 * (MAX(seq) per stream); a second create refused; the OLD guard (`CASE … ELSE 1/0`) failing even
 * on a matching seq (the bug this replaces); TWO WRITERS — the stale one's commit rolls back
 * entirely, with records and without; an ambiguous commit (the client loses the answer) settled
 * by reading the row back, landed or not, and when even the read-back fails, settled before the
 * next write (SinkAheadError -> reload); the append-only trigger; and the whole engine on the
 * scripted chain writing through Postgres, with an unknown-outcome commit in the middle, giving
 * exactly the MemorySink stream.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  MemorySink,
  PostgresSink,
  SinkAheadError,
  SinkConflictError,
  type LiveHeader,
  type LiveRecord,
  type SqlExecutor,
  type SqlStatement,
} from '@/lib/wavefront/live'
import { LocalPg, findPostgres, literal, parseCsv } from './wavefrontLivePg'
import { runScenario } from './wavefrontLiveScenario'

const bins = findPostgres()
const why = typeof bins === 'string' ? bins : null
if (why) console.warn(`wavefrontLivePostgres: SKIPPED — ${why}`)

const MIGRATION = path.join(__dirname, '../../db/migrations-pending/2026-10-14_wavefront_live.sql')

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
const real = (seq: number, pid = 'aave-v3:base:0xpool:0xabc'): LiveRecord => ({
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
const open = (seq: number, pid: string, walked: boolean) =>
  ({ ...real(seq, pid), kind: 'open', walked }) as unknown as LiveRecord

describe.skipIf(!!why)('live engine: Postgres sink on a real Postgres', () => {
  let pg: LocalPg
  let sql: SqlExecutor
  const rows = (stream: string) =>
    parseCsv(pg.psql(`SELECT seq, kind, body FROM wavefront_events WHERE stream = ${literal(stream)} ORDER BY seq;`)).map(
      (r) => JSON.parse(String(r.body)) as LiveRecord,
    )

  beforeAll(() => {
    pg = new LocalPg(bins as Exclude<typeof bins, string>)
    pg.start()
    const ddl = fs.readFileSync(MIGRATION, 'utf8')
    pg.psql(ddl)
    pg.psql(ddl) // idempotent
    sql = pg.executor()
  }, 120_000)
  afterAll(() => pg?.stop())

  it('the executor passes values verbatim (quotes, backslashes, dollars, colons, unicode)', async () => {
    const v = `it's a "test" \\n \\\\ $wf0$ $$ :x :'y' USD₮0 \n line`
    const [r] = await sql.query('SELECT $1::text AS v, $2::text AS n', [v, null])
    expect(r).toEqual({ v, n: null })
  })

  it('the old guard failed even when the seq matched (the bug this replaces)', async () => {
    pg.psql(`INSERT INTO wavefront_engine_state (stream, header, version, seq, state) VALUES ('old', '{}', 0, 0, 's');`)
    expect(() =>
      pg.psql(`SELECT CASE WHEN seq = 0 THEN 1 ELSE 1 / 0 END FROM wavefront_engine_state WHERE stream = 'old';`),
    ).toThrow(/division by zero/)
  })

  it('create, commit, load, resume; streams are independent', async () => {
    const a = new PostgresSink(sql, 'a')
    expect(await a.load()).toBeNull()
    await a.create(HEADER, 's0')
    await expect(new PostgresSink(sql, 'a').create(HEADER, 'x')).rejects.toThrow(/duplicate key/)
    await a.commit([open(1, 'p1', true), real(2, 'p1')], 's2')
    await a.commit([], 's2b') // a minute without records still moves the state
    await a.commit([real(3, 'p1'), open(4, 'p2', false)], 's4')
    const b = new PostgresSink(sql, 'b')
    await b.create(HEADER, 'b0')
    await b.commit([real(1, 'q')], 'b1')
    expect(rows('a').map((r) => r.seq)).toEqual([1, 2, 3, 4])
    expect(rows('b').map((r) => r.seq)).toEqual([1])
    expect(rows('a')[1]).toEqual(real(2, 'p1'))
    const a2 = new PostgresSink(sql, 'a')
    expect(await a2.load()).toBe('s4')
    expect(await a2.opened()).toEqual(new Map([['p1', true], ['p2', false]]))
    await a2.commit([real(5, 'p2')], 's5')
    expect(await new PostgresSink(sql, 'a').load()).toBe('s5')
    expect(await new PostgresSink(sql, 'b').load()).toBe('b1')
    const [v] = parseCsv(pg.psql(`SELECT version, seq FROM wavefront_engine_state WHERE stream = 'a';`))
    expect(v).toEqual({ version: '4', seq: '5' })
  })

  it('two writers: the stale one cannot commit, with or without records', async () => {
    const a = new PostgresSink(sql, 'w')
    await a.create(HEADER, 'w0')
    await a.commit([real(1)], 'w1')
    const b = new PostgresSink(sql, 'w')
    expect(await b.load()).toBe('w1')
    await a.commit([real(2)], 'w2-a')
    await expect(b.commit([real(2, 'other')], 'w2-b')).rejects.toThrow(SinkConflictError)
    expect(rows('w').map((r) => [r.seq, r.kind === 'real' && r.pid])).toEqual([
      [1, 'aave-v3:base:0xpool:0xabc'],
      [2, 'aave-v3:base:0xpool:0xabc'],
    ])
    expect(await new PostgresSink(sql, 'w').load()).toBe('w2-a')
    // Record-less minutes: seq does not move, the version does.
    const c = new PostgresSink(sql, 'w')
    await c.load()
    await a.commit([], 'w2-a2')
    await expect(c.commit([], 'w2-c')).rejects.toThrow(SinkConflictError)
    expect(await new PostgresSink(sql, 'w').load()).toBe('w2-a2')
    await a.commit([real(3)], 'w3')
    expect(rows('w').map((r) => r.seq)).toEqual([1, 2, 3])
  })

  it('an ambiguous commit is settled by reading the row back', async () => {
    let mode: 'ok' | 'lost-after' | 'fail-before' = 'ok'
    let failQueries = 0
    const flaky: SqlExecutor = {
      query: async (t, p) => {
        if (failQueries > 0) {
          failQueries--
          throw new Error('connection reset (query)')
        }
        return sql.query(t, p)
      },
      transaction: async (stmts: SqlStatement[]) => {
        if (mode === 'fail-before') throw new Error('connection reset before commit')
        await sql.transaction(stmts)
        if (mode === 'lost-after') throw new Error('connection reset after commit')
      },
    }
    const s = new PostgresSink(flaky, 'amb')
    await s.create(HEADER, 'a0')
    // Landed, answer lost: the read-back sees it -> success.
    mode = 'lost-after'
    await s.commit([real(1)], 'a1')
    // Not landed: the read-back sees the old version -> the original error.
    mode = 'fail-before'
    await expect(s.commit([real(2)], 'a2')).rejects.toThrow(/before commit/)
    mode = 'ok'
    await s.commit([real(2)], 'a2')
    // Landed, and the read-back fails too: unresolved until the next write, which reports the
    // sink AHEAD (the engine reloads); a fresh load continues from the landed state.
    mode = 'lost-after'
    failQueries = 1
    await expect(s.commit([real(3)], 'a3')).rejects.toThrow(/after commit/)
    mode = 'ok'
    await expect(s.commit([real(3)], 'a3-retry')).rejects.toThrow(SinkAheadError)
    expect(await s.load()).toBe('a3')
    await s.commit([real(4)], 'a4')
    expect(rows('amb').map((r) => r.seq)).toEqual([1, 2, 3, 4])
  })

  it('the events table is append-only', () => {
    expect(() => pg.psql(`UPDATE wavefront_events SET kind = 'mem' WHERE stream = 'a' AND seq = 1;`)).toThrow(
      /append-only/,
    )
    expect(() => pg.psql(`DELETE FROM wavefront_events WHERE stream = 'a';`)).toThrow(/append-only/)
  })

  it('the engine on the scripted chain writes the same stream through Postgres (with an unknown-outcome commit)', async () => {
    const mem = await runScenario({ sink: new MemorySink() })
    let tx = 0
    let failQueries = 0
    const flaky: SqlExecutor = {
      query: async (t, p) => {
        if (failQueries > 0) {
          failQueries--
          throw new Error('connection reset (query)')
        }
        return sql.query(t, p)
      },
      transaction: async (stmts) => {
        await sql.transaction(stmts)
        // The 4th commit lands but its answer and the read-back are lost.
        if (++tx === 5) {
          failQueries = 1
          throw new Error('connection reset after commit')
        }
      },
    }
    const sink = new PostgresSink(flaky, 'engine')
    const got = await runScenario({ sink })
    expect(got.e.state.counters.sinkReloads).toBe(1)
    expect(rows('engine')).toEqual(mem.sink.records)
    expect(rows('engine').length).toBe(mem.sink.records.length)
    expect(mem.sink.records.length).toBeGreaterThan(20)
  }, 120_000)
})
