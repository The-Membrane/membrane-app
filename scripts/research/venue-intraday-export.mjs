// Bounded, one-time Neon snapshot export for the separately registered intraday screen.
// Dry by default. Never include a credential or query error body in CLI output.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STUDY = 'venue-intraday-first-crossing-v1'
export const START = '2026-08-20T00:00:00.000Z'
export const END = '2026-09-26T00:00:00.000Z'
export const VENUES = ['aave-v3-usde', 'sUSDe', 'sUSDS', 'scrvUSD']
export const MAX_ROWS = 15_000
export const MAX_BYTES = 16 * 1024 * 1024
export const MIN_FREE = 1_073_741_824n
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const assert = (ok, reason) => {
  if (!ok) throw new Error(reason)
}
const json = (value) => JSON.stringify(value)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function effectiveConfig(configs) {
  const venues = configs.filter((v) => v.enabled && VENUES.includes(v.name))
  assert(
    venues.length === VENUES.length && new Set(venues.map((v) => v.name)).size === VENUES.length,
    'Expected exactly four enabled named venues',
  )
  return venues
    .sort((a, b) => lexical(a.name, b.name))
    .map((v) => ({
      name: v.name,
      kind: v.kind,
      address: v.address,
      underlying: v.underlying,
      decimals: v.decimals,
      enabled: true,
      depthCoveredByInstant: v.depthCoveredByInstant === true,
      depthMarkets: (v.depthMarkets ?? [])
        .filter((m) => m.enabled)
        .map((m) => ({
          name: m.name,
          kind: m.kind,
          address: m.address,
          enabled: true,
          exitFrom: m.exitFrom,
          token0: m.token0,
          token1: m.token1,
          buffer: m.buffer,
          bufferToken: m.bufferToken,
        }))
        .sort((a, b) => lexical(a.address.toLowerCase(), b.address.toLowerCase())),
    }))
}

export function buildExport(rows, configs, fetchedAt = new Date().toISOString()) {
  const config = effectiveConfig(configs)
  assert(Number.isFinite(Date.parse(fetchedAt)) && fetchedAt >= END, 'Invalid fetch time')
  assert(Array.isArray(rows) && rows.length <= MAX_ROWS, 'Row limit exceeded')
  const names = new Set(VENUES)
  const sorted = rows
    .map((row) => {
      const observed_at = new Date(row.observed_at).toISOString()
      assert(names.has(row.venue) && row.source === 'observed', 'Unexpected venue or source')
      assert(observed_at >= START && observed_at < END, 'Row outside fixed observation interval')
      return {
        venue: row.venue,
        block: row.block,
        observed_at,
        instant_usd: row.instant_usd,
        params: row.params,
        source: row.source,
      }
    })
    .sort(
      (a, b) =>
        lexical(a.venue, b.venue) ||
        lexical(a.observed_at, b.observed_at) ||
        Number(a.block) - Number(b.block) ||
        lexical(json(a), json(b)),
    )
  const payload = {
    study: STUDY,
    status: 'historical-training-screen',
    start: START,
    end: END,
    fetchedAt,
    config,
    rows: sorted,
    caveat:
      'Older unpinned observed snapshots and inventory proxies; not a holdout or executable exit.',
  }
  assert(Buffer.byteLength(json(payload)) <= MAX_BYTES, 'Export exceeds 16 MB')
  return { payload, sha256: sha(json(payload)) }
}

export function saveExport(out, envelope, statfs = statfsSync) {
  assert(!existsSync(out), 'Refusing to overwrite sealed export')
  assert(envelope?.sha256 === sha(json(envelope.payload)), 'Export seal mismatch')
  const bytes = json(envelope)
  assert(Buffer.byteLength(bytes) <= MAX_BYTES, 'Export exceeds 16 MB')
  const fs = statfs(dirname(out), { bigint: true })
  assert(
    fs.bavail * fs.bsize - BigInt(Buffer.byteLength(bytes)) >= MIN_FREE,
    '1 GB disk reserve reached',
  )
  writeFileSync(out, bytes, { flag: 'wx', mode: 0o600 })
  return sha(readFileSync(out))
}

