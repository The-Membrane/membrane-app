// snapshot-demo-carry.mjs — pick the /simulator landing page's DEFAULT WALLET, and
// make it a REAL one.
//
//   node scripts/snapshot-demo-carry.mjs [--limit N] [--min 50000] [--max 3000000] [--dry]
//   node scripts/snapshot-demo-carry.mjs --address 0x…      snapshot one named wallet
//
// Owner ruling 2026-09-11: "why is the worked example not just the demo wallet shown?"
// The simulator used to open on an INVENTED position (lib/position-sim/demo.ts). A
// landing page selling a carry product cannot open on invented balances. This script
// replaces them with a snapshot of a real mainnet borrower.
//
// WHERE THE CANDIDATES COME FROM: strat_watches — the Carry Radar's watch list of
// addresses already observed deploying into the recorded venues. Ranked by their last
// scanned venue total, whales skipped (a $50M treasury is not the reader), then each
// candidate is put through THE SIM'S OWN adapters (lib/position-sim/adapters via tsx,
// run against RECORDER_RPC_URL) — not a re-implementation — so the JSON we commit is
// byte-for-byte what the page would have read live.
//
// THE BAR a candidate must clear (owner ruling 2026-09-12 — "we need to pick one WITH
// deployments for the carry sim"):
//   - a real lending borrow: totalDebtUsd > $20k on ANY adapter. A readable borrowApr
//     is PREFERRED, not required: Morpho Blue and Compound return null and excluding
//     them is exactly what left the page opening on a wallet with no carry at all.
//   - detectVenues status 'detected' AFTER excludeOwnCollateral: the deployed slice is
//     what Membrane charges through the venue yield instead of interest, so a borrower
//     whose only "deployment" is its own aToken collateral has no carry story
//   - deployed/debt in [0.3, 1.5] preferred: a position whose debt is actually working
//
// SEARCH STAGES, run in order, stopping at the first that yields a qualified wallet:
//   (a)  strat_watches, every row through ALL the sim's adapters
//   (a2) Aave V3 borrowers who hold a canonical venue token
//   (b)  Morpho Blue borrowers (Borrow.onBehalf over ~30d) who hold one
//   (c)  recent recipients of the savings tokens themselves
//
// OUTPUT: public/data/demo-carry.json — { address, readAt, block, position, detection,
// provenance }. Nothing is edited by hand afterwards; re-run the script instead.
//
// Env, from .env.local, hand-parsed (node gets no Next injection):
//   DATABASE_URL_UNPOOLED / DATABASE_URL   the strat_watches candidate list
//   RECORDER_RPC_URL                       a MAINNET rpc (comma list ok)

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { neon } from '@neondatabase/serverless'
import { getAddress, parseAbiItem } from 'viem'

import { readEnv, ROOT, makeClient } from './lib/venue-reads.mjs'

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt
}
const DRY = argv.includes('--dry')
/**
 * Snapshot ONE named address and skip the search entirely.
 *
 * The escape hatch, and it exists because the search has a measured dead end: see
 * "NO CANDIDATE QUALIFIED" below. Whatever address is passed here is still read
 * through the real adapters and the real venue scan — nothing about the honesty of
 * the snapshot changes, only how the address was chosen, which the output file
 * records.
 */
const ADDRESS_ARG = (() => {
  const i = argv.indexOf('--address')
  return i >= 0 && argv[i + 1] ? getAddress(argv[i + 1]) : null
})()
const LIMIT = flag('limit', 40)
const MIN_VENUE_USD = flag('min', 50_000)
const MAX_VENUE_USD = flag('max', 3_000_000)
const MIN_DEBT_USD = flag('min-debt', 20_000)
/** Days of ERC-4626 Deposit history to sweep when strat_watches yields nothing. */
const DISCOVER_DAYS = flag('discover-days', 10)
const NO_DISCOVER = argv.includes('--no-discover')
/** How many discovered borrowers get the full (expensive) adapter read. */
const DISCOVER_PROBE = flag('discover-probe', 25)
/** Below this the "deployed slice costs $0" line is not worth leading with. */
const MIN_DEPLOYED_USD = flag('min-deployed', 10_000)

