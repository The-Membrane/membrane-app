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
 *   PostgresSink  `wavefront_events(stream, seq, ts, kind, pid, body)` (primary key
 *                 (stream, seq)) + `wavefront_engine_state(stream, header, version, seq, state)`,
 *                 one transaction per minute through an injected SQL executor: FIRST the guard
 *                 (GUARD_SQL: the state row moves from the version this writer last committed to
 *                 the next, or the transaction aborts), then the records. Two writers on one
 *                 stream: the second one's guard matches no row and its whole transaction rolls
 *                 back (tests/unit/wavefrontLivePostgres.test.ts, on a real Postgres). A commit
 *                 whose outcome is unknown is settled by reading the row back before anything
 *                 else is written. The migration is
 *                 db/migrations-pending/2026-10-14_wavefront_live.sql (NOT applied). Nothing
 *                 here reads DATABASE_URL: `neonExecutor(url)` is called by the CLI, only with
 *                 `--sink postgres`.
 *   MemorySink    for tests (can be told to fail between the records and the state).
 *
 * `opened()` lists every position opened in the committed stream (pid -> walked): closed
 * positions are not kept in the engine state (it would grow without bound), and the engine
 * rebuilds its open-once index from the stream itself at start-up.
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
import { StringDecoder } from 'string_decoder'
import type { LiveHeader, LiveRecord } from './state'

export interface StreamSink {
  /** The committed engine state, or null for a stream that does not exist yet. */
  load(): Promise<string | null>
  /** Create the stream: its header and initial state. */
  create(header: LiveHeader, state: string): Promise<void>
  /** Append `records` (seq consecutive after the last commit) and replace the state. */
  commit(records: readonly LiveRecord[], state: string): Promise<void>
  /** pid -> walked for every `open` record committed so far. */
  opened(): Promise<Map<string, boolean>>
  close(): Promise<void>
}

