// record-venue-flows.mjs — FLOW collection for the venue withdrawal-ability
// recorder (owner-approved). This is the demand-side companion to
// record-venue-liquidity.mjs:
//
//   snapshots (venue_snapshots) record CAPACITY  — what COULD exit at a block.
//   flows     (venue_flows)     record DEMAND    — what DID move, decoded from
//                                                  on-chain event logs.
//
// Together they enable the owner's saturation method: when the REALIZED outflow
// over a window ≈ the available capacity at that time, demand was likely
// CENSORED (withdrawers who could not be served).
//
// PROVENANCE: unlike snapshots there is no observed/backfilled split. Event logs
// ARE the on-chain record of past process, so fetching old logs is legitimate
// history, not reconstruction. Every row is an actual emitted event.
//
//   node scripts/record-venue-flows.mjs --from-block <n> [--to-block <n>] [--chunk <n>] [--venue <name>]
//
// Per enabled venue it fetches logs from the CURSOR ( = max(block)+1 in
// venue_flows for that venue, else --from-block, required on first run ) to
// --to-block ( default: latest ), in <=10k-block getLogs windows (drpc range
// safety; --chunk overrides). Inserts are idempotent — ON CONFLICT
// (venue, tx_hash, log_index) DO NOTHING — so a fetch that dies mid-way is
// resumed simply by re-running: the cursor picks up from the last inserted block.
//
// ERC4626 venues (kind 'erc4626-cooldown'): standard ERC4626 events on the vault
//   Deposit(sender, owner, assets, shares)                 → direction 'in'
//   Withdraw(sender, receiver, owner, assets, shares)      → direction 'out'
// aave-v3-usde (kind 'atoken-liquidity'): Aave V3 Pool events, filtered by the
//   USDe reserve (indexed topic):
//   Supply(reserve, user, onBehalfOf, amount, referralCode) → direction 'in'
//   Withdraw(reserve, user, to, amount)                     → direction 'out'
//
// Env: RECORDER_RPC_URL (a MAINNET RPC supporting archive + eth_getLogs) and
// DATABASE_URL(_UNPOOLED), both from .env.local. tsx/node get no Next env
// injection. If RECORDER_RPC_URL is unset the script exits(1) with the fix.

import { neon } from '@neondatabase/serverless'
import { parseAbiItem, toEventHash, getAddress } from 'viem'
import { readEnv, loadConfig, makeClient } from './lib/venue-reads.mjs'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const { get } = readEnv()
const rpcUrl = get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL
if (!rpcUrl) {
  console.error(
    'RECORDER_RPC_URL is unset. Set it in .env.local to a MAINNET Ethereum RPC ' +
      'supporting archive + eth_getLogs (these are external venues — Ethena/Aave ' +
      'on mainnet, NOT the local anvil), then re-run.',
  )
  process.exit(1)
}
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const sql = neon(dbUrl)
const client = makeClient(rpcUrl)

const DEFAULT_CHUNK = 10000n // drpc eth_getLogs block-range safety ceiling
const chunkFlag = arg('chunk')
const CHUNK = chunkFlag ? BigInt(chunkFlag) : DEFAULT_CHUNK
if (CHUNK <= 0n) {
  console.error('--chunk must be > 0')
  process.exit(1)
}
const fromBlockArg = arg('from-block')
const toBlockArg = arg('to-block')
const onlyVenue = arg('venue')

// Aave V3 Pool (mainnet). Flow events for aTokens are emitted by the Pool, not
// the aToken — filtered here by the reserve = underlying (an indexed topic).
const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'

// ERC4626 standard events (EIP-4626). assets is the underlying amount.
const ERC4626_DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const ERC4626_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
)
// Aave V3 Pool events. amount is the underlying amount.
const AAVE_SUPPLY = parseAbiItem(
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
)
const AAVE_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
)

// Resolve a venue's flow "streams" — one per direction. Each stream carries the
// contract address to scan, the decoded event, an optional indexed-arg filter,
// the direction, and how to pull the raw underlying amount out of a decoded log.
function streamsFor(venue) {
  if (venue.kind === 'erc4626-cooldown') {
    const address = getAddress(venue.address)
    return [
      { direction: 'in', address, event: ERC4626_DEPOSIT, amount: (l) => l.args.assets },
      { direction: 'out', address, event: ERC4626_WITHDRAW, amount: (l) => l.args.assets },
    ]
  }
  if (venue.kind === 'atoken-liquidity') {
    const address = getAddress(AAVE_V3_POOL)
    const reserve = getAddress(venue.underlying)
    return [
      { direction: 'in', address, event: AAVE_SUPPLY, args: { reserve }, amount: (l) => l.args.amount },
      { direction: 'out', address, event: AAVE_WITHDRAW, args: { reserve }, amount: (l) => l.args.amount },
    ]
  }
  return null
}