const { get } = readEnv()
const rpcUrl = get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL
if (!rpcUrl) {
  console.error('RECORDER_RPC_URL is unset (see .env.local — a MAINNET rpc, not anvil).')
  process.exit(1)
}
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

// ------------------------------------------------------------------ candidates
const sql = neon(dbUrl)
const rows = await sql`
  SELECT address, last_scanned
  FROM strat_watches
  WHERE last_scanned IS NOT NULL
  ORDER BY (last_scanned->>'total_usd')::numeric DESC`

const scored = rows
  .map((r) => ({ address: getAddress(r.address), venueUsd: Number(r.last_scanned?.total_usd ?? 0) }))
  .filter((r) => Number.isFinite(r.venueUsd) && r.venueUsd > 0)

const inBand = scored.filter((r) => r.venueUsd >= MIN_VENUE_USD && r.venueUsd <= MAX_VENUE_USD)
// Whales are skipped, not dropped: if the band is thin we still look at the rest, in
// band-distance order, rather than returning nothing.
const outOfBand = scored.filter((r) => r.venueUsd < MIN_VENUE_USD || r.venueUsd > MAX_VENUE_USD)
const candidates = [...inBand, ...outOfBand].slice(0, LIMIT)

console.log(
  `strat_watches: ${rows.length} scanned rows · ${inBand.length} inside $${MIN_VENUE_USD.toLocaleString()}–$${MAX_VENUE_USD.toLocaleString()} · probing ${candidates.length}\n`,
)

// --------------------------------------------------------------------- discovery
// strat_watches is a VENUE-DEPOSITOR list (discover-carry-strats.mjs walks Deposit
// events), so most of its rows never borrowed anything. When none of them clears the
// bar we sweep the canonical venues ourselves, in the same direction but with the
// opposite filter: every recent depositor into a venue detectVenues actually scans,
// then keep only the ones Aave says carry debt.
//
// The cheap filter runs FIRST and is one multicall per batch: Pool.getUserAccountData
// gives totalDebtBase in 1e8 base units, so thousands of depositors collapse to a
// handful of borrowers before a single adapter is constructed.

const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const BLOCKS_PER_DAY = 7200n // ~12s blocks; a scan window, not an exact bound
const ERC4626_DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const AAVE_BORROW = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const poolAbi = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
]
const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]

/**
 * The venues detectVenues itself scans, parsed out of its own source file.
 *
 * Node cannot import the .ts module, and a second hand-kept copy of the list would
 * drift the moment someone adds a venue — so the list is READ from
 * lib/position-sim/venues.ts rather than restated here. If the shape of that file
 * changes this throws loudly instead of silently sweeping the wrong venues.
 */
function knownVenues() {
  const src = readFileSync(join(ROOT, 'lib', 'position-sim', 'venues.ts'), 'utf8')
  const body = src.slice(src.indexOf('KNOWN_VENUES'), src.indexOf('export interface DetectedVenue'))
  const out = []
  const re = /symbol:\s*'([^']+)'[\s\S]*?address:\s*'(0x[0-9a-fA-F]{40})'[\s\S]*?decimals:\s*(\d+)/g
  let m
  while ((m = re.exec(body)) !== null) out.push({ symbol: m[1], address: getAddress(m[2]), decimals: Number(m[3]) })
  if (out.length === 0) throw new Error('could not parse KNOWN_VENUES out of lib/position-sim/venues.ts')
  return out
}

/**
 * getLogs over [from, to], ALWAYS chunked.
 *
 * Do not "split only on error" here. The endpoint this script runs against
 * (RECORDER_RPC_URL) silently TRUNCATES a large range instead of failing: a 3-day and
 * a 6-day sweep of sUSDS both returned exactly 322 logs starting at the same block.
 * A sweep that reads back the same 322 rows however far back you ask is not a sweep,
 * and nothing in the response says so — measured 2026-09-11. So the range is walked in
 * fixed chunks, and any chunk that comes back near the cap is halved.
 */
