/**
 * Where the live stream goes. Every sink commits a minute's records TOGETHER with the engine
 * state that produced them, so a crash never leaves records the state does not know about (they
 * would be written twice on restart) or a state ahead of its records (a gap).
 *
 *   FileSink      append-only JSONL (`encodeJsonl`'s format: a header line, then one record
 *                 per line, seq 1, 2, 3, …) + `<file>.state` (rename-safe). The state records
 *                 the JSONL length it belongs to; on load a longer JSONL (a torn or uncommitted
 *                 tail) is truncated back to it. Records are fsync'ed before the state is
 *                 replaced, and the state is written to a temp file, fsync'ed and renamed.
 *   PostgresSink  `wavefront_events(seq bigserial primary key, ts timestamptz, kind text,
 *                 pid text, body jsonb)` + `wavefront_engine_state`, one transaction per minute
 *                 through an injected SQL executor. The migration is
 *                 db/migrations-pending/2026-10-14_wavefront_live.sql (NOT applied). Nothing
 *                 here reads DATABASE_URL: `neonExecutor(url)` is called by the CLI, only with
 *                 `--sink postgres`.
 *   MemorySink    for tests (can be told to fail between the records and the state).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { dirname } from 'path'
import type { LiveHeader, LiveRecord } from './state'

export interface StreamSink {
  /** The committed engine state, or null for a stream that does not exist yet. */
  load(): Promise<string | null>
  /** Create the stream: its header and initial state. */
  create(header: LiveHeader, state: string): Promise<void>
  /** Append `records` (seq consecutive after the last commit) and replace the state. */
  commit(records: readonly LiveRecord[], state: string): Promise<void>
  close(): Promise<void>
}

// ------------------------------------------------------------------ file

interface FileMeta {
  bytes: number
  seq: number
}

export class FileSink implements StreamSink {
  readonly statePath: string
  private meta: FileMeta | null = null

  constructor(readonly path: string) {
    this.statePath = path + '.state'
  }

  async load(): Promise<string | null> {
    if (!existsSync(this.statePath)) {
      if (existsSync(this.path) && statSync(this.path).size > 0)
        throw new Error(`${this.path} exists without ${this.statePath}: refusing to append to it`)
      return null
    }
    const text = readFileSync(this.statePath, 'utf8')
    const nl = text.indexOf('\n')
    const meta = JSON.parse(text.slice(0, nl)) as FileMeta
    const size = existsSync(this.path) ? statSync(this.path).size : 0
    if (size < meta.bytes)
      throw new Error(`${this.path}: ${size} bytes, the state says ${meta.bytes} were committed`)
    if (size > meta.bytes) {
      // An uncommitted tail (the process died between the records and the state): drop it.
      const fd = openSync(this.path, 'r+')
      ftruncateSync(fd, meta.bytes)
      fsyncSync(fd)
      closeSync(fd)
    }
    // The last line, read from the tail only (the file can be large).
    const tailLen = Math.min(meta.bytes, 1 << 20)
    const buf = Buffer.alloc(tailLen)
    const rfd = openSync(this.path, 'r')
    readSync(rfd, buf, 0, tailLen, meta.bytes - tailLen)
    closeSync(rfd)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    const last = JSON.parse(lines[lines.length - 1]) as { kind: string; seq?: number }
    const lastSeq = last.kind === 'header' ? 0 : (last.seq as number)
    if (lastSeq !== meta.seq)
      throw new Error(`${this.path}: last record seq ${lastSeq}, the state says ${meta.seq}`)
    this.meta = meta
    return text.slice(nl + 1)
  }

  private writeState(meta: FileMeta, state: string) {
    const tmp = this.statePath + '.tmp'
    const fd = openSync(tmp, 'w')
    writeSync(fd, JSON.stringify(meta) + '\n' + state)
    fsyncSync(fd)
    closeSync(fd)
    renameSync(tmp, this.statePath)
    try {
      const d = openSync(dirname(this.statePath), 'r')
      fsyncSync(d)
      closeSync(d)
    } catch {
      /* directory fsync is best effort on some filesystems */
    }
  }