// --- resilient RPC wrappers ------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withRetry(fn, label, tries = 5) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const backoff = 400 * 2 ** i
      console.log(`    retry ${label} (${i + 1}/${tries}) after ${backoff}ms — ${String(e).split('\n')[0].slice(0, 120)}`)
      await sleep(backoff)
    }
  }
  throw lastErr
}

// getLogs over [from,to], auto-splitting the window on a range/limit error so a
// public endpoint's smaller-than-10k ceiling degrades gracefully instead of
// aborting the run.
async function getLogsSplit(stream, from, to) {
  const base = { address: stream.address, event: stream.event, fromBlock: from, toBlock: to }
  if (stream.args) base.args = stream.args
  try {
    return await withRetry(() => client.getLogs(base), `getLogs ${from}-${to}`, 3)
  } catch (e) {
    if (to > from) {
      const mid = from + (to - from) / 2n
      console.log(`    split ${from}-${to} → ${from}-${mid} + ${mid + 1n}-${to}`)
      const a = await getLogsSplit(stream, from, mid)
      const b = await getLogsSplit(stream, mid + 1n, to)
      return a.concat(b)
    }
    throw e
  }
}

// Block-timestamp cache: resolve each unique block once via eth_getBlockByNumber.
const blockTimeCache = new Map()
async function blockTime(bn) {
  if (blockTimeCache.has(bn)) return blockTimeCache.get(bn)
  const blk = await withRetry(() => client.getBlock({ blockNumber: bn }), `getBlock ${bn}`)
  const iso = new Date(Number(blk.timestamp) * 1000).toISOString()
  blockTimeCache.set(bn, iso)
  return iso
}

// Resolve many block times with a small, polite concurrency pool.
async function resolveBlockTimes(blocks) {
  const list = [...blocks]
  const POOL = 6
  for (let i = 0; i < list.length; i += POOL) {
    await Promise.all(list.slice(i, i + POOL).map((bn) => blockTime(bn)))
  }
}

// --- signature verification -------------------------------------------------
// Compute topic0 and do ONE real getLogs probe over a recent window per stream.
// A WRONG signature yields zero logs forever; we widen the probe to 50k blocks
// before declaring a stream unverified, so a merely quiet window doesn't trip it.
async function verifyStream(stream, latest) {
  const topic0 = toEventHash(stream.event)
  const win5k = { from: latest - 5000n < 0n ? 0n : latest - 5000n, to: latest }
  let logs = await getLogsSplit(stream, win5k.from, win5k.to)
  if (logs.length > 0) return { topic0, verified: true, probed: '5k', count: logs.length }
  const win50k = { from: latest - 50000n < 0n ? 0n : latest - 50000n, to: latest }
  logs = await getLogsSplit(stream, win50k.from, win50k.to)
  return { topic0, verified: logs.length > 0, probed: '50k', count: logs.length }
}

// --- main -------------------------------------------------------------------
const latest = await withRetry(() => client.getBlockNumber(), 'getBlockNumber')
const toBlock = toBlockArg !== undefined ? BigInt(toBlockArg) : latest
console.log(`latest block ${latest}; scanning up to ${toBlock}; chunk=${CHUNK}\n`)

const unverified = [] // {venue, direction, topic0}
const totals = [] // per-venue summary