const LOG_CHUNK = 2_000n
const NEAR_CAP = 300

async function getLogsSplit(client, params, from, to) {
  const out = []
  for (let lo = from; lo <= to; lo += LOG_CHUNK) {
    const hi = lo + LOG_CHUNK - 1n > to ? to : lo + LOG_CHUNK - 1n
    out.push(...(await getLogsChunk(client, params, lo, hi)))
  }
  return out
}

async function getLogsChunk(client, params, from, to) {
  let logs
  try {
    logs = await client.getLogs({ ...params, fromBlock: from, toBlock: to })
  } catch (e) {
    if (to <= from) throw e
    const mid = from + (to - from) / 2n
    return (await getLogsChunk(client, params, from, mid)).concat(
      await getLogsChunk(client, params, mid + 1n, to),
    )
  }
  if (logs.length >= NEAR_CAP && to > from) {
    const mid = from + (to - from) / 2n
    return (await getLogsChunk(client, params, from, mid)).concat(
      await getLogsChunk(client, params, mid + 1n, to),
    )
  }
  return logs
}

/** Recent depositors into the canonical venues who currently carry Aave debt. */
async function discoverBorrowers(venues) {
  const client = makeClient(rpcUrl)
  const latest = await client.getBlockNumber()
  const from = latest - BLOCKS_PER_DAY * BigInt(DISCOVER_DAYS)
  const skip = new Set([
    '0x0000000000000000000000000000000000000000',
    AAVE_V3_POOL.toLowerCase(),
    ...venues.map((v) => v.address.toLowerCase()),
  ])

  const owners = new Set()
  for (const v of venues) {
    let logs = []
    try {
      logs = await getLogsSplit(client, { address: getAddress(v.address), event: ERC4626_DEPOSIT }, from, latest)
    } catch (e) {
      console.log(`  ${v.symbol}: Deposit sweep failed — ${String(e).split('\n')[0].slice(0, 90)}`)
      continue
    }
    let added = 0
    for (const l of logs) {
      const owner = l.args?.owner
      if (!owner || skip.has(owner.toLowerCase())) continue
      if (!owners.has(getAddress(owner))) added++
      owners.add(getAddress(owner))
    }
    console.log(`  ${v.symbol}: ${logs.length} deposits · +${added} new depositors`)
  }
  const list = [...owners]
  console.log(`  ${list.length} unique depositors over ~${DISCOVER_DAYS}d — filtering on Aave debt…`)

  // Cheap filter: one getUserAccountData per address, batched.
  const withDebt = []
  const B = 120
  for (let i = 0; i < list.length; i += B) {
    const slice = list.slice(i, i + B)
    const res = await client.multicall({
      allowFailure: true,
      contracts: slice.map((a) => ({
        address: getAddress(AAVE_V3_POOL),
        abi: poolAbi,
        functionName: 'getUserAccountData',
        args: [a],
      })),
    })
    res.forEach((r, k) => {
      if (r.status !== 'success') return
      const debtUsd = Number(r.result[1]) / 1e8 // BASE_CURRENCY_UNIT
      if (debtUsd > MIN_DEBT_USD) withDebt.push({ address: slice[k], debtUsd })
    })
  }
  console.log(`  ${withDebt.length} of them carry more than $${MIN_DEBT_USD.toLocaleString()} of Aave debt`)

  // Second cheap filter: do they hold a canonical venue balance right now?
  const out = []
  for (let i = 0; i < withDebt.length; i += 40) {
    const slice = withDebt.slice(i, i + 40)
    const res = await client.multicall({
      allowFailure: true,
      contracts: slice.flatMap((c) =>
        venues.map((v) => ({ address: v.address, abi: erc20Abi, functionName: 'balanceOf', args: [c.address] })),
      ),
    })
    slice.forEach((c, k) => {
      let venueUsd = 0
      venues.forEach((v, j) => {
        const r = res[k * venues.length + j]
        if (r?.status === 'success') venueUsd += Number(r.result) / 10 ** v.decimals
      })
      if (venueUsd > 0) out.push({ address: c.address, venueUsd, debtUsd: c.debtUsd })
    })
  }
  out.sort((a, b) => b.venueUsd - a.venueUsd)
  console.log(`  ${out.length} hold a canonical venue balance AND carry Aave debt\n`)
  return out
}