  async create(header: LiveHeader, state: string): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true })
    if (existsSync(this.statePath)) throw new Error(`${this.statePath} exists: stream already created`)
    const line = JSON.stringify(header) + '\n'
    writeFileSync(this.path, line)
    const fd = openSync(this.path, 'r+')
    fsyncSync(fd)
    closeSync(fd)
    this.meta = { bytes: Buffer.byteLength(line), seq: 0 }
    this.writeState(this.meta, state)
  }

  async commit(records: readonly LiveRecord[], state: string): Promise<void> {
    if (!this.meta) throw new Error('FileSink: commit before load/create')
    let seq = this.meta.seq
    for (const r of records) {
      if (r.seq !== seq + 1) throw new Error(`FileSink: seq ${r.seq} after ${seq}`)
      seq = r.seq
    }
    const text = records.map((r) => JSON.stringify(r) + '\n').join('')
    const fd = openSync(this.path, 'r+')
    try {
      // Anything past the committed length is a failed earlier attempt: overwrite it.
      ftruncateSync(fd, this.meta.bytes)
      if (text) writeSync(fd, text, this.meta.bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const meta = { bytes: this.meta.bytes + Buffer.byteLength(text), seq }
    this.writeState(meta, state)
    this.meta = meta
  }

  async close(): Promise<void> {}
}

// ------------------------------------------------------------------ memory (tests)

export class MemorySink implements StreamSink {
  header: LiveHeader | null = null
  records: LiveRecord[] = []
  state: string | null = null
  commits = 0
  /** Throw after appending the records but before the state (a crash in between). */
  failNextBetween = false
  /** Records appended by a failed commit, not yet covered by a state. */
  private uncommitted = 0

  async load(): Promise<string | null> {
    if (this.uncommitted) {
      this.records.splice(this.records.length - this.uncommitted)
      this.uncommitted = 0
    }
    return this.state
  }
  async create(header: LiveHeader, state: string) {
    this.header = header
    this.state = state
  }
  async commit(records: readonly LiveRecord[], state: string) {
    if (this.uncommitted) {
      this.records.splice(this.records.length - this.uncommitted)
      this.uncommitted = 0
    }
    const last = this.records.length ? this.records[this.records.length - 1].seq : 0
    if (records.length && records[0].seq !== last + 1)
      throw new Error(`MemorySink: seq ${records[0].seq} after ${last}`)
    this.records.push(...records.map((r) => JSON.parse(JSON.stringify(r)) as LiveRecord))
    if (this.failNextBetween) {
      this.failNextBetween = false
      this.uncommitted = records.length
      throw new Error('MemorySink: simulated crash between records and state')
    }
    this.state = state
    this.commits++
  }
  async close() {}
}

// ------------------------------------------------------------------ postgres

export interface SqlStatement {
  text: string
  params: unknown[]
}

/** The SQL seam: production wraps @neondatabase/serverless, tests capture the statements. */
export interface SqlExecutor {
  query(text: string, params: unknown[]): Promise<Record<string, unknown>[]>
  /** Run every statement in ONE transaction (all or nothing). */
  transaction(stmts: SqlStatement[]): Promise<void>
}

export const EVENTS_TABLE = 'wavefront_events'
export const STATE_TABLE = 'wavefront_engine_state'
/** Rows per INSERT (5 parameters each, far under Postgres's 65,535). */
export const INSERT_BATCH = 1000

/** The INSERT statements for a batch of records (exported for the tests). */
export function insertStatements(records: readonly LiveRecord[]): SqlStatement[] {
  const out: SqlStatement[] = []
  for (let i = 0; i < records.length; i += INSERT_BATCH) {
    const part = records.slice(i, i + INSERT_BATCH)
    const values: string[] = []
    const params: unknown[] = []
    part.forEach((r, k) => {
      const b = k * 5
      values.push(`($${b + 1}, to_timestamp($${b + 2}), $${b + 3}, $${b + 4}, $${b + 5}::jsonb)`)
      params.push(r.seq, r.ts, r.kind, r.kind === 'tick' ? null : r.pid, JSON.stringify(r))
    })
    out.push({
      text: `INSERT INTO ${EVENTS_TABLE} (seq, ts, kind, pid, body) VALUES ${values.join(', ')}`,
      params,
    })
  }
  return out
}

export class PostgresSink implements StreamSink {
  private seq: number | null = null

  constructor(
    readonly sql: SqlExecutor,
    readonly stream = 'main',
  ) {}

  async load(): Promise<string | null> {
    const rows = await this.sql.query(
      `SELECT seq, state FROM ${STATE_TABLE} WHERE stream = $1`,
      [this.stream],
    )
    if (!rows.length) return null
    const seq = Number(rows[0].seq)
    const [m] = await this.sql.query(`SELECT COALESCE(MAX(seq), 0) AS max FROM ${EVENTS_TABLE}`, [])
    if (Number(m.max) !== seq)
      throw new Error(`${EVENTS_TABLE} max seq ${m.max} != committed state seq ${seq}`)
    this.seq = seq
    return String(rows[0].state)
  }

  async create(header: LiveHeader, state: string): Promise<void> {
    await this.sql.transaction([
      {
        text: `INSERT INTO ${STATE_TABLE} (stream, header, seq, state, updated_at) VALUES ($1, $2::jsonb, 0, $3, now())`,
        params: [this.stream, JSON.stringify(header), state],
      },
    ])
    this.seq = 0
  }

  /** The statements of one commit (exported shape for the tests). */
  commitStatements(records: readonly LiveRecord[], state: string): SqlStatement[] {
    if (this.seq === null) throw new Error('PostgresSink: commit before load/create')
    const last = records.length ? records[records.length - 1].seq : this.seq
    return [
      // Guard: abort the transaction (division by zero) unless the stored state is the one this
      // writer last committed — a second writer, or a writer resumed from a stale state, fails.
      {
        text: `SELECT CASE WHEN seq = $2 THEN 1 ELSE 1 / 0 END FROM ${STATE_TABLE} WHERE stream = $1`,
        params: [this.stream, this.seq],
      },
      ...insertStatements(records),
      {
        text: `UPDATE ${STATE_TABLE} SET seq = $2, state = $3, updated_at = now() WHERE stream = $1`,
        params: [this.stream, last, state],
      },
    ]
  }

  async commit(records: readonly LiveRecord[], state: string): Promise<void> {
    const stmts = this.commitStatements(records, state)
    await this.sql.transaction(stmts)
    if (records.length) this.seq = records[records.length - 1].seq
  }

  async close(): Promise<void> {}
}

/**
 * A SqlExecutor over Neon's serverless driver (HTTP, one transaction per call). Imported lazily so
 * the engine never loads the driver — or needs a database — unless the Postgres sink is chosen.
 */
export async function neonExecutor(connectionString: string): Promise<SqlExecutor> {
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(connectionString)
  return {
    query: async (text, params) => (await sql.query(text, params)) as Record<string, unknown>[],
    transaction: async (stmts) => {
      await sql.transaction(stmts.map((s) => sql.query(s.text, s.params)))
    },
  }
}
