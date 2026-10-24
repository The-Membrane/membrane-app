/**
 * A throwaway local Postgres for the live engine's sink tests: `initdb` + `pg_ctl` in a temp
 * directory (unix socket only, no TCP, trust auth), and a `SqlExecutor` over `psql` (no Node
 * Postgres driver in this repo). Statement parameters are inlined as dollar-quoted literals with
 * a tag that cannot occur in the value (or NULL), so every value reaches the server verbatim;
 * a transaction is one psql session `BEGIN; …; COMMIT;` with ON_ERROR_STOP, so a failing
 * statement ends the session and the server rolls the transaction back.
 *
 * `findPostgres()` returns null (and the tests skip, saying why) when the binaries are absent.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { SqlExecutor, SqlStatement } from '@/lib/wavefront/live'

export interface PgBins {
  initdb: string
  pgCtl: string
  psql: string
  /** Run the server binaries as this OS user (root may not run Postgres). */
  asUser: string | null
}

function which(cmd: string): string | null {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/** The Postgres binaries, or a reason they cannot be used. */
export function findPostgres(): PgBins | string {
  let dir: string | null = null
  const initdb = which('initdb')
  if (initdb) dir = path.dirname(initdb)
  else if (fs.existsSync('/usr/lib/postgresql')) {
    const versions = fs
      .readdirSync('/usr/lib/postgresql')
      .filter((v) => fs.existsSync(`/usr/lib/postgresql/${v}/bin/initdb`))
      .sort((a, b) => Number(b) - Number(a))
    if (versions.length) dir = `/usr/lib/postgresql/${versions[0]}/bin`
  }
  if (!dir) return 'no initdb in PATH or /usr/lib/postgresql/*/bin'
  const pgCtl = path.join(dir, 'pg_ctl')
  const psql = fs.existsSync(path.join(dir, 'psql')) ? path.join(dir, 'psql') : which('psql')
  if (!fs.existsSync(pgCtl)) return `no pg_ctl next to ${dir}/initdb`
  if (!psql) return 'no psql'
  let asUser: string | null = null
  if (process.getuid?.() === 0) {
    if (!which('runuser')) return 'running as root without runuser (initdb refuses root)'
    if (spawnSync('id', ['postgres']).status !== 0) return 'running as root and there is no postgres user'
    asUser = 'postgres'
  }
  return { initdb: path.join(dir, 'initdb'), pgCtl, psql, asUser }
}

export class LocalPg {
  readonly dir: string
  readonly port: number
  private started = false

  constructor(readonly bins: PgBins) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-live-pg-'))
    this.port = 20000 + Math.floor(Math.random() * 40000)
  }

  private server(bin: string, args: string[]) {
    const [cmd, argv] = this.bins.asUser
      ? ['runuser', ['-u', this.bins.asUser, '--', bin, ...args]]
      : [bin, args]
    execFileSync(cmd, argv, { stdio: 'pipe', timeout: 60_000 })
  }

  start() {
    fs.chmodSync(this.dir, 0o777)
    if (this.bins.asUser) execFileSync('chown', ['-R', this.bins.asUser, this.dir])
    const data = path.join(this.dir, 'data')
    this.server(this.bins.initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync', '-E', 'UTF8'])
    this.server(this.bins.pgCtl, [
      '-D',
      data,
      '-l',
      path.join(this.dir, 'server.log'),
      '-w',
      '-o',
      `-k ${this.dir} -p ${this.port} -c listen_addresses='' -c fsync=off`,
      'start',
    ])
    this.started = true
  }

  stop() {
    try {
      if (this.started)
        this.server(this.bins.pgCtl, ['-D', path.join(this.dir, 'data'), '-m', 'immediate', 'stop'])
    } finally {
      fs.rmSync(this.dir, { recursive: true, force: true })
    }
  }

  /** Run SQL text through psql; returns stdout (CSV). Throws with psql's stderr on an error. */
  psql(script: string): string {
    const r = spawnSync(
      this.bins.psql,
      ['-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=1', '-h', this.dir, '-p', String(this.port), '-U', 'postgres', '-d', 'postgres', '-f', '-'],
      { input: script, encoding: 'utf8', maxBuffer: 1 << 28 },
    )
    if (r.status !== 0) throw new Error(`psql: ${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`)
    return r.stdout
  }

  executor(): SqlExecutor {
    return {
      query: async (text, params) => parseCsv(this.psql(inline({ text, params }) + ';\n')),
      transaction: async (stmts) => {
        this.psql(['BEGIN;', ...stmts.map((s) => inline(s) + ';'), 'COMMIT;', ''].join('\n'))
      },
    }
  }
}

/** A dollar-quoted literal whose tag cannot close early inside the value. */
export function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  const s = typeof v === 'string' ? v : String(v)
  for (let i = 0; ; i++) {
    const tag = `$wf${i}$`
    if ((s + tag).indexOf(tag) === s.length) return tag + s + tag
  }
}

/** `$n` placeholders replaced by literals, in one pass (inserted text is never rescanned). */
export function inline(s: SqlStatement): string {
  return s.text.replace(/\$(\d+)/g, (_, n: string) => literal(s.params[Number(n) - 1]))
}

/** RFC 4180 CSV (psql --csv) -> rows keyed by the header. */
export function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  if (!rows.length) return []
  const [head, ...body] = rows
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] === '' ? null : r[k]])))
}
