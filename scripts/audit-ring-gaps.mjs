/**
 * AUDIT: did the RPC ring's false-empty answers leave holes in data built through it?
 * (lib/position-sim/rpcRing.ts, "AN EMPTY ANSWER IS NOT A FACT", 2026-10-07.)
 *
 * READ-ONLY. Prints a report (and writes it to --out if given). It never writes under
 * public/data — a diff against published data is reported first, never applied.
 * The ring table is probed fresh in memory and NOT saved, so rpc-ring.json is untouched.
 *
 *   npx tsx scripts/audit-ring-gaps.mjs --mode=feeds   # old ring vs fixed ring on Chainlink
 *   npx tsx scripts/audit-ring-gaps.mjs --mode=aave    # every Aave V3 LiquidationCall vs
 *                                                      # public/data/liquidation-corpus.json
 *   --concurrency=3  --out=<file>  --verify=empty|all
 *   --db   (aave) diff per 10k-block bucket against the Neon aave_liquidations table and
 *          list every on-chain event the table lacks. Needs .env.local. SELECT only.
 *   --ledger=<file.jsonl>  append every endpoint call (RpcCall, hosts only) to a JSONL
 *          ledger; `node scripts/rpc-scorecard.mjs --file=<file.jsonl>` scores it.
 *   --spot-check=<rate>    re-ask this share of non-empty answers (default 0.05).
 *
 * feeds: AnswerUpdated round ids are consecutive per aggregator, so a hole is visible
 *   without any reference endpoint: an interior jump in round id is a missing stretch.
 * aave: the corpus publishes only aggregates (events, accounts, events per UTC year);
 *   the per-event rows live in the Neon table. A matching total and per-year count is
 *   evidence of no gap; a shortfall is located to a year here, and to a block range by
 *   re-running against the table's per-chunk counts.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseAbiItem } from 'viem'

const { probeRing, RpcRing, CANDIDATES } = await import('../lib/position-sim/rpcRing.ts')
const { scorecard, pieceVerdicts, formatScorecard } = await import('../lib/position-sim/rpcScorecard.ts')

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}
const MODE = flag('mode', 'feeds')
const CONC = Number(flag('concurrency', '3'))
const VERIFY = flag('verify', 'empty')
const OUT = flag('out', null)
const LEDGER = flag('ledger', null)
const SPOT = Number(flag('spot-check', '0.05'))
const RUN = `audit-${MODE}-${new Date().toISOString()}`
/** Every call of every ring this run builds (hosts only), for the scorecard. */
const calls = []
const ringOpts = (verify) => ({
  verify,
  spotCheckRate: verify === 'empty' ? SPOT : 0,
  onCall: (c) => {
    const row = { run: RUN, ...c }
    calls.push(row)
    if (LEDGER) appendFileSync(LEDGER, JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) + '\n')
  },
})

