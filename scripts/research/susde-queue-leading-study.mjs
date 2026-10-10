// Read-only exploratory sUSDe cooldown-pressure study. No live alert is emitted.
// Run: node scripts/research/susde-queue-leading-study.mjs
//
// Preregistered BEFORE running (2026-09-25): At each observed, block-pinned
// secondary-market snapshot, compare sUSDe->DOLA get_dy for 1m sUSDe against
// its next 24h. Target = quote output/input falls >=0.25 percentage points;
// a useful alert must arrive >=6h before the first crossing. Candidate feature
// = owner-level USDe amount contractually maturing in 6-30h / contemporaneous
// DOLA exit reserve, using only requests and state known at the anchor block.
// Cluster crossings within 48h. Chronological 70/30 split with 24h embargo;
// fit threshold on train only. Promotion requires >=20 independent target
// episodes and >=20 controls, holdout precision >= baseline +10pp with a
// strictly-positive bootstrap 95% improvement interval. This tests an
// upstream hypothesis; maturity is not evidence the owner will sell USDe or
// sUSDe, and sUSDe->DOLA is only ONE secondary route.

import { neon } from '@neondatabase/serverless'
import { parseAbiItem } from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'

const HOUR = 3600
const DAY = 24 * HOUR
const WARMUP = 7 * DAY
const MAX_LOG_RANGE = 9_000n
const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
const rpc = process.env.RECORDER_RPC_URL || get('RECORDER_RPC_URL')
if (!dbUrl || !rpc) throw new Error('Read-only Neon and Ethereum archive RPC URLs are required')
const sql = neon(dbUrl)
const client = makeClient(rpc)
const venue = loadConfig().find((v) => v.name === 'sUSDe' && v.enabled)
const market = venue?.depthMarkets?.find((v) => v.enabled && v.kind === 'curve-stableswap')
if (!market || market.exitFrom.toLowerCase() !== venue.address.toLowerCase())
  throw new Error('Expected configured sUSDe exit pool')
const fromIndex = market.token0.toLowerCase() === venue.address.toLowerCase() ? 0n : 1n
const withdraw = parseAbiItem(
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
)
const durationChanged = parseAbiItem(
  'event CooldownDurationUpdated(uint24 previousDuration, uint24 newDuration)',
)
const cooldownAbi = [
  {
    type: 'function',
    name: 'cooldowns',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint104' }, { type: 'uint256' }],
  },
]
const durationAbi = [
  {
    type: 'function',
    name: 'cooldownDuration',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint24' }],
  },
]
const quoteAbi = [
  {
    type: 'function',
    name: 'get_dy',
    stateMutability: 'view',
    inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
]
const decimalsAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
]
const siloAbi = [
  {
    type: 'function',
    name: 'silo',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
]

const snapshots = await sql`
  SELECT block, observed_at, params
  FROM venue_snapshots
  WHERE venue = 'sUSDe' AND source = 'observed'
    AND observed_at >= now() - interval '35 days'
    AND params ? 'depthMarkets'
  ORDER BY block, observed_at`
if (snapshots.length < 10) throw new Error('Too few observed sUSDe secondary-depth snapshots')
const firstAt = Math.floor(new Date(snapshots[0].observed_at).getTime() / 1000)
const lastAt = Math.floor(new Date(snapshots.at(-1).observed_at).getTime() / 1000)
// The depth recorder started after the needed warmup. Find its exact earlier
// chain boundary by timestamp, rather than starting at the first saved flow.
let low = 0n
let high = BigInt(snapshots[0].block)
while (low + 1n < high) {
  const mid = (low + high) / 2n
  const block = await client.getBlock({ blockNumber: mid })
  if (Number(block.timestamp) <= firstAt - WARMUP) low = mid
  else high = mid
}
const startBlock = low
const flowRows = await sql`
  SELECT block, block_time, tx_hash, log_index, assets_raw
  FROM venue_flows
  WHERE venue = 'sUSDe' AND direction = 'out'
    AND block >= ${String(startBlock)}
    AND block <= ${String(snapshots.at(-1).block)}
  ORDER BY block, log_index`
if (!flowRows.length) throw new Error('No sUSDe request events in the 7d warmup/observation window')
const endBlock = BigInt(snapshots.at(-1).block)
const startDuration = Number(
  await client.readContract({
    address: venue.address,
    abi: durationAbi,
    functionName: 'cooldownDuration',
    blockNumber: startBlock,
  }),
)
if (startDuration > WARMUP)
  throw new Error(
    `Initial ${startDuration}s cooldown exceeds 7d warmup; full queue may be left-censored`,
  )
if (startDuration === 0)
  throw new Error(
    'Cooldown was disabled at warmup start; Withdraw logs are not necessarily queue initiations',
  )

const expected = new Map(flowRows.map((r) => [`${r.tx_hash.toLowerCase()}:${r.log_index}`, r]))
const events = []
let unrecordedCooldownLogs = 0
let durationChanges = 0
const silo = String(snapshots.at(-1).params.silo).toLowerCase()
const [initialSilo, finalSilo] = await Promise.all(
  [startBlock, endBlock].map((blockNumber) =>
    client.readContract({
      address: venue.address,
      abi: siloAbi,
      functionName: 'silo',
      blockNumber,
    }),
  ),
)
if (initialSilo.toLowerCase() !== silo || finalSilo.toLowerCase() !== silo)
  throw new Error(
    'Historical or current silo address differs from latest snapshot; event classification unsafe',
  )
for (let lo = startBlock; lo <= endBlock; lo += MAX_LOG_RANGE) {
  const hi = lo + MAX_LOG_RANGE - 1n < endBlock ? lo + MAX_LOG_RANGE - 1n : endBlock
  const [logs, settings] = await Promise.all([
    client.getLogs({ address: venue.address, event: withdraw, fromBlock: lo, toBlock: hi }),
    client.getLogs({ address: venue.address, event: durationChanged, fromBlock: lo, toBlock: hi }),
  ])
  for (const change of settings) {
    durationChanges++
    if (Number(change.args.newDuration) === 0 || Number(change.args.newDuration) > WARMUP)
      throw new Error(
        `Cooldown duration left the valid 1-7d reconstruction range at block ${change.blockNumber}`,
      )
  }
  for (const log of logs) {
    const key = `${log.transactionHash.toLowerCase()}:${Number(log.logIndex)}`
    const row = expected.get(key)
    if (!row) {
      if (log.args.receiver.toLowerCase() === silo) unrecordedCooldownLogs++
      continue
    }
    if (log.args.receiver.toLowerCase() !== silo)
      throw new Error(`Unexpected Withdraw receiver at ${key}; event may not initiate cooldown`)
    if (BigInt(row.assets_raw) !== log.args.assets)
      throw new Error(`Flow/log amount mismatch at ${key}`)
    events.push({
      block: Number(log.blockNumber),
      logIndex: Number(log.logIndex),
      at: Math.floor(new Date(row.block_time).getTime() / 1000),
      owner: log.args.owner,
      assets: Number(log.args.assets) / 1e18,
    })
    expected.delete(key)
  }
}
if (expected.size)
  throw new Error(`${expected.size} saved flow events lack matching onchain Withdraw logs`)
if (unrecordedCooldownLogs)
  throw new Error(`${unrecordedCooldownLogs} onchain cooldown logs missing from Neon flow corpus`)
events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)