/**
 * The same intersection approached from the other side, and the one that actually
 * finds people: sweep Aave V3 Borrow events, then ask which of those borrowers holds
 * a canonical venue token right now.
 *
 * The venue side is the small population (a few hundred fresh depositors a week) and
 * the borrower side is the large one, so starting from borrowers is what makes the
 * intersection non-empty. Both filters are multicalls; no adapter runs until an
 * address has cleared both.
 */
async function discoverFromBorrowSide(venues) {
  const client = makeClient(rpcUrl)
  const latest = await client.getBlockNumber()
  const from = latest - BLOCKS_PER_DAY * BigInt(DISCOVER_DAYS)
  let logs = []
  try {
    logs = await getLogsSplit(client, { address: getAddress(AAVE_V3_POOL), event: AAVE_BORROW }, from, latest)
  } catch (e) {
    console.log(`  Aave Borrow sweep failed — ${String(e).split('\n')[0].slice(0, 120)}`)
    return []
  }
  // `.map(getAddress)` would hand Array.map's INDEX to viem as the chainId argument
  // and produce a different EIP-1191 checksum per element — every address unique,
  // every subsequent balanceOf rejected as invalid, and a silent zero result. Wrap it.
  const borrowers = [
    ...new Set(logs.map((l) => l.args?.onBehalfOf).filter(Boolean).map((a) => getAddress(a))),
  ]
  console.log(`  ${logs.length} Aave V3 borrows over ~${DISCOVER_DAYS}d · ${borrowers.length} unique borrowers`)

  const holders = []
  const B = 40
  for (let i = 0; i < borrowers.length; i += B) {
    const slice = borrowers.slice(i, i + B)
    const res = await client.multicall({
      allowFailure: true,
      contracts: slice.flatMap((a) =>
        venues.map((v) => ({ address: v.address, abi: erc20Abi, functionName: 'balanceOf', args: [a] })),
      ),
    })
    slice.forEach((a, k) => {
      let venueUsd = 0
      venues.forEach((v, j) => {
        const r = res[k * venues.length + j]
        if (r?.status === 'success') venueUsd += Number(r.result) / 10 ** v.decimals
      })
      if (venueUsd >= MIN_DEPLOYED_USD) holders.push({ address: a, venueUsd })
    })
  }
  console.log(`  ${holders.length} of them hold at least $${MIN_DEPLOYED_USD.toLocaleString()} in a canonical venue`)

  const out = []
  for (let i = 0; i < holders.length; i += 120) {
    const slice = holders.slice(i, i + 120)
    const res = await client.multicall({
      allowFailure: true,
      contracts: slice.map((c) => ({
        address: getAddress(AAVE_V3_POOL),
        abi: poolAbi,
        functionName: 'getUserAccountData',
        args: [c.address],
      })),
    })
    res.forEach((r, k) => {
      if (r.status !== 'success') return
      const debtUsd = Number(r.result[1]) / 1e8
      if (debtUsd > MIN_DEBT_USD) out.push({ ...slice[k], debtUsd })
    })
  }
  // Best carry SHAPE first: deployed/debt closest to 1 is a borrower whose whole loan
  // is working, which is exactly the position the product is sold against.
  out.sort((a, b) => Math.abs(Math.log(a.venueUsd / a.debtUsd)) - Math.abs(Math.log(b.venueUsd / b.debtUsd)))
  console.log(`  ${out.length} carry more than $${MIN_DEBT_USD.toLocaleString()} of Aave debt AND hold a venue balance\n`)
  return out
}