const ANSWER_UPDATED = parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)')
const LIQUIDATION_CALL = parseAbiItem(
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
)
const FEEDS = {
  'ETH/USD': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  'BTC/USD': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
}
const proxyAbi = [
  { type: 'function', name: 'phaseId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'phaseAggregators', stateMutability: 'view', inputs: [{ type: 'uint16' }], outputs: [{ type: 'address' }] },
]

const t0 = Date.now()
const table = await probeRing(CANDIDATES)
const live = table.entries.filter((e) => e.cap > 0)
console.log(`ring (probed in ${((Date.now() - t0) / 1000).toFixed(0)}s, not saved): ${live.map((e) => `${new URL(e.url).host}@${e.cap}${e.emptyAnswers ? ` (probe empties ${e.emptyAnswers})` : ''}`).join(' · ')}`)
const report = { mode: MODE, at: new Date().toISOString(), ring: live.map((e) => ({ host: new URL(e.url).host, cap: e.cap, emptyAnswers: e.emptyAnswers ?? 0 })) }

const ringStats = (r) => r.stats().map((s) => `${s.host} ${s.ok}/${s.calls} empty ${s.empty} FALSE-EMPTY ${s.falseEmpty}${s.quarantined ? ' (quarantined)' : ''}`).join(' · ')

async function aggregators(client, proxy) {
  const n = Number(await client.readContract({ address: proxy, abi: proxyAbi, functionName: 'phaseId' }))
  const out = []
  for (let i = 1; i <= n; i++) out.push(await client.readContract({ address: proxy, abi: proxyAbi, functionName: 'phaseAggregators', args: [i] }))
  return out
}
/** Interior jumps in round id, per aggregator. */
function roundGaps(logs) {
  const by = new Map()
  for (const l of logs) {
    const a = l.address.toLowerCase()
    if (!by.has(a)) by.set(a, [])
    by.get(a).push({ id: l.args.roundId, block: l.blockNumber })
  }
  const gaps = []
  for (const [agg, rs] of by) {
    rs.sort((x, y) => (x.id < y.id ? -1 : 1))
    for (let i = 1; i < rs.length; i++) {
      const missing = rs[i].id - rs[i - 1].id - 1n
      if (missing > 0n) gaps.push({ agg, afterBlock: rs[i - 1].block, beforeBlock: rs[i].block, missingRounds: Number(missing) })
    }
  }
  return gaps
}

if (MODE === 'feeds') {
  // Sample windows spread over the Aave V3 era (the corpus's range).
  const WINDOWS = [16_400_000n, 18_500_000n, 20_400_000n, 22_300_000n, 24_200_000n, 25_900_000n].map((s) => [s, s + 99_999n])
  report.feeds = []
  for (const verify of ['none', VERIFY]) {
    const ring = new RpcRing(table, ringOpts(verify))
    const client = ring.readClient()
    for (const [name, proxy] of Object.entries(FEEDS)) {
      const aggs = await aggregators(client, proxy)
      for (const [from, to] of WINDOWS) {
        const { logs, coverage } = await ring.getLogsWideChecked({ address: aggs, event: ANSWER_UPDATED, fromBlock: from, toBlock: to }, CONC)
        const gaps = roundGaps(logs)
        const row = { ring: verify === 'none' ? 'old (no check)' : `fixed (verify ${verify})`, feed: name, from: String(from), to: String(to), rounds: logs.length, gaps: gaps.length, missingRounds: gaps.reduce((s, g) => s + g.missingRounds, 0), recovered: coverage.recovered.length, unverified: coverage.unverified.length }
        report.feeds.push(row)
        console.log(JSON.stringify(row))
      }
    }
    console.log(`  ${verify}: ${ringStats(ring)} | checks ${JSON.stringify(ring.checks())}`)
    report[`stats_${verify}`] = { stats: ring.stats(), checks: ring.checks() }
  }
}

if (MODE === 'aave') {
  const corpus = JSON.parse(readFileSync(join(process.cwd(), 'public', 'data', 'liquidation-corpus.json'), 'utf8'))
  const ring = new RpcRing(table, ringOpts(VERIFY))
  const client = ring.readClient()
  const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2'
  const from = BigInt(corpus.fromBlock)
  const to = BigInt(corpus.toBlock)
  // UTC year boundaries by binary search on block timestamps.
  const tsOf = async (b) => Number((await client.getBlock({ blockNumber: b })).timestamp)
  async function firstBlockAtOrAfter(ts) {
    let lo = from
    let hi = to
    while (lo < hi) {
      const mid = (lo + hi) / 2n
      if ((await tsOf(mid)) < ts) lo = mid + 1n
      else hi = mid
    }
    return lo
  }
  const years = corpus.byYear.map((y) => y.year)
  const bounds = {}
  for (const y of years.slice(1)) bounds[y] = await firstBlockAtOrAfter(Date.UTC(y, 0, 1) / 1000)
  console.log('year boundaries', Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, String(v)])))

  // In 1M-block slices so progress is visible and one slice's coverage is reported alone.
  const SLICE = 1_000_000n
  const all = []
  const cov = { pieces: 0, confirmedEmpty: 0, recovered: [], unverified: [] }
  for (let s = from; s <= to; s += SLICE) {
    const e = s + SLICE - 1n < to ? s + SLICE - 1n : to
    const { logs, coverage } = await ring.getLogsWideChecked({ address: POOL, event: LIQUIDATION_CALL, fromBlock: s, toBlock: e }, CONC)
    all.push(...logs)
    cov.pieces += coverage.pieces
    cov.confirmedEmpty += coverage.confirmedEmpty
    cov.recovered.push(...coverage.recovered)
    cov.unverified.push(...coverage.unverified)
    console.log(`  ${s}-${e}: ${logs.length} events (total ${all.length}) recovered ${coverage.recovered.length} unverified ${coverage.unverified.length} | ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  }
  const seen = new Set()
  const events = all.filter((l) => {
    const k = `${l.transactionHash}:${l.logIndex}`
    if (seen.has(k)) return false
    seen.add(k)
    return Boolean(l.args?.user && l.args?.collateralAsset && l.args?.debtAsset)
  })
  const yearOf = (b) => {
    let y = years[0]
    for (const yy of years.slice(1)) if (b >= bounds[yy]) y = yy
    return y
  }
  const perYear = {}
  for (const l of events) perYear[yearOf(l.blockNumber)] = (perYear[yearOf(l.blockNumber)] ?? 0) + 1
  const accounts = new Set(events.map((l) => l.args.user.toLowerCase())).size
  // Per 10k-block bucket, aligned to the corpus's first block, so a reader with the
  // Neon table can diff bucket by bucket (and --db does it here).
  const BUCKET = 10_000n
  const bucketOf = (b) => Number((BigInt(b) - from) / BUCKET)
  const buckets = new Map()
  for (const l of events) buckets.set(bucketOf(l.blockNumber), (buckets.get(bucketOf(l.blockNumber)) ?? 0) + 1)
  let dbDiff = null
  if (argv.includes('--db')) {
    // READ-ONLY: two SELECTs against aave_liquidations. Nothing is written.
    const { readEnv } = await import('./lib/venue-reads.mjs')
    const { get } = readEnv()
    const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
    if (!dbUrl) throw new Error('--db: no DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
    const { neon } = await import('@neondatabase/serverless')
    const sql = neon(dbUrl)
    const rows = await sql`SELECT ((block - ${String(from)}::bigint) / 10000)::int AS b, count(*)::int AS n
                           FROM aave_liquidations WHERE block BETWEEN ${String(from)}::bigint AND ${String(to)}::bigint GROUP BY 1`
    const inDb = new Map(rows.map((r) => [r.b, r.n]))
    const short = [...new Set([...buckets.keys(), ...inDb.keys()])]
      .map((b) => ({ b, rescan: buckets.get(b) ?? 0, db: inDb.get(b) ?? 0 }))
      .filter((x) => x.rescan !== x.db)
      .sort((x, y) => x.b - y.b)
    const missing = []
    for (const s of short.filter((x) => x.rescan > x.db)) {
      const lo = from + BigInt(s.b) * BUCKET
      const have = new Set(
        (await sql`SELECT tx_hash, log_index FROM aave_liquidations WHERE block BETWEEN ${String(lo)}::bigint AND ${String(lo + BUCKET - 1n)}::bigint`).map(
          (r) => `${r.tx_hash.toLowerCase()}:${r.log_index}`,
        ),
      )
      for (const l of events) {
        if (bucketOf(l.blockNumber) !== s.b) continue
        if (!have.has(`${l.transactionHash.toLowerCase()}:${Number(l.logIndex)}`)) {
          missing.push({ block: String(l.blockNumber), tx: l.transactionHash, logIndex: Number(l.logIndex), user: l.args.user })
        }
      }
    }
    dbDiff = {
      buckets: short.map((x) => ({ fromBlock: String(from + BigInt(x.b) * BUCKET), toBlock: String(from + BigInt(x.b + 1) * BUCKET - 1n), rescan: x.rescan, db: x.db })),
      missingEvents: missing.length,
      missing,
    }
    console.log(`db diff: ${short.length} bucket(s) differ, ${missing.length} event(s) on chain but not in aave_liquidations`)
  }
  report.aave = {
    range: [String(from), String(to)],
    rescan: { events: events.length, accounts, perYear },
    published: { events: corpus.events, accounts: corpus.accounts, perYear: Object.fromEntries(corpus.byYear.map((y) => [y.year, y.events])) },
    diff: {
      events: events.length - corpus.events,
      accounts: accounts - corpus.accounts,
      perYear: Object.fromEntries(years.map((y) => [y, (perYear[y] ?? 0) - (corpus.byYear.find((r) => r.year === y)?.events ?? 0)])),
    },
    coverage: { pieces: cov.pieces, confirmedEmpty: cov.confirmedEmpty, recovered: cov.recovered.map((r) => ({ ...r, fromBlock: String(r.fromBlock), toBlock: String(r.toBlock) })), unverified: cov.unverified.map((r) => ({ ...r, fromBlock: String(r.fromBlock), toBlock: String(r.toBlock) })) },
    stats: ring.stats(),
    checks: ring.checks(),
    dbDiff,
    bucketBlocks: Number(BUCKET),
    buckets: Object.fromEntries([...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => [String(from + BigInt(b) * BUCKET), n])),
  }
  const { buckets: _omit, ...shown } = report.aave
  console.log(JSON.stringify({ ...shown, dbDiff: dbDiff && { buckets: dbDiff.buckets, missingEvents: dbDiff.missingEvents } }, null, 2))
}

// Per-endpoint scorecard of every call this run made (both rings in feeds mode).
console.log('\nRPC scorecard (this run):\n' + formatScorecard(scorecard(calls)))
console.log('pieces by verdict:', JSON.stringify(pieceVerdicts(calls)))
report.scorecard = scorecard(calls)
report.pieces = pieceVerdicts(calls)
if (OUT) writeFileSync(OUT, JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2) + '\n')
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
