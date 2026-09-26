import type { NextApiRequest, NextApiResponse } from 'next'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'

/**
 * DEV-ONLY read-only Sensory dashboard API.
 *
 * Surfaces the Membrane "sensory system" outputs that live in the SIBLING
 * solidity repo (tools/sensory/). This route never triggers a run, never writes,
 * and never mutates anything — it only reads graph.db (READONLY) and the
 * hypothesis run ledgers (*.jsonl). It is disabled in production (returns 404).
 *
 * Point it at a different solidity checkout with MEMBRANE_SOLIDITY_ROOT.
 *
 * Resources (GET /api/sensory/<resource>):
 *   - hotspots   → top 25 salience rows joined to symbols/files
 *   - hypotheses → latest run per suite, pass/fail/pending tallies + rows
 *   - status     → graph meta (git_head, generated_at) + stale flag + counts
 *
 * Conventions mirror pages/api/feedback.ts (NextApiRequest/Response, server-only
 * env, never throws to the client) and the services/chain/* "null/clean-error on
 * failure, never throw" contract.
 */

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

const SOLIDITY_ROOT = process.env.MEMBRANE_SOLIDITY_ROOT ?? '/Users/EBmic/membrane-solidity'
const SENSORY_DIR = path.join(SOLIDITY_ROOT, 'tools', 'sensory')
const GRAPH_DB = path.join(SENSORY_DIR, 'graph.db')
const RUNS_DIR = path.join(SENSORY_DIR, 'hypothesis', 'runs')

const REGEN_HINT = 'run `npm run regen` in tools/sensory'

// ---------------------------------------------------------------------------
// sqlite helpers — prefer Node's built-in node:sqlite (DatabaseSync, READONLY);
// fall back to shelling `sqlite3 -json` if the import fails at runtime; else
// return a structured error. Never throws to the client.
// ---------------------------------------------------------------------------

type SqlRow = Record<string, string | number | null>