// ------------------------------------------------------------ WIDENED SEARCH (b)(c)
// Owner ruling 2026-09-12: "It says the default wallet had no carries? We need to pick
// one WITH deployments for the carry sim." The Aave-only sweeps above found nobody —
// 49 strat_watches rows and 692 recent Aave borrowers, and every "detected deployment"
// was the borrower's own aEthUSDC collateral, which excludeOwnCollateral drops. The
// shape we actually need is a borrower on ONE protocol holding a venue token issued by
// ANOTHER, so the balance survives the collateral filter.
//
// Two more stages, run in order, stopping at the first that yields a qualified wallet:
//   (b) Morpho Blue borrowers — the singleton emits Borrow(id, caller, onBehalf, …), so
//       ~30 days of logs gives every fresh borrower on every market in one sweep.
//       Morpho's adapter returns borrowApr: null; the ruling accepts that (the rails
//       story needs the DEPLOYMENT; the cost line is optional).
//   (c) venue-token recipients — Transfer(to) on the savings tokens over ~30 days, then
//       the same adapter pass.
const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'
const MORPHO_BORROW = parseAbiItem(
  'event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
)
const ERC20_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
/** Days swept by the widened stages. The ruling says ~30. */
const WIDE_DAYS = flag('wide-days', 30)

/** Multicall balanceOf across the canonical venues; keeps holders above the floor. */
async function venueHolders(client, addresses, venues) {
  const out = []
  const B = 40
  for (let i = 0; i < addresses.length; i += B) {
    const slice = addresses.slice(i, i + B)
    const res = await client.multicall({
      allowFailure: true,
      contracts: slice.flatMap((a) =>
        venues.map((v) => ({ address: v.address, abi: erc20Abi, functionName: 'balanceOf', args: [a] })),
      ),
    })
    slice.forEach((a, k) => {
      let venueUsd = 0
      venues.forEach((v, j) => {
        const r = res[k * venues.length + j]
        if (r?.status === 'success') venueUsd += Number(r.result) / 10 ** v.decimals
      })
      if (venueUsd >= MIN_DEPLOYED_USD) out.push({ address: a, venueUsd })
    })
  }
  out.sort((a, b) => b.venueUsd - a.venueUsd)
  return out
}

/** (b) Morpho Blue borrowers over ~WIDE_DAYS who hold a canonical venue token. */
async function discoverMorphoBorrowers(venues) {
  const client = makeClient(rpcUrl)
  const latest = await client.getBlockNumber()
  const from = latest - BLOCKS_PER_DAY * BigInt(WIDE_DAYS)
  let logs = []
  try {
    logs = await getLogsSplit(client, { address: getAddress(MORPHO_BLUE), event: MORPHO_BORROW }, from, latest)
  } catch (e) {
    console.log(`  Morpho Borrow sweep failed — ${String(e).split('\n')[0].slice(0, 120)}`)
    return []
  }
  // `.map(getAddress)` would pass Array.map's index as viem's chainId — wrap it.
  const borrowers = [
    ...new Set(logs.map((l) => l.args?.onBehalf).filter(Boolean).map((a) => getAddress(a))),
  ]
  console.log(`  ${logs.length} Morpho Blue borrows over ~${WIDE_DAYS}d · ${borrowers.length} unique onBehalf`)
  const holders = await venueHolders(client, borrowers, venues)
  console.log(`  ${holders.length} of them hold at least $${MIN_DEPLOYED_USD.toLocaleString()} in a canonical venue\n`)
  return holders
}