// One pinned getter per owner/block. The getter is post-block state; applying
// it at the block boundary avoids double-counting same-block request resets.
const unique = new Map(events.map((e) => [`${e.owner.toLowerCase()}:${e.block}`, e]))
const changes = []
let failedCooldownReads = 0
const toRead = [...unique.values()]
for (let i = 0; i < toRead.length; i += 8) {
  const chunk = toRead.slice(i, i + 8)
  const results = await Promise.all(
    chunk.map(async (e) => {
      try {
        const [end, amount] = await client.readContract({
          address: venue.address,
          abi: cooldownAbi,
          functionName: 'cooldowns',
          args: [e.owner],
          blockNumber: BigInt(e.block),
        })
        return { ...e, end: Number(end), amount: Number(amount) / 1e18 }
      } catch {
        failedCooldownReads++
        return null
      }
    }),
  )
  changes.push(...results.filter(Boolean))
}
if (failedCooldownReads)
  throw new Error(
    `${failedCooldownReads} owner cooldown archive reads failed; queue series would be incomplete`,
  )
changes.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)

const quoteRows = []
let quoteFailures = 0
for (let i = 0; i < snapshots.length; i += 8) {
  const chunk = snapshots.slice(i, i + 8)
  const results = await Promise.all(
    chunk.map(async (s) => {
      const depth = s.params.depthMarkets?.find(
        (m) => m.address?.toLowerCase() === market.address.toLowerCase(),
      )
      const dolaReserve = Number(depth?.exitableUsd)
      if (!Number.isFinite(dolaReserve) || dolaReserve <= 0) return null
      try {
        const out = await client.readContract({
          address: market.address,
          abi: quoteAbi,
          functionName: 'get_dy',
          args: [fromIndex, 1n - fromIndex, 1_000_000n * 10n ** 18n],
          blockNumber: BigInt(s.block),
        })
        return {
          block: Number(s.block),
          at: Math.floor(new Date(s.observed_at).getTime() / 1000),
          quote: Number(out) / 1e24,
          dolaReserve,
        }
      } catch {
        quoteFailures++
        return null
      }
    }),
  )
  quoteRows.push(...results.filter(Boolean))
}
if (quoteFailures || quoteRows.length < 10)
  throw new Error(`${quoteFailures} historical quotes failed; refusing partial outcome series`)
