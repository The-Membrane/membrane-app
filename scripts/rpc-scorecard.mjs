/**
 * RPC SCORECARD — which endpoints served our log scans, and how they checked out.
 * Owner 2026-10-11: record "which RPC we are getting things from so that we can
 * evaluate them". Reads the ring's call ledger (lib/position-sim/rpcRing.ts `RpcCall`)
 * and prints per-host rates from lib/position-sim/rpcScorecard.ts. Read-only.
 *
 *   npx tsx scripts/rpc-scorecard.mjs --file=ledger.jsonl [--file=more.jsonl]
 *       a JSONL ledger, e.g. from scripts/audit-ring-gaps.mjs --ledger=ledger.jsonl
 *   npx tsx scripts/rpc-scorecard.mjs --db [--query=LiquidationCall@%] [--since=2026-10-01]
 *       the rpc_log_calls table the corpus scan writes (needs .env.local, SELECT only)
 *   --json   print JSON instead of the table
 *
 * Read the rates with their denominators: falseEmpty 3/40 means 3 of the 40 empty
 * answers a second endpoint checked were wrong. Under the default verify 'empty' every
 * empty answer is checked; non-empty answers only when spot-checked (--spot-check).
 */
import { readFileSync } from 'fs'

const argv = process.argv.slice(2)
const flags = (name) => argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3))
const has = (name) => argv.includes(`--${name}`)

const { scorecard, pieceVerdicts, formatScorecard } = await import('../lib/position-sim/rpcScorecard.ts')

let rows = []
for (const f of flags('file')) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    rows.push({ ...r, fromBlock: BigInt(r.fromBlock), toBlock: BigInt(r.toBlock) })
  }
}
if (has('db')) {
  const { readEnv } = await import('./lib/venue-reads.mjs')
  const { readCalls } = await import('./lib/rpc-ledger.mjs')
  const { neon } = await import('@neondatabase/serverless')
  const { get } = readEnv()
  const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
  if (!dbUrl) throw new Error('--db: no DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  rows.push(...(await readCalls(neon(dbUrl), { queryLike: flags('query')[0] ?? '%', since: flags('since')[0] })))
}
if (rows.length === 0) {
  console.error('no ledger rows: pass --file=<ledger.jsonl> and/or --db')
  process.exit(1)
}
const scores = scorecard(rows)
const pieces = pieceVerdicts(rows)
if (has('json')) {
  console.log(JSON.stringify({ rows: rows.length, pieces, byHost: scores }, null, 2))
} else {
  const queries = [...new Set(rows.map((r) => r.query))]
  console.log(`${rows.length} calls over ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}; pieces by verdict ${JSON.stringify(pieces)}\n`)
  console.log(formatScorecard(scores))
}