/** (c) Recent recipients of the savings tokens themselves, ranked by holding. */
async function discoverVenueRecipients(venues) {
  const client = makeClient(rpcUrl)
  const latest = await client.getBlockNumber()
  const from = latest - BLOCKS_PER_DAY * BigInt(WIDE_DAYS)
  const skip = new Set([
    '0x0000000000000000000000000000000000000000',
    ...venues.map((v) => v.address.toLowerCase()),
  ])
  const recipients = new Set()
  // Only the savings tokens: an aToken Transfer sweep re-finds Aave suppliers, the
  // population the collateral filter already rejected.
  const seeds = venues.filter((v) => /^s/i.test(v.symbol))
  for (const v of seeds) {
    let logs = []
    try {
      logs = await getLogsSplit(client, { address: v.address, event: ERC20_TRANSFER }, from, latest)
    } catch (e) {
      console.log(`  ${v.symbol}: Transfer sweep failed — ${String(e).split('\n')[0].slice(0, 90)}`)
      continue
    }
    let added = 0
    for (const l of logs) {
      const to = l.args?.to
      if (!to || skip.has(to.toLowerCase())) continue
      if (!recipients.has(getAddress(to))) added++
      recipients.add(getAddress(to))
    }
    console.log(`  ${v.symbol}: ${logs.length} transfers · +${added} new recipients`)
  }
  const holders = await venueHolders(client, [...recipients], venues)
  console.log(`  ${holders.length} still hold at least $${MIN_DEPLOYED_USD.toLocaleString()} of a canonical venue\n`)
  return holders
}

// ------------------------------------------------------- chain read (real adapters)
// A tsx child so the SIM'S OWN TypeScript adapters do the reading. Imports are
// absolute into the repo, so node resolves viem et al. from the repo's node_modules
// even though the runner file itself lives in a temp directory.
const work = mkdtempSync(join(tmpdir(), 'demo-carry-'))
const runnerPath = join(work, 'read.ts')
writeFileSync(
  runnerPath,
  `
import { runAdapters } from '${ROOT}/lib/position-sim/adapters'
import { detectVenues } from '${ROOT}/lib/position-sim/venues'
import { carryCost } from '${ROOT}/lib/position-sim/carryCost'
import { getMainnetClient } from '${ROOT}/lib/position-sim/rpc'

const addresses = JSON.parse(process.argv[2]) as \`0x\${string}\`[]

// An async main rather than top-level await: tsx transforms a bare .ts through
// esbuild's cjs output, which rejects top-level await outright.
async function main() {
  const out: unknown[] = []
  const block = await getMainnetClient().getBlockNumber()
  for (const address of addresses) {
    try {
      const [results, detection] = await Promise.all([runAdapters(address), detectVenues(address)])
      // The page's OWN cost model decides which candidate wins, so the ranking can
      // never disagree with the number the hero will print — including its refusal to
      // count a venue balance that is already the position's collateral.
      const positions = results.flatMap((r) => r.positions)
      const position = positions.length
        ? positions.reduce((a, p) => (p.totalDebtUsd > a.totalDebtUsd ? p : a))
        : null
      out.push({ address, results, detection, carry: position ? carryCost(position, detection) : null })
    } catch (e) {
      out.push({ address, error: (e as Error).message })
    }
  }
  process.stdout.write(
    '@@JSON@@' +
      JSON.stringify({ block: Number(block), out }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  )
}
void main()
`,
  'utf8',
)

/** Reads a slice of addresses through the real adapters. */
function readBatch(addresses) {
  const res = spawnSync(
    join(ROOT, 'node_modules', '.bin', 'tsx'),
    [runnerPath, JSON.stringify(addresses)],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // The adapters read through lib/position-sim/rpc, which prefers this override
      // over the keyless public list — same endpoint the recorder uses.
      env: { ...process.env, NEXT_PUBLIC_MAINNET_RPC_URL: rpcUrl.split(',')[0].trim() },
    },
  )
  if (res.status !== 0) {
    console.error(res.stderr?.slice(0, 2000))
    throw new Error(`tsx reader exited ${res.status}`)
  }
  const marker = res.stdout.indexOf('@@JSON@@')
  if (marker < 0) throw new Error(`tsx reader produced no JSON:\n${res.stdout.slice(0, 800)}`)
  return JSON.parse(res.stdout.slice(marker + 8))
}

const BATCH = 5
let block = 0
const probed = []
const seen = new Set()