quoteRows.sort((a, b) => a.block - b.block)
const largestQuoteGapHours = Math.max(
  ...quoteRows.slice(1).map((r, i) => (r.at - quoteRows[i].at) / HOUR),
)
const outputToken = fromIndex === 0n ? market.token1 : market.token0
const outputDecimals = await Promise.all(
  [quoteRows[0].block, quoteRows.at(-1).block].map((block) =>
    client.readContract({
      address: outputToken,
      abi: decimalsAbi,
      functionName: 'decimals',
      blockNumber: BigInt(block),
    }),
  ),
)
if (outputDecimals.some((value) => Number(value) !== 18))
  throw new Error('Historical output token decimals are not 18; quote normalization is invalid')

let nextChange = 0
const owners = new Map()
const anchors = []
let excludedIncompleteHorizon = 0
for (let i = 0; i < quoteRows.length; i++) {
  const row = quoteRows[i]
  while (nextChange < changes.length && changes[nextChange].block <= row.block) {
    const e = changes[nextChange++]
    owners.set(e.owner.toLowerCase(), { end: e.end, amount: e.amount })
  }
  let upcoming = 0
  for (const state of owners.values())
    if (state.end >= row.at + 6 * HOUR && state.end <= row.at + 30 * HOUR) upcoming += state.amount
  const horizon = quoteRows.slice(i + 1).findIndex((r) => r.at >= row.at + DAY)
  const coverage = horizon < 0 ? [] : quoteRows.slice(i, i + horizon + 2)
  if (!coverage.length || coverage.slice(1).some((r, j) => r.at - coverage[j].at > 4 * HOUR)) {
    excludedIncompleteHorizon++
    continue
  }
  const future = coverage.slice(1).filter((r) => r.at <= row.at + DAY)
  const crossing = future.find((r) => row.quote - r.quote >= 0.0025)
  if (!future.length) {
    excludedIncompleteHorizon++
    continue
  }
  anchors.push({
    at: row.at,
    block: row.block,
    pressure: upcoming / row.dolaReserve,
    upcomingUsde: upcoming,
    quote: row.quote,
    target: !!crossing,
    crossingAt: crossing?.at ?? null,
  })
}

const split = Math.floor(anchors.length * 0.7)
const boundary = anchors[split]?.at ?? Infinity
const train = anchors.slice(0, split).filter((a) => a.at < boundary - DAY)
const holdout = anchors.slice(split)
const sorted = train.map((a) => a.pressure).sort((a, b) => a - b)
const threshold = sorted[Math.floor(sorted.length * 0.9)] ?? null
const crossings = [...new Set(anchors.filter((a) => a.crossingAt).map((a) => a.crossingAt))].sort(
  (a, b) => a - b,
)
const episodes = crossings.filter((t, i) => i === 0 || t - crossings[i - 1] > 48 * HOUR)
const flagged = holdout.filter((a) => threshold !== null && a.pressure > threshold)
const timely = flagged.filter((a) => a.crossingAt && a.crossingAt - a.at >= 6 * HOUR)

console.log(
  JSON.stringify(
    {
      preregistration: 'top-of-file comment; no threshold or target tuned after seeing outcomes',
      source: {
        vault: venue.address,
        pool: market.address,
        observedFirst: new Date(firstAt * 1000).toISOString(),
        observedLast: new Date(lastAt * 1000).toISOString(),
        snapshots: snapshots.length,
        verifiedRequestLogs: events.length,
        uniqueOwnerBlockReads: unique.size,
        ownerCount: new Set(events.map((e) => e.owner.toLowerCase())).size,
        warmupSeconds: WARMUP,
        initialCooldownSeconds: startDuration,
        durationChanges,
        largestQuoteGapHours,
        missingDepthSnapshots: snapshots.length - quoteRows.length,
        excludedIncompleteHorizon,
        unmatchedOnchainCooldownLogs: unrecordedCooldownLogs,
        outputToken,
        outputTokenDecimalsAtBothEnds: outputDecimals.map(Number),
      },
      target: '1m sUSDe->DOLA quote output/input deteriorates >=0.25pp in next 24h',
      windows: anchors.length,
      positiveWindows: anchors.filter((a) => a.target).length,
      independentEpisodes48h: episodes.length,
      trainWindows: train.length,
      holdoutWindows: holdout.length,
      holdoutPositiveWindows: holdout.filter((a) => a.target).length,
      trainP90PressureThreshold: threshold,
      holdout: {
        alerts: flagged.length,
        timely: timely.length,
        falseOrTooLate: flagged.length - timely.length,
      },
      pressure: {
        maxUpcomingUsde: Math.max(0, ...anchors.map((a) => a.upcomingUsde)),
        maxToDolaReserve: Math.max(0, ...anchors.map((a) => a.pressure)),
      },
      caveats: [
        'Maturity is USDe claim eligibility, not proof of sUSDe secondary selling.',
        'One sUSDe/DOLA pool is not all routes.',
        'The snapshot window is short; no alert qualifies unless the preregistered event and precision gates pass.',
      ],
      eventAndControlCountGate:
        episodes.length >= 20 && anchors.length - anchors.filter((a) => a.target).length >= 20,
      promotionEligible: false, // Precision/CI gate is not implemented, so this must stay false.
    },
    null,
    2,
  ),
)
