// discover-carry-strats.mjs — AUTO-DISCOVERY of carry strats (owner-approved).
//
// The owner ruling: "I don't want users to opt into tracks... scan mainnet for
// carry positions and track those strats specifically and make a dashboard of
// it." This is that scan. It is the auto-tracking counterpart to /api/radar/watch
// (which watches ONE address a user pasted); here we DISCOVER addresses to watch.
//
//   node scripts/discover-carry-strats.mjs
//     [--lookback-days <n>=30] [--max-addresses <n>=300] [--min-usd <n>=100000]
//     [--chunk <n>=10000] [--venue <name>]
//
// Per enabled venue in tools/venue-recorder.config.json it fetches Deposit events
// over the lookback window (ERC4626 Deposit — topic2 = owner; Aave Supply —
// indexed onBehalfOf), collecting the UNIQUE depositor addresses. Vaults and
// multisigs are legitimate strats and are NOT skipped; only the venue contracts
// themselves, their silos, the Aave pool and the zero address are excluded.
//
// For each candidate (deduped, newest-first, capped at --max-addresses) it reads
// the address's CURRENT positions via the SAME reader the live radar uses
// (scripts/lib/position-reads.mjs — one source of truth), and AUTO-WATCHES every
// address whose TOTAL position >= --min-usd by UPSERTing into strat_watches with
// label 'auto'. ON CONFLICT (address) DO NOTHING: an existing row's label and
// entry_positions are the baseline the recap tells "entered $X → now $Y" against,
// so a re-scan never overwrites them.
//
// This is a SCAN, not a cursor-based recorder: idempotence comes from the upsert,
// not from a resume cursor. Re-running is safe — it re-discovers and only inserts
// genuinely new strats.
//
// Env: RECORDER_RPC_URL (MAINNET) + DATABASE_URL(_UNPOOLED) from .env.local.

import { neon } from '@neondatabase/serverless'
import { parseAbiItem, getAddress, toEventHash } from 'viem'
import { readEnv, loadConfig, makeClient } from './lib/venue-reads.mjs'
import { readUsdByVenue } from './lib/position-reads.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const { get } = readEnv()
const rpcUrl = get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL
if (!rpcUrl) {
  console.error(
    'RECORDER_RPC_URL is unset. Set it in .env.local to a MAINNET Ethereum RPC ' +
      'supporting eth_getLogs (external venues — Ethena/Aave on mainnet, NOT anvil).',
  )
  process.exit(1)
}
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const LOOKBACK_DAYS = Number(arg('lookback-days', '30'))
const MAX_ADDRESSES = Number(arg('max-addresses', '300'))
const MIN_USD = Number(arg('min-usd', '100000'))
const CHUNK = BigInt(arg('chunk', '10000'))
const ONLY_VENUE = arg('venue', undefined)
const BLOCKS_PER_DAY = 7200n // mainnet ~12s/block; a scan window, not an exact bound

// Reader-facing labels (mirror LABELS in pages/api/_lib/radarReads.ts).
const LABELS = { 'aave-v3-usde': 'Aave', sUSDe: 'sUSDe', sUSDS: 'sUSDS', scrvUSD: 'scrvUSD' }

const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const ZERO = '0x0000000000000000000000000000000000000000'

const ERC4626_DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const AAVE_SUPPLY = parseAbiItem(
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
)
const SILO_ABI = [{ type: 'function', name: 'silo', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }]

const sql = neon(dbUrl)
const client = makeClient(rpcUrl)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function withRetry(fn, label, tries = 4) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const backoff = 400 * 2 ** i
      console.log(`    retry ${label} (${i + 1}/${tries}) after ${backoff}ms — ${String(e).split('\n')[0].slice(0, 110)}`)
      await sleep(backoff)
    }
  }
  throw lastErr
}

// getLogs over [from,to], auto-splitting on a range/limit error (public endpoints
// may cap below 10k blocks).
async function getLogsSplit(params, from, to) {
  try {
    return await withRetry(() => client.getLogs({ ...params, fromBlock: from, toBlock: to }), `getLogs ${from}-${to}`, 3)
  } catch (e) {
    if (to > from) {
      const mid = from + (to - from) / 2n
      const a = await getLogsSplit(params, from, mid)
      const b = await getLogsSplit(params, mid + 1n, to)
      return a.concat(b)
    }
    throw e
  }
}

// Depositor extractor per venue kind. Returns { params, pick } where params is the
// getLogs filter and pick(log) -> the depositor address (owner / onBehalfOf).
function depositStreamFor(venue) {
  if (venue.kind === 'erc4626-cooldown') {
    return { params: { address: getAddress(venue.address), event: ERC4626_DEPOSIT }, pick: (l) => l.args.owner }
  }
  if (venue.kind === 'atoken-liquidity') {
    return {
      params: { address: getAddress(AAVE_V3_POOL), event: AAVE_SUPPLY, args: { reserve: getAddress(venue.underlying) } },
      pick: (l) => l.args.onBehalfOf,
    }
  }
  return null
}

// --- main -------------------------------------------------------------------
const latest = await withRetry(() => client.getBlockNumber(), 'getBlockNumber')
const fromBlock = latest - BLOCKS_PER_DAY * BigInt(LOOKBACK_DAYS)
const startBlock = fromBlock < 0n ? 0n : fromBlock
console.log(
  `scan: blocks ${startBlock}-${latest} (~${LOOKBACK_DAYS}d), cap ${MAX_ADDRESSES} addresses, ` +
    `min $${MIN_USD.toLocaleString()}, chunk ${CHUNK}\n`,
)