function probe(addresses) {
 for (let i = 0; i < addresses.length; i += BATCH) {
  const slice = addresses.slice(i, i + BATCH).filter((a) => !seen.has(a))
  if (slice.length === 0) continue
  slice.forEach((a) => seen.add(a))
  const { block: b, out } = readBatch(slice)
  block = b
  for (const entry of out) {
    if (entry.error) {
      console.log(`  ${entry.address.slice(0, 10)}… read failed — ${entry.error.slice(0, 90)}`)
      continue
    }
    const positions = entry.results.flatMap((r) => r.positions)
    if (positions.length === 0 || !entry.carry) continue
    // The largest loan is the one whose cost matters, matching the simulator's own
    // default selection (Simulator.tsx).
    const position = positions.reduce((a, p) => (p.totalDebtUsd > a.totalDebtUsd ? p : a))
    const c = entry.carry
    probed.push({ ...entry, position, carry: c })
    console.log(
      `  ${entry.address} · ${position.label} · debt $${Math.round(position.totalDebtUsd).toLocaleString()}` +
        ` · priced $${Math.round(c.pricedDebtUsd).toLocaleString()}${c.aprWeighted > 0 ? ` @ ${(c.aprWeighted * 100).toFixed(2)}%` : ' @ no apr'}` +
        ` · deployed $${Math.round(c.deployedUsd).toLocaleString()}` +
        (c.collateralDeployedUsd > 0
          ? ` (+$${Math.round(c.collateralDeployedUsd).toLocaleString()} excluded: own collateral)`
          : '') +
        ` · fixed interest on covered $${Math.round(c.fixedCostOnCoveredUsd).toLocaleString()}/yr`,
    )
  }
 }
}

/**
 * THE BAR, as the owner reset it on 2026-09-12.
 *
 * It used to require a PRICED borrow (`pricedDebtUsd > 0`, `fixedCostOnCoveredUsd > 0`),
 * which silently excluded every Morpho Blue and Compound borrower — the adapters that
 * return `borrowApr: null`. That is what left the page opening on a wallet with no
 * carry at all. The ruling: "the rails story needs the deployment; the cost line is
 * optional." So the bar is now DEBT + A DEPLOYMENT THAT IS NOT ITS OWN COLLATERAL, on
 * any adapter, and a priced borrow is a PREFERENCE expressed in the sort below.
 */
const qualifies = (p) =>
  p.position.totalDebtUsd > MIN_DEBT_USD && p.carry.deployedUsd >= MIN_DEPLOYED_USD

if (ADDRESS_ARG) {
  console.log(`--address ${ADDRESS_ARG}: skipping the search.\n`)
  probe([ADDRESS_ARG])
} else {
  // (a) the watch list, through ALL the sim's adapters (runAdapters), not just Aave.
  probe(candidates.map((c) => c.address))
  console.log(`stage (a) strat_watches: ${probed.length} read · ${probed.filter(qualifies).length} qualified\n`)
}

// Stages run IN ORDER and stop at the first that yields a qualified wallet.
if (!ADDRESS_ARG && !NO_DISCOVER) {
  const venues = knownVenues()
  const stages = [
    ['(a2) Aave V3 borrowers holding a canonical venue token', () => discoverFromBorrowSide(venues)],
    ['(b) Morpho Blue borrowers holding a canonical venue token', () => discoverMorphoBorrowers(venues)],
    ['(c) recent savings-token recipients', () => discoverVenueRecipients(venues)],
  ]
  for (const [name, run] of stages) {
    if (probed.some(qualifies)) break
    console.log(`\nstage ${name} —`)
    const discovered = await run()
    for (const d of discovered.slice(0, DISCOVER_PROBE)) {
      console.log(
        `  candidate ${d.address} · venue $${Math.round(d.venueUsd).toLocaleString()}` +
          (d.debtUsd ? ` · aave debt $${Math.round(d.debtUsd).toLocaleString()}` : ''),
      )
    }
    console.log('')
    probe(discovered.slice(0, DISCOVER_PROBE).map((d) => d.address))
    console.log(
      `stage ${name}: ${discovered.length} candidates · probed ${Math.min(discovered.length, DISCOVER_PROBE)} · ${probed.filter(qualifies).length} qualified so far\n`,
    )
  }
}

rmSync(work, { recursive: true, force: true })

// --------------------------------------------------------------------- selection
const qualified = ADDRESS_ARG ? probed : probed.filter(qualifies)