async function querySqlite(sql: string): Promise<{ rows?: SqlRow[]; error?: string }> {
  if (!fs.existsSync(GRAPH_DB)) {
    return { error: `graph.db not found at ${GRAPH_DB} — ${REGEN_HINT}` }
  }

  // 1) Node built-in node:sqlite (Node 22+/23). Opened READONLY.
  try {
    // Variable specifier: node:sqlite has no @types/node declarations, so a
    // literal import() would fail typecheck (TS2307). Resolving at runtime only.
    const spec = 'node:sqlite'
    const mod = (await import(spec)) as unknown as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
        prepare: (s: string) => { all: (...a: unknown[]) => SqlRow[] }
        close: () => void
      }
    }
    const db = new mod.DatabaseSync(GRAPH_DB, { readOnly: true })
    try {
      const rows = db.prepare(sql).all() as SqlRow[]
      return { rows }
    } finally {
      db.close()
    }
  } catch (nodeSqliteErr) {
    // 2) Fallback: shell out to the sqlite3 binary in read-only mode.
    try {
      const out = execFileSync('sqlite3', ['-readonly', '-json', GRAPH_DB, sql], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      })
      const rows = out.trim() ? (JSON.parse(out) as SqlRow[]) : []
      return { rows }
    } catch (sqlite3Err) {
      const detail =
        nodeSqliteErr instanceof Error ? nodeSqliteErr.message : String(nodeSqliteErr)
      return {
        error: `graph.db unreadable (node:sqlite and sqlite3 both failed) — ${REGEN_HINT}. Detail: ${detail}`,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// resource: hotspots
// ---------------------------------------------------------------------------

async function getHotspots() {
  const { rows, error } = await querySqlite(
    `SELECT s.qualified AS qualified,
            f.path      AS file,
            s.kind      AS kind,
            s.start_line AS start_line,
            sa.hotspot  AS hotspot,
            sa.blast_radius AS blast_radius,
            sa.pagerank AS pagerank,
            sa.churn_90d AS churn_90d,
            sa.complexity AS complexity
     FROM salience sa
     JOIN symbols s ON s.id = sa.symbol_id
     JOIN files   f ON f.id = s.file_id
     ORDER BY sa.hotspot DESC, sa.blast_radius DESC
     LIMIT 25`,
  )
  if (error) return { error }
  return { hotspots: rows ?? [] }
}

// ---------------------------------------------------------------------------
// resource: status
// ---------------------------------------------------------------------------

function currentSolidityHead(): string | null {
  try {
    return execFileSync('git', ['-C', SOLIDITY_ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

function countRunFiles(): number {
  try {
    return fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.jsonl')).length
  } catch {
    return 0
  }
}

async function getStatus() {
  const metaRes = await querySqlite(`SELECT key, value FROM meta`)
  if (metaRes.error) return { error: metaRes.error }

  const meta: Record<string, string> = {}
  for (const row of metaRes.rows ?? []) {
    if (row.key != null) meta[String(row.key)] = row.value == null ? '' : String(row.value)
  }

  // Counts — symbols + edges from the graph, hypotheses from the run ledgers.
  const symCount = await querySqlite(`SELECT COUNT(*) AS n FROM symbols`)
  const edgeCount = await querySqlite(`SELECT COUNT(*) AS n FROM edges`)

  const graphHead = meta.git_head ?? null
  const repoHead = currentSolidityHead()
  const stale = graphHead != null && repoHead != null ? graphHead !== repoHead : null

  return {
    git_head: graphHead,
    git_head_short: graphHead ? graphHead.slice(0, 8) : null,
    generated_at: meta.generated_at ?? null,
    solc: meta.solc ?? null,
    dirty: meta.dirty === 'true',
    repo_head: repoHead,
    repo_head_short: repoHead ? repoHead.slice(0, 8) : null,
    stale,
    counts: {
      symbols: Number((symCount.rows?.[0]?.n as number) ?? 0),
      edges: Number((edgeCount.rows?.[0]?.n as number) ?? 0),
      hypothesisRunFiles: countRunFiles(),
    },
  }
}

// ---------------------------------------------------------------------------
// resource: hypotheses — newest run per suite from *.jsonl
// ---------------------------------------------------------------------------

// filename shape: 2026-08-15T04-05-34-282Z-<suite>.jsonl
const RUN_FILE_RE = /^(.*Z)-(.+)\.jsonl$/

type HypRow = {
  target: string
  suite: string
  pass: boolean | null
  reproducible: boolean | null
  attributed: string | null
  severity: string | null
  delta: string | null
  pending: string | null
  basis: string | null
  observed: string | null
  predict: string | null
  ts: string | null
}

function statusOf(r: HypRow): 'pass' | 'fail' | 'pending' {
  if (r.pass === true) return 'pass'
  if (r.pass === false) return 'fail'
  return 'pending'
}

function getHypotheses() {
  let files: string[]
  try {
    files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return {
      error: `hypothesis runs dir not found at ${RUNS_DIR} — ${REGEN_HINT} then run a hypothesis suite`,
    }
  }
  if (files.length === 0) {
    return { suites: [], totals: { pass: 0, fail: 0, pending: 0 } }
  }

  // Group by suite; keep only the newest file per suite (lexical sort on the
  // leading ISO timestamp is chronological).
  const newestPerSuite = new Map<string, string>()
  for (const f of files) {
    const m = RUN_FILE_RE.exec(f)
    if (!m) continue
    const [, ts, suite] = m
    const prev = newestPerSuite.get(suite)
    if (!prev || ts > (RUN_FILE_RE.exec(prev)?.[1] ?? '')) newestPerSuite.set(suite, f)
  }

  const suites: Array<{
    suite: string
    file: string
    generatedAt: string | null
    counts: { pass: number; fail: number; pending: number; total: number }
    rows: HypRow[]
  }> = []
  const totals = { pass: 0, fail: 0, pending: 0 }

  for (const [suite, file] of [...newestPerSuite.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    let raw: string
    try {
      raw = fs.readFileSync(path.join(RUNS_DIR, file), 'utf8')
    } catch {
      continue
    }
    const rows: HypRow[] = []
    let generatedAt: string | null = null
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(t)
      } catch {
        continue
      }
      const target = String(rec.target ?? '')
      const shortTarget = target.includes('/') ? target.slice(target.indexOf('/') + 1) : target
      const ts = rec.ts == null ? null : String(rec.ts)
      if (ts && (!generatedAt || ts > generatedAt)) generatedAt = ts
      rows.push({
        target: shortTarget,
        suite,
        pass: rec.pass === true ? true : rec.pass === false ? false : null,
        reproducible: typeof rec.reproducible === 'boolean' ? rec.reproducible : null,
        attributed: rec.attributed == null ? null : String(rec.attributed),
        // severity/basis are surfaced when a record carries them (future runs);
        // today's records use delta/pending/observed as the actionable payload.
        severity: rec.severity == null ? null : String(rec.severity),
        delta: rec.delta == null || rec.delta === '' ? null : String(rec.delta),
        pending: rec.pending == null || rec.pending === '' ? null : String(rec.pending),
        basis: rec.basis == null ? null : String(rec.basis),
        observed: rec.observed == null || rec.observed === '' ? null : String(rec.observed),
        predict: rec.predict == null ? null : String(rec.predict),
        ts,
      })
    }

    const counts = { pass: 0, fail: 0, pending: 0, total: rows.length }
    for (const r of rows) counts[statusOf(r)]++
    totals.pass += counts.pass
    totals.fail += counts.fail
    totals.pending += counts.pending

    // Failing first, then pending, then pass — actionable rows on top.
    const order = { fail: 0, pending: 1, pass: 2 } as const
    rows.sort((a, b) => order[statusOf(a)] - order[statusOf(b)])

    suites.push({ suite, file, generatedAt, counts, rows })
  }

  return { suites, totals }
}

// keep the async execFile import used (silences unused in some lint configs)
void execFile

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Dev-only guard: never serve in production.
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'not found' })
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const resource = String(req.query.resource ?? '')

  try {
    let body: unknown
    switch (resource) {
      case 'hotspots':
        body = await getHotspots()
        break
      case 'hypotheses':
        body = getHypotheses()
        break
      case 'status':
        body = await getStatus()
        break
      default:
        return res
          .status(404)
          .json({ error: `unknown resource '${resource}' (hotspots | hypotheses | status)` })
    }
    // No caching — this is a live dev view of on-disk artifacts.
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ...(body as object), sourceRoot: SOLIDITY_ROOT })
  } catch (err) {
    // Absolute backstop: never throw to the client.
    const detail = err instanceof Error ? err.message : String(err)
    return res.status(200).json({ error: `sensory read failed — ${REGEN_HINT}. Detail: ${detail}` })
  }
}