const venues = loadConfig().filter((v) => v.enabled && (!ONLY_VENUE || v.name === ONLY_VENUE))

// Build the skip set: venue contracts, silos, the Aave pool, zero address.
const skip = new Set([ZERO.toLowerCase(), getAddress(AAVE_V3_POOL).toLowerCase()])
for (const v of venues) {
  skip.add(getAddress(v.address).toLowerCase())
  if (v.underlying) skip.add(getAddress(v.underlying).toLowerCase())
  if (v.kind === 'erc4626-cooldown') {
    try {
      const silo = await client.readContract({ address: getAddress(v.address), abi: SILO_ABI, functionName: 'silo' })
      if (silo && silo !== ZERO) skip.add(getAddress(silo).toLowerCase())
    } catch {
      /* no silo() on this vault — fine */
    }
  }
}

// Collect unique candidate depositors, NEWEST-first (bias toward active strats),
// ROUND-ROBIN across venues so the cap fills with a mix of all four rather than
// exhausting the first venue's depositors. Each pass scans one CHUNK window per
// venue, then steps every venue one window older.
const candidates = new Map() // lowercased -> checksummed
let seenLogs = 0
const state = venues
  .map((venue) => ({ venue, stream: depositStreamFor(venue), winTo: latest, done: false, count: 0 }))
  .filter((s) => {
    if (!s.stream) console.log(`[${s.venue.name}] unknown kind '${s.venue.kind}' — skipped`)
    return s.stream
  })

outer: while (candidates.size < MAX_ADDRESSES && state.some((s) => !s.done)) {
  for (const st of state) {
    if (st.done) continue
    const winFrom = st.winTo - CHUNK + 1n < startBlock ? startBlock : st.winTo - CHUNK + 1n
    const logs = await getLogsSplit(st.stream.params, winFrom, st.winTo)
    seenLogs += logs.length
    for (const l of logs) {
      const addr = st.stream.pick(l)
      if (!addr) continue
      const low = addr.toLowerCase()
      if (skip.has(low)) continue
      if (!candidates.has(low)) {
        candidates.set(low, getAddress(addr))
        st.count++
      }
    }
    if (winFrom === startBlock) st.done = true
    else st.winTo = winFrom - 1n
    if (candidates.size >= MAX_ADDRESSES) break outer
  }
}
for (const st of state) {
  console.log(`[${st.venue.name}] ${st.count} new depositors (topic0 ${toEventHash(st.stream.params.event).slice(0, 10)}…)`)
}

const candidateList = [...candidates.values()].slice(0, MAX_ADDRESSES)
console.log(`\n${seenLogs} deposit logs seen → ${candidates.size} unique depositors; reading ${candidateList.length} candidates' positions…\n`)

// Read positions with a small concurrency pool.
async function positionsOf(address) {
  const usdByVenue = await withRetry(() => readUsdByVenue(client, venues, address), `positions ${address.slice(0, 8)}`, 3)
  let total = 0
  const held = []
  for (const v of venues) {
    const usd = usdByVenue.get(v.name) ?? 0
    total += usd
    if (usd > 0) held.push({ venue: v.name, label: LABELS[v.name] ?? v.name, kind: v.kind, usd })
  }
  return { total, held }
}

let watched = 0
let alreadyTracked = 0
let belowMin = 0
let totalUsdTracked = 0
const POOL = 8
for (let i = 0; i < candidateList.length; i += POOL) {
  const batch = candidateList.slice(i, i + POOL)
  const results = await Promise.all(
    batch.map(async (address) => {
      try {
        return { address, ...(await positionsOf(address)) }
      } catch (e) {
        console.log(`  ${address.slice(0, 10)}… read failed (${String(e).split('\n')[0].slice(0, 80)}) — skipped`)
        return null
      }
    }),
  )
  for (const r of results) {
    if (!r) continue
    if (r.total < MIN_USD) {
      belowMin++
      continue
    }
    // ON CONFLICT DO NOTHING — never clobber an existing row's baseline/label.
    const ins = await sql`
      INSERT INTO strat_watches (address, label, entry_positions, created_at)
      VALUES (${r.address}, ${'auto'}, ${JSON.stringify(r.held)}::jsonb, now())
      ON CONFLICT (address) DO NOTHING
      RETURNING address`
    if (ins.length > 0) {
      watched++
      totalUsdTracked += r.total
      console.log(`  + watched ${r.address} — $${Math.round(r.total).toLocaleString()} (${r.held.map((h) => h.label).join(', ')})`)
    } else {
      alreadyTracked++
    }
  }
}

console.log('\n=== discovery summary ===')
console.log(`candidates seen (unique depositors): ${candidates.size}`)
console.log(`candidates positions-read:           ${candidateList.length}`)
console.log(`below --min-usd ($${MIN_USD.toLocaleString()}):            ${belowMin}`)
console.log(`already tracked (skipped):            ${alreadyTracked}`)
console.log(`newly watched (label 'auto'):        ${watched}`)
console.log(`total USD across newly watched:      $${Math.round(totalUsdTracked).toLocaleString()}`)
console.log('\nRun `npm run strats:refresh` next to populate current positions for the board.')