if (qualified.length === 0) {
  console.error(
    '\nNO CANDIDATE QUALIFIED. Not one address across stages (a), (a2), (b) and (c) ' +
      'holds a lending-protocol borrow AND a canonical-venue deployment of at least ' +
      `$${MIN_DEPLOYED_USD.toLocaleString()} that is not its own collateral. That is a ` +
      'real finding, not a script failure. public/data/demo-carry.json was NOT written.',
  )
  process.exit(2)
}

// THE RULE, so the pick is a rule and not a hand-choice (owner 2026-09-12):
//   1. inside the size band (--min/--max on the venue deployment) — a $200M treasury
//      is not the reader, and neither is a $3k wallet;
//   2. deployed/debt in [0.3, 1.5] — a borrower whose loan is actually working;
//   3. a PRICED borrow ahead of an unpriced one, so the cost line renders when one is
//      available. It is a preference, not a filter: a Morpho/Compound borrower with a
//      real deployment beats an Aave borrower with none (that was the whole defect);
//   4. of those, the LARGEST annual saving, then the largest deployment when nothing
//      is priced at all.
// Each rule is a tier, so a thin field degrades to the next-best shape rather than
// returning nothing.
const ratioOf = (q) => q.carry.deployedUsd / q.position.totalDebtUsd
const tier = (q) => {
  const r = ratioOf(q)
  const inBand = q.carry.deployedUsd >= MIN_VENUE_USD && q.carry.deployedUsd <= MAX_VENUE_USD
  const inShape = r >= 0.3 && r <= 1.5
  return (inBand ? 0 : 4) + (inShape ? 0 : 2) + (q.carry.pricedDebtUsd > 0 ? 0 : 1)
}
qualified.sort(
  (a, b) =>
    tier(a) - tier(b) ||
    b.carry.fixedCostOnCoveredUsd - a.carry.fixedCostOnCoveredUsd ||
    b.carry.deployedUsd - a.carry.deployedUsd,
)
const pick = qualified[0]

const c = pick.carry
console.log('\n=== picked ===')
console.log(`address     ${pick.address}`)
console.log(`source      ${pick.position.label}`)
console.log(`collateral  $${Math.round(pick.position.totalCollateralUsd).toLocaleString()} (${pick.position.collateral.map((x) => x.symbol).join(' + ')})`)
console.log(`debt        $${Math.round(pick.position.totalDebtUsd).toLocaleString()} ${c.aprWeighted > 0 ? `@ ${(c.aprWeighted * 100).toFixed(2)}% weighted` : '(no borrow apr exposed by this adapter)'} (${pick.position.debt.map((x) => x.symbol).join(' + ')})`)
console.log(`deployed    $${Math.round(c.deployedUsd).toLocaleString()} (${(ratioOf(pick) * 100).toFixed(0)}% of debt) in ${pick.detection.detected.map((d) => d.venue.symbol).join(', ')}`)
console.log(`annual cost $${Math.round(c.annualCostUsd).toLocaleString()}`)
console.log(`savings/yr  $${Math.round(c.fixedCostOnCoveredUsd).toLocaleString()} on the covered $${Math.round(c.coveredDebtUsd).toLocaleString()}`)
console.log(`ltv         ${(pick.position.ltv * 100).toFixed(1)}% against a ${(pick.position.liquidationLtv * 100).toFixed(1)}% line`)

if (DRY) {
  console.log('\n--dry: nothing written.')
  process.exit(0)
}

const out = {
  address: pick.address,
  readAt: new Date().toISOString(),
  block,
  position: pick.position,
  detection: pick.detection,
  provenance: 'onchain snapshot',
  selection: ADDRESS_ARG
    ? 'named with --address'
    : 'ranked by the search rule (owner 2026-09-12: debt on any adapter + a canonical-venue ' +
      'deployment that is not its own collateral; priced borrow preferred, not required)',
}
const dest = join(ROOT, 'public', 'data', 'demo-carry.json')
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8')
console.log(`\nwrote ${dest}`)