/** pid -> walked of the `open` records in JSONL text (header line skipped). */
function openedFromLines(text: string, into: Map<string, boolean>) {
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"open"')) continue
    const r = JSON.parse(line) as { kind: string; pid: string; walked: boolean }
    if (r.kind === 'open') into.set(r.pid, r.walked)
  }
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

  async opened(): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>()
    if (!this.meta) throw new Error('FileSink: opened() before load/create')
    // In 8 MB slices, cut at line ends (the file can be large).
    const fd = openSync(this.path, 'r')
    try {
      const buf = Buffer.alloc(8 << 20)
      const dec = new StringDecoder('utf8') // a multi-byte character may straddle two slices
      let pos = 0
      let rest = ''
      while (pos < this.meta.bytes) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, this.meta.bytes - pos), pos)
        if (n <= 0) break
        pos += n
        const text = rest + dec.write(buf.subarray(0, n))
        const cut = text.lastIndexOf('\n')
        openedFromLines(text.slice(0, cut + 1), out)
        rest = text.slice(cut + 1)
      }
      if (rest) openedFromLines(rest, out)
    } finally {
      closeSync(fd)
    }
    return out
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
  async opened() {
    const out = new Map<string, boolean>()
    for (const r of this.records) if (r.kind === 'open') out.set(r.pid, r.walked)
    return out
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

/** The stored state is not the one this writer last committed: another writer, or a stale one. */
export class SinkConflictError extends Error {}
/**
 * A commit whose outcome was unknown (the connection failed around COMMIT) turned out to have
 * landed: the sink is one commit ahead of the engine's rolled-back state. The engine reloads
 * from `load()` and carries on from there.
 */
export class SinkAheadError extends Error {}

export const EVENTS_TABLE = 'wavefront_events'
export const STATE_TABLE = 'wavefront_engine_state'
/** Rows per INSERT (6 parameters each, far under Postgres's 65,535). */
export const INSERT_BATCH = 1000

/** The INSERT statements for a batch of one stream's records (exported for the tests). */
export function insertStatements(stream: string, records: readonly LiveRecord[]): SqlStatement[] {
  const out: SqlStatement[] = []
  for (let i = 0; i < records.length; i += INSERT_BATCH) {
    const part = records.slice(i, i + INSERT_BATCH)
    const values: string[] = []
    const params: unknown[] = [stream]
    part.forEach((r, k) => {
      const b = 1 + k * 5
      values.push(`($1, $${b + 1}, to_timestamp($${b + 2}), $${b + 3}, $${b + 4}, $${b + 5}::jsonb)`)
      params.push(r.seq, r.ts, r.kind, r.kind === 'tick' ? null : r.pid, JSON.stringify(r))
    })
    out.push({
      text: `INSERT INTO ${EVENTS_TABLE} (stream, seq, ts, kind, pid, body) VALUES ${values.join(', ')}`,
      params,
    })
  }
  return out
}

/**
 * The guard, the FIRST statement of every commit: advance the state row from the version this
 * writer last committed to the next one. `version` counts commits (seq does not move on a minute
 * without records, so it cannot tell two writers apart). The UPDATE matches 0 rows when another
 * writer (or this one, from a stale state) got there first; `1 / count` then raises
 * division_by_zero AT RUN TIME — the count is a scalar subquery over the CTE, which Postgres
 * cannot fold — and the whole transaction, records included, is rolled back.
 */
export const GUARD_SQL =
  `WITH upd AS (UPDATE ${STATE_TABLE} SET version = $3, seq = $4, state = $5, updated_at = now() ` +
  `WHERE stream = $1 AND version = $2 RETURNING 1) SELECT 1 / (SELECT count(*)::int FROM upd) AS ok`

export class PostgresSink implements StreamSink {
  /** The version and seq this writer last committed (null before load / create). */
  private version: number | null = null
  private seq: number | null = null
  /** A commit whose outcome could not even be re-read: settled before the next write. */
  private unresolved: { expected: number; next: number; state: string } | null = null

  constructor(
    readonly sql: SqlExecutor,
    readonly stream = 'main',
  ) {}

  private async readRow(state?: string) {
    const rows = await this.sql.query(
      state === undefined
        ? `SELECT version, seq FROM ${STATE_TABLE} WHERE stream = $1`
        : `SELECT version, seq, md5(state) = md5($2::text) AS same FROM ${STATE_TABLE} WHERE stream = $1`,
      state === undefined ? [this.stream] : [this.stream, state],
    )
    if (!rows.length) throw new Error(`${STATE_TABLE}: stream ${this.stream} has no state row`)
    const r = rows[0]
    return { version: Number(r.version), seq: Number(r.seq), same: r.same === true || r.same === 't' }
  }

  async load(): Promise<string | null> {
    const rows = await this.sql.query(
      `SELECT version, seq, state FROM ${STATE_TABLE} WHERE stream = $1`,
      [this.stream],
    )
    const [m = { max: 0 }] = await this.sql.query(
      `SELECT COALESCE(MAX(seq), 0) AS max FROM ${EVENTS_TABLE} WHERE stream = $1`,
      [this.stream],
    )
    if (!rows.length) {
      if (Number(m.max) !== 0)
        throw new Error(`${EVENTS_TABLE} has records of stream ${this.stream} but no state row`)
      return null
    }
    const seq = Number(rows[0].seq)
    if (Number(m.max) !== seq)
      throw new Error(`${EVENTS_TABLE} max seq ${m.max} != committed state seq ${seq} (stream ${this.stream})`)
    this.version = Number(rows[0].version)
    this.seq = seq
    this.unresolved = null
    return String(rows[0].state)
  }

  /** Create the stream's state row (explicitly: a second create of the same stream fails). */
  async create(header: LiveHeader, state: string): Promise<void> {
    await this.sql.transaction([
      {
        text: `INSERT INTO ${STATE_TABLE} (stream, header, version, seq, state, updated_at) VALUES ($1, $2::jsonb, 0, 0, $3, now())`,
        params: [this.stream, JSON.stringify(header), state],
      },
    ])
    this.version = 0
    this.seq = 0
  }

  /** The statements of one commit (exported shape for the tests). */
  commitStatements(records: readonly LiveRecord[], state: string): SqlStatement[] {
    if (this.version === null || this.seq === null)
      throw new Error('PostgresSink: commit before load/create')
    const next = records.length ? records[records.length - 1].seq : this.seq
    return [
      { text: GUARD_SQL, params: [this.stream, this.version, this.version + 1, next, state] },
      ...insertStatements(this.stream, records),
    ]
  }

  /**
   * Settle an earlier commit whose outcome is unknown: not landed -> carry on; landed -> the sink
   * is ahead of the engine (SinkAheadError: reload); anything else -> another writer.
   */
  private async settle() {
    const u = this.unresolved!
    const now = await this.readRow(u.state)
    this.unresolved = null
    if (now.version === u.expected) return
    if (now.version === u.expected + 1 && now.seq === u.next && now.same) {
      this.version = now.version
      this.seq = now.seq
      throw new SinkAheadError(`stream ${this.stream}: the commit to version ${now.version} had landed; reload`)
    }
    throw new SinkConflictError(
      `stream ${this.stream}: state version ${now.version}, this writer expected ${u.expected}: another writer`,
    )
  }

  async commit(records: readonly LiveRecord[], state: string): Promise<void> {
    if (this.unresolved) await this.settle()
    const stmts = this.commitStatements(records, state)
    const expected = this.version!
    const next = records.length ? records[records.length - 1].seq : this.seq!
    try {
      await this.sql.transaction(stmts)
    } catch (err) {
      // The transaction failed, or its outcome is unknown (connection lost around COMMIT): read
      // back which. A record-less commit leaves seq unchanged, so the state text decides.
      let now: Awaited<ReturnType<PostgresSink['readRow']>>
      try {
        now = await this.readRow(state)
      } catch {
        this.unresolved = { expected, next, state }
        throw err
      }
      if (now.version === expected + 1 && now.seq === next && now.same) {
        this.version = now.version
        this.seq = now.seq
        return
      }
      if (now.version === expected) throw err
      throw new SinkConflictError(
        `stream ${this.stream}: state version ${now.version}, this writer expected ${expected}: another writer (${(err as Error).message})`,
      )
    }
    this.version = expected + 1
    this.seq = next
  }

  /** pid -> walked of every position opened in the committed stream. */
  async opened(): Promise<Map<string, boolean>> {
    const rows = await this.sql.query(
      `SELECT pid, (body->>'walked')::boolean AS walked FROM ${EVENTS_TABLE} WHERE stream = $1 AND kind = 'open'`,
      [this.stream],
    )
    return new Map(rows.map((r) => [String(r.pid), r.walked === true || r.walked === 't']))
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
