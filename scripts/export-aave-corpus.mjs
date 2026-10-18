#!/usr/bin/env node
/**
 * Export the Aave V3 mainnet liquidation corpus from Neon to membrane-datasets (rule N18).
 *
 * scripts/scan-aave-liquidations.mjs wrote the corpus into the app database only:
 *   aave_liquidations          every LiquidationCall event (≈27.5k rows)
 *   aave_liquidation_episodes  the per-episode replay behind public/data/liquidation-corpus.json
 *   aave_scan_cursor           the scan's resume cursors
 * This copies each table, read-only, to gzipped JSONL so the corpus can be rebuilt offline.
 *
 *   node scripts/export-aave-corpus.mjs            # needs DATABASE_URL(_UNPOOLED) in .env.local
 *
 * Output: $MEMBRANE_DATASETS_DIR (default ../membrane-datasets) /aave-liquidations/
 *   <table>.jsonl.gz, one row per line, columns as stored (bigints and numerics as strings)
 *   PROVENANCE-export.md, row counts checked against count(*), sha256 per file
 * The database URL is never printed or written.
 */
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createGzip } from 'zlib'
import { execSync } from 'child_process'
import { neon } from '@neondatabase/serverless'

import { readEnv, ROOT } from './lib/venue-reads.mjs'

const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}
const sql = neon(dbUrl)

const datasets = resolve(process.env.MEMBRANE_DATASETS_DIR || join(ROOT, '..', 'membrane-datasets'))
if (!existsSync(datasets)) {
  console.error(`membrane-datasets not found at ${datasets} (set MEMBRANE_DATASETS_DIR)`)
  process.exit(1)
}
const outDir = join(datasets, 'aave-liquidations')
mkdirSync(outDir, { recursive: true })

/** Every column in a fixed order, so the ORDER BY is total and pages never overlap. */
async function columns(table) {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = ${table} ORDER BY ordinal_position`
  return rows.map((r) => r.column_name)
}

const PAGE = 2000
const quote = (c) => `"${c.replace(/"/g, '""')}"`

async function exportTable(table) {
  const cols = await columns(table)
  if (!cols.length) {
    console.log(`${table}: not found, skipped`)
    return null
  }
  const [{ n }] = await sql.query(`SELECT count(*)::bigint AS n FROM ${quote(table)}`)
  const expected = Number(n)
  const order = cols.map(quote).join(', ')
  const file = join(outDir, `${table}.jsonl.gz`)
  const gz = createGzip({ level: 9 })
  const out = createWriteStream(file)
  gz.pipe(out)
  let written = 0
  for (let offset = 0; offset < expected; offset += PAGE) {
    const rows = await sql.query(
      `SELECT * FROM ${quote(table)} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`,
    )
    for (const r of rows) {
      gz.write(`${JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`)
      written++
    }
    process.stdout.write(`\r${table}: ${written}/${expected}`)
    if (!rows.length) break
  }
  gz.end()
  await new Promise((ok, fail) => out.on('finish', ok).on('error', fail))
  process.stdout.write('\n')
  if (written !== expected) throw new Error(`${table}: wrote ${written} rows, count(*) says ${expected}`)
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex')
  return { table, file: `${table}.jsonl.gz`, rows: written, columns: cols, sha }
}

const results = []
for (const t of ['aave_liquidations', 'aave_liquidation_episodes', 'aave_scan_cursor']) {
  const r = await exportTable(t)
  if (r) results.push(r)
}

let commit = 'unknown'
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()
} catch {}

const lines = [
  '# Aave V3 mainnet liquidation corpus — export from the app database',
  '',
  `Exported ${new Date().toISOString()} by \`scripts/export-aave-corpus.mjs\` (membrane-app \`${commit}\`), read-only.`,
  'Source: the Neon tables written by `scripts/scan-aave-liquidations.mjs` (Q15 rebuild, 2026-10-11).',
  'Row counts are checked against `count(*)` at export time.',
  '',
  '| file | rows | sha256 | columns |',
  '|---|---:|---|---|',
  ...results.map((r) => `| \`${r.file}\` | ${r.rows} | \`${r.sha}\` | ${r.columns.join(', ')} |`),
  '',
]
writeFileSync(join(outDir, 'PROVENANCE-export.md'), lines.join('\n'))
console.log(`wrote ${results.length} tables to ${outDir}`)