for (const venue of loadConfig().filter((v) => v.enabled)) {
  if (onlyVenue && venue.name !== onlyVenue) continue
  const streams = streamsFor(venue)
  if (!streams) {
    console.log(`[${venue.name}] unknown kind '${venue.kind}' — no flow reader; skipped`)
    continue
  }

  // Cursor: resume from max(block)+1 in venue_flows, else --from-block.
  const [cur] = await sql`SELECT max(block) AS m FROM venue_flows WHERE venue = ${venue.name}`
  let fromBlock
  if (cur && cur.m !== null) {
    fromBlock = BigInt(cur.m) + 1n
    console.log(`[${venue.name}] ${venue.kind} — resuming from cursor block ${fromBlock} (max(block)+1)`)
  } else if (fromBlockArg !== undefined) {
    fromBlock = BigInt(fromBlockArg)
    console.log(`[${venue.name}] ${venue.kind} — first run, from --from-block ${fromBlock}`)
  } else {
    console.log(`[${venue.name}] ${venue.kind} — no rows yet and no --from-block given; SKIP (first run needs --from-block)`)
    continue
  }
  if (fromBlock > toBlock) {
    console.log(`  already current (cursor ${fromBlock} > toBlock ${toBlock}) — nothing to do`)
    totals.push({ venue: venue.name, inserted: 0, inRaw: 0n, outRaw: 0n, note: 'up-to-date' })
    continue
  }

  // Per-venue failures are non-fatal for scheduled runs: an RPC timeout on one
  // venue must not stop the others, and the cursor makes the lost ground free —
  // the next tick resumes from max(block)+1.
  try {

  // Verify each stream's signature against a real recent probe before bulk fetch.
  const active = []
  for (const stream of streams) {
    const v = await verifyStream(stream, latest)
    if (!v.verified) {
      console.log(
        `  UNVERIFIED ${stream.direction} (topic0 ${v.topic0}) — 0 logs over recent ${v.probed} blocks; ` +
          `NOT bulk-fetching this stream, reporting as unverified`,
      )
      unverified.push({ venue: venue.name, direction: stream.direction, topic0: v.topic0 })
      continue
    }
    console.log(`  verified ${stream.direction} (topic0 ${v.topic0}) — ${v.count} logs in probe ${v.probed}`)
    active.push(stream)
  }
  if (active.length === 0) {
    console.log('  no verified streams — skipping venue')
    totals.push({ venue: venue.name, inserted: 0, inRaw: 0n, outRaw: 0n, note: 'all streams unverified' })
    continue
  }

  let inserted = 0
  let inRaw = 0n
  let outRaw = 0n

  for (let winFrom = fromBlock; winFrom <= toBlock; winFrom += CHUNK) {
    const winTo = winFrom + CHUNK - 1n > toBlock ? toBlock : winFrom + CHUNK - 1n

    // Collect this window's logs across all verified streams.
    const rows = []
    const blocksNeeded = new Set()
    for (const stream of active) {
      const logs = await getLogsSplit(stream, winFrom, winTo)
      for (const l of logs) {
        const bn = l.blockNumber
        blocksNeeded.add(bn)
        const raw = stream.amount(l)
        rows.push({
          block: bn,
          direction: stream.direction,
          assetsRaw: raw,
          txHash: l.transactionHash,
          logIndex: l.logIndex,
        })
        if (stream.direction === 'in') inRaw += raw
        else outRaw += raw
      }
    }

    if (rows.length > 0) {
      await resolveBlockTimes(blocksNeeded)
      // Insert idempotently. One statement per row keeps neon's tagged-template
      // path simple and lets ON CONFLICT dedupe a resumed/overlapping range.
      for (const r of rows) {
        const res = await sql`
          INSERT INTO venue_flows (venue, block, block_time, direction, assets_raw, tx_hash, log_index)
          VALUES (${venue.name}, ${r.block.toString()}, ${blockTimeCache.get(r.block)},
                  ${r.direction}, ${r.assetsRaw.toString()}, ${r.txHash}, ${r.logIndex})
          ON CONFLICT (venue, tx_hash, log_index) DO NOTHING
          RETURNING id`
        if (res.length > 0) inserted++
      }
    }
    console.log(`  ${winFrom}-${winTo}: ${rows.length} logs (${inserted} inserted so far)`)
  }

  const scale = 1e18 // all four underlyings are 18-dec stables, valued at $1
  console.log(
    `[${venue.name}] done — ${inserted} rows inserted; ` +
      `in=$${(Number(inRaw) / scale).toLocaleString()} out=$${(Number(outRaw) / scale).toLocaleString()}`,
  )
  totals.push({ venue: venue.name, inserted, inRaw, outRaw })

  } catch (e) {
    console.log(`[${venue.name}] ERRORED mid-fetch (${e?.message ?? e}) — cursor resumes next run`)
    totals.push({ venue: venue.name, inserted: 0, inRaw: 0n, outRaw: 0n, note: 'errored — resumes from cursor' })
  }
}

console.log('\n=== flow recorder summary ===')
const scale = 1e18
for (const t of totals) {
  const extra = t.note ? ` (${t.note})` : ''
  console.log(
    `${t.venue}: ${t.inserted} rows${extra} — in=$${(Number(t.inRaw) / scale).toLocaleString()} out=$${(Number(t.outRaw) / scale).toLocaleString()}`,
  )
}
if (unverified.length > 0) {
  console.log('\nUNVERIFIED signatures (0 logs over 50k recent blocks — reported, not guessed):')
  for (const u of unverified) console.log(`  ${u.venue} ${u.direction}: topic0 ${u.topic0}`)
}
console.log(
  '\nCursor design: re-running continues from max(block)+1 per venue, and inserts are ON CONFLICT DO NOTHING, so a fetch that died mid-way is safely resumed by simply re-running this command.',
)