export function readExport(out) {
  const bytes = readFileSync(out)
  assert(bytes.length <= MAX_BYTES, 'Export exceeds 16 MB')
  const envelope = JSON.parse(bytes.toString('utf8'))
  assert(envelope?.sha256 === sha(json(envelope.payload)), 'Export SHA seal mismatch')
  const p = envelope.payload
  assert(p?.study === STUDY && p.start === START && p.end === END, 'Export identity mismatch')
  assert(Array.isArray(p.rows) && p.rows.length <= MAX_ROWS, 'Export row limit exceeded')
  assert(
    json(buildExport(p.rows, p.config, p.fetchedAt)) === json(envelope),
    'Export content invalid',
  )
  return { ...envelope, physicalSha256: sha(bytes) }
}

export async function collect({
  out,
  configs,
  query,
  now = () => new Date().toISOString(),
  statfs = statfsSync,
}) {
  assert(out && !existsSync(out), 'Explicit unused --out is required')
  const config = effectiveConfig(configs)
  const names = config.map((v) => v.name)
  const rows = await query({ names, start: START, end: END, limit: MAX_ROWS + 1 })
  assert(rows.length <= MAX_ROWS, 'Row limit exceeded; no artifact written')
  // Clock is sampled after the database read, not at process launch.
  return saveExport(out, buildExport(rows, configs, now()), statfs)
}

function argsOf(args) {
  assert(args.length === 0 || args[0] === '--run' || args[0] === '--verify', 'Unknown command')
  const mode = args[0] ?? 'dry'
  assert(
    args.length === (mode === 'dry' ? 0 : 3) &&
      (mode === 'dry' || args[1] === '--out') &&
      (mode === 'dry' || Boolean(args[2])),
    'Usage: [--run|--verify] --out <local-json>',
  )
  return { mode, out: mode === 'dry' ? null : resolve(args[2]) }
}

export async function main(args = process.argv.slice(2)) {
  const { mode, out } = argsOf(args)
  if (mode === 'dry')
    return {
      status: 'dry',
      note: 'No DB read or write. --run --out <unique.json> exports once; --verify --out checks offline.',
    }
  if (mode === '--verify') {
    const saved = readExport(out)
    return {
      status: 'verified',
      rows: saved.payload.rows.length,
      sha256: saved.sha256,
      physicalSha256: saved.physicalSha256,
    }
  }
  assert(!existsSync(out), 'Refusing to overwrite sealed export')
  const { readEnv, loadConfig } = await import('../lib/venue-reads.mjs')
  const configs = loadConfig()
  effectiveConfig(configs)
  const { get } = readEnv()
  const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
  assert(dbUrl, 'Database credential unavailable')
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(dbUrl)
  const physicalSha256 = await collect({
    out,
    configs,
    query: ({ names, start, end, limit }) => sql`
    SELECT venue, block, observed_at, instant_usd, params, source
    FROM venue_snapshots
    WHERE source = 'observed' AND venue IN (${names[0]}, ${names[1]}, ${names[2]}, ${names[3]})
      AND observed_at >= ${start}::timestamptz AND observed_at < ${end}::timestamptz
    ORDER BY venue, observed_at, block, instant_usd, params::text, source
    LIMIT ${limit}`,
  })
  return { status: 'saved', physicalSha256, ...mainVerify(out) }
}

function mainVerify(out) {
  const saved = readExport(out)
  return {
    rows: saved.payload.rows.length,
    sha256: saved.sha256,
    fetchedAt: saved.payload.fetchedAt,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => console.log(json(result)))
    .catch(() => {
      // The thrown Neon error may contain connection information.
      console.error('Venue export failed; no credential or provider details printed.')
      process.exitCode = 1
    })
}
