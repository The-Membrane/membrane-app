// Read-only, block-pinned pilot for the preregistered scrvUSD quote target.
// node scripts/research/curve-leading-quote-study.mjs --days 7 --step-blocks 900
// Requires an Ethereum archive RPC in RECORDER_RPC_URL (or --rpc URL).
// No database or local server access. Output is a bounded JSON research summary.

import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'
import { readFileSync, writeFileSync } from 'node:fs'

const HOUR = 3600
const DAY = 24 * HOUR
const options = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, index, all) => (arg.startsWith('--') ? [[arg.slice(2), all[index + 1]]] : [])),
)
function positiveInteger(name, fallback, max) {
  const value = options[name] === undefined ? fallback : Number(options[name])
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`--${name} must be an integer from 1 to ${max}`)
  return value
}
let days = positiveInteger('days', 7, 400)
let stepBlocks = positiveInteger('step-blocks', 900, 7200)
const maxSamples = positiveInteger('max-samples', 1000, 5000)
const sizes = [10_000, 1_000_000, 20_000_000]
const targets = [
  { size: 20_000_000, deteriorationPp: 1 },
  { size: 1_000_000, deteriorationPp: 0.25 },
]

const venue = loadConfig().find((row) => row.name === 'scrvUSD' && row.enabled)
const markets = venue?.depthMarkets?.filter((row) => row.enabled && row.kind === 'curve-stableswap')
if (markets?.length !== 2) throw new Error('scrvUSD requires exactly two enabled Curve pools')
const rpc = options['samples-in']
  ? null
  : options.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
if (!options['samples-in'] && !rpc)
  throw new Error('Set RECORDER_RPC_URL or pass --rpc with an archive RPC')
const client = rpc ? makeClient(rpc) : null

const poolAbi = [
  {
    type: 'function',
    name: 'balances',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'get_dy',
    stateMutability: 'view',
    inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'A',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]
const tokenAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
]
const from = markets[0].exitFrom.toLowerCase()
if (!markets.every((m) => m.exitFrom.toLowerCase() === from))
  throw new Error('Configured Curve pools must share exitFrom')

async function getBlock(blockNumber) {
  return client.getBlock({ blockNumber })
}

let head
let startTime
let rows = []
let missing = { blocks: 0, multicall: 0, decimals: 0, balance: 0, quote: 0, parameter: 0 }
if (options['samples-in']) {
  if (options['samples-out'])
    throw new Error('--samples-in and --samples-out are mutually exclusive')
  const artifact = JSON.parse(readFileSync(options['samples-in'], 'utf8'))
  if (artifact.study !== 'scrvUSD historical direct quotes' || !Array.isArray(artifact.rows))
    throw new Error('Input is not a scrvUSD historical direct quotes artifact')
  if (
    !Number.isSafeInteger(artifact.days) ||
    artifact.days < 1 ||
    artifact.days > 400 ||
    !Number.isSafeInteger(artifact.stepBlocks) ||
    artifact.stepBlocks < 1 ||
    artifact.stepBlocks > 7200
  )
    throw new Error('Artifact has invalid days or stepBlocks metadata')
  if (options.days !== undefined && Number(options.days) !== artifact.days)
    throw new Error('--days conflicts with artifact metadata')
  if (
    options['step-blocks'] !== undefined &&
    Number(options['step-blocks']) !== artifact.stepBlocks
  )
    throw new Error('--step-blocks conflicts with artifact metadata')
  days = artifact.days
  stepBlocks = artifact.stepBlocks
  rows = artifact.rows
  if (rows.length < 3 || rows.length > maxSamples)
    throw new Error(
      'Artifact has an invalid sample count; adjust --max-samples only for verified large artifacts',
    )
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (
      !Number.isSafeInteger(row.block) ||
      !Number.isSafeInteger(row.at) ||
      !Array.isArray(row.pools) ||
      row.pools.length !== markets.length ||
      !row.quotes ||
      typeof row.quotes !== 'object' ||
      !Number.isFinite(row.imbalance)
    )
      throw new Error(`Invalid pinned sample at index ${i}`)
    if (i && (row.block - rows[i - 1].block !== stepBlocks || row.at <= rows[i - 1].at))
      throw new Error(`Artifact block grid/timestamps invalid at index ${i}`)
    for (let j = 0; j < markets.length; j++) {
      const pool = row.pools[j]
      if (
        pool.address?.toLowerCase() !== markets[j].address.toLowerCase() ||
        !Number.isFinite(pool.reserve0) ||
        !Number.isFinite(pool.reserve1) ||
        !Number.isFinite(pool.signedImbalance) ||
        sizes.some((size) => !Number.isFinite(pool.quotes?.[size]))
      )
        throw new Error(`Artifact pool/quote mismatch at sample ${i}, pool ${j}`)
    }
    for (const size of sizes) {
      const best = Math.max(...row.pools.map((pool) => pool.quotes[size]))
      if (!Number.isFinite(row.quotes[size]) || Math.abs(row.quotes[size] - best) > 1e-12)
        throw new Error(`Artifact best-pool quote mismatch at sample ${i}, size ${size}`)
    }
  }
  head = BigInt(rows.at(-1).block)
  startTime = rows.at(-1).at - days * DAY
  missing = {
    source: 'artifact; original per-call failure counts unavailable',
    blocks: null,
    multicall: null,
    decimals: null,
    balance: null,
    quote: null,
    parameter: null,
  }
} else {
  try {
    // Avoid treating a tip block that can still reorganize as historical truth.
    head = (await client.getBlockNumber()) - 64n
  } catch (error) {
    throw new Error(
      `Cannot reach Ethereum RPC for read-only study: ${String(error?.shortMessage || error).slice(0, 180)}`,
    )
  }
  const end = await getBlock(head)
  startTime = Number(end.timestamp) - days * DAY
  const approxBlocks = Math.ceil((days * DAY) / 12)
  const maxRequiredSamples = Math.ceil(approxBlocks / stepBlocks) + 3
  if (maxRequiredSamples > maxSamples)
    throw new Error(
      `Sampling needs about ${maxRequiredSamples} blocks; raise --max-samples or --step-blocks`,
    )

  for (let n = head; n >= 0n; n = n > BigInt(stepBlocks) ? n - BigInt(stepBlocks) : 0n) {
    if (rows.length >= maxSamples)
      throw new Error('Reached --max-samples before the requested history was covered')
    let block
    try {
      block = await getBlock(n)
    } catch (error) {
      missing.blocks++
      if (rows.length === 0)
        throw new Error(`Cannot read block ${n}: ${String(error).slice(0, 160)}`)
      throw new Error(
        `Archive block unavailable at ${n}; partial history is not a valid study: ${String(error).slice(0, 160)}`,
      )
    }
    const at = Number(block.timestamp)
    if (at < startTime) break
    const contracts = markets.flatMap((market) => {
      const fromIs0 = market.token0.toLowerCase() === from
      const to = fromIs0 ? market.token1 : market.token0
      const fromIndex = fromIs0 ? 0n : 1n
      const toIndex = fromIs0 ? 1n : 0n
      return [
        { address: market.token0, abi: tokenAbi, functionName: 'decimals' },
        { address: market.token1, abi: tokenAbi, functionName: 'decimals' },
        { address: market.address, abi: poolAbi, functionName: 'balances', args: [0n] },
        { address: market.address, abi: poolAbi, functionName: 'balances', args: [1n] },
        ...sizes.map((size) => ({
          address: market.address,
          abi: poolAbi,
          functionName: 'get_dy',
          args: [fromIndex, toIndex, BigInt(size) * 10n ** 18n],
        })),
        { address: market.address, abi: poolAbi, functionName: 'A' },
        { address: market.address, abi: poolAbi, functionName: 'fee' },
      ]
    })
    let result
    try {
      result = await client.multicall({
        contracts,
        blockNumber: n,
        allowFailure: true,
        batchSize: 16_000,
      })
    } catch (error) {
      missing.multicall++
      if (rows.length === 0)
        throw new Error(`Archive multicall failed at ${n}: ${String(error).slice(0, 160)}`)
      rows.push({ block: Number(n), at, pools: [], quotes: {} })
      if (n === 0n) break
      continue
    }
    const pools = markets.map((market, i) => {
      const part = result.slice(i * (6 + sizes.length), (i + 1) * (6 + sizes.length))
      const successful = (index, kind) => {
        if (part[index]?.status !== 'success') {
          missing[kind]++
          return null
        }
        return part[index].result
      }
      const d0 = successful(0, 'decimals')
      const d1 = successful(1, 'decimals')
      const b0 = successful(2, 'balance')
      const b1 = successful(3, 'balance')
      const fromIs0 = market.token0.toLowerCase() === from
      if ((fromIs0 ? d0 : d1) !== null && Number(fromIs0 ? d0 : d1) !== 18)
        throw new Error(
          `crvUSD decimals changed at block ${n}; quote input encoding requires review`,
        )
      const reserves = [b0, b1].map((raw, j) =>
        raw === null || [d0, d1][j] === null ? null : Number(raw) / 10 ** Number([d0, d1][j]),
      )
      const quotes = Object.fromEntries(
        sizes.map((size, j) => {
          const out = successful(4 + j, 'quote')
          const toDecimals = fromIs0 ? d1 : d0
          return [
            size,
            out === null || toDecimals === null
              ? null
              : Number(out) / 10 ** Number(toDecimals) / size,
          ]
        }),
      )
      const exit = reserves[fromIs0 ? 1 : 0]
      const input = reserves[fromIs0 ? 0 : 1]
      const amplification = successful(4 + sizes.length, 'parameter')
      const fee = successful(5 + sizes.length, 'parameter')
      return {
        pool: market.name,
        address: market.address,
        reserve0: reserves[0],
        reserve1: reserves[1],
        amplification: amplification === null ? null : String(amplification),
        feeRaw: fee === null ? null : String(fee),
        signedImbalance:
          exit !== null && input !== null && exit + input > 0
            ? (input - exit) / (input + exit)
            : null,
        quotes,
      }
    })
    const quotes = Object.fromEntries(
      sizes.map((size) => [
        size,
        pools.every((pool) => Number.isFinite(pool.quotes[size]))
          ? Math.max(...pools.map((pool) => pool.quotes[size]))
          : null,
      ]),
    )
    const weights = pools.map((pool) =>
      pool.reserve0 !== null && pool.reserve1 !== null ? pool.reserve0 + pool.reserve1 : null,
    )
    const imbalance = weights.every(Number.isFinite)
      ? pools.reduce((sum, pool, i) => sum + pool.signedImbalance * weights[i], 0) /
        weights.reduce((sum, value) => sum + value, 0)
      : null
    rows.push({ block: Number(n), at, pools, quotes, imbalance })
    if (n === 0n) break
  }
  rows.reverse()
}
if (rows.length < 3 || rows[0].at > startTime + 6 * HOUR)
  throw new Error('Archive coverage is shorter than requested by more than six hours')
const largestGapHours = Math.max(...rows.slice(1).map((r, i) => (r.at - rows[i].at) / HOUR))
if (largestGapHours > 4)
  throw new Error(
    `Historical grid gap ${largestGapHours.toFixed(3)}h exceeds the preregistered 4h maximum`,
  )

// Opt-in, exclusive-create raw artifact. Keep each pinned block so future
// feature ablations do not need another archive sweep or a mutable API cache.
if (options['samples-out']) {
  const path = options['samples-out']
  writeFileSync(
    path,
    JSON.stringify({ study: 'scrvUSD historical direct quotes', days, stepBlocks, rows }) + '\n',
    { flag: 'wx' },
  )
}

// All historical features use strictly earlier blocks. The anchor's quote is
// retained only for the target and the explicitly labeled quote-trend baseline.
function prior(i, seconds) {
  for (let j = i - 1; j >= 0; j--)
    if (rows[i].at - rows[j].at >= seconds && rows[i].at - rows[j].at <= seconds + 4 * HOUR)
      return rows[j]
  return null
}
function feature(i, size) {
  const now = rows[i]
  const h6 = prior(i, 6 * HOUR)
  const h24 = prior(i, DAY)
  const slope =
    h24 && Number.isFinite(now.imbalance) && Number.isFinite(h24.imbalance)
      ? now.imbalance - h24.imbalance
      : null
  const quoteTrend = (past) =>
    past && Number.isFinite(past.quotes[size]) && Number.isFinite(now.quotes[size])
      ? (past.quotes[size] - now.quotes[size]) * 100
      : null
  return {
    imbalance: now.imbalance,
    slope24h: slope,
    quoteTrend6hPp: quoteTrend(h6),
    quoteTrend24hPp: quoteTrend(h24),
  }
}
function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null
}
function evaluate(target) {
  const candidates = []
  const crossingTimes = []
  let incompleteFollowup = 0
  let missingOutcomeWindows = 0
  for (let i = 0; i < rows.length; i++) {
    const anchor = rows[i]
    const current = anchor.quotes[target.size]
    if (!Number.isFinite(current)) continue
    const future = rows.slice(i + 1).filter((r) => r.at - anchor.at <= DAY)
    if (!future.length || future.at(-1).at - anchor.at < 20 * HOUR) {
      incompleteFollowup++
      continue
    }
    if (
      future.some(
        (r, j) =>
          !Number.isFinite(r.quotes[target.size]) ||
          r.at - (j === 0 ? anchor.at : future[j - 1].at) > 4 * HOUR,
      )
    ) {
      missingOutcomeWindows++
      continue
    }
    const firstCross = future.find(
      (r) =>
        Number.isFinite(r.quotes[target.size]) &&
        (current - r.quotes[target.size]) * 100 >= target.deteriorationPp,
    )
    candidates.push({
      i,
      at: anchor.at,
      crossing: firstCross?.at ?? null,
      features: feature(i, target.size),
    })
    if (firstCross) crossingTimes.push(firstCross.at)
  }
  crossingTimes.sort((a, b) => a - b)
  const episodes = []
  for (const at of crossingTimes) {
    const last = episodes.at(-1)
    if (!last || at - last.last >= 48 * HOUR) episodes.push({ first: at, last: at })
    else last.last = at
  }
  // Episode level controls have full followup, no crossing, and are separated
  // from one another and from target episodes by 48h.
  const controls = []
  for (const row of candidates) {
    if (
      row.crossing ||
      episodes.some(
        (event) => row.at >= event.first - 48 * HOUR && row.at <= event.last + 48 * HOUR,
      )
    )
      continue
    if (!controls.length || row.at - controls.at(-1) >= 48 * HOUR) controls.push(row.at)
  }
  const splitAt = rows[0].at + (rows.at(-1).at - rows[0].at) * 0.7
  const train = candidates.filter((r) => r.at < splitAt - DAY)
  const holdout = candidates.filter((r) => r.at >= splitAt + DAY)
  const trainEpisodes = episodes.filter((event) => event.last < splitAt - DAY)
  const holdoutEpisodes = episodes.filter((event) => event.first >= splitAt + DAY)
  const trainControls = controls.filter((at) => at < splitAt - DAY)
  const holdoutControls = controls.filter((at) => at >= splitAt + DAY)
  const scores = {
    imbalance: (r) => r.features.imbalance,
    imbalanceSlope24h: (r) => r.features.slope24h,
    quoteTrend6h: (r) => r.features.quoteTrend6hPp,
    quoteTrend24h: (r) => r.features.quoteTrend24hPp,
  }
  const exploratorySignals = Object.fromEntries(
    Object.entries(scores).map(([name, score]) => {
      const threshold = quantile(train.map(score), 0.9)
      const alerts =
        threshold === null ? [] : holdout.filter((r) => score(r) !== null && score(r) >= threshold)
      const episodeOf = (r) =>
        r.crossing === null
          ? null
          : episodes.find((event) => r.crossing >= event.first && r.crossing <= event.last)
      const timely = alerts.filter((r) => {
        const event = episodeOf(r)
        return event && event.first - r.at >= 6 * HOUR
      })
      const alertedEpisodes = new Set(
        timely
          .map((r) =>
            episodes.findIndex((event) => r.crossing >= event.first && r.crossing <= event.last),
          )
          .filter((i) => i >= 0),
      )
      const weeks = holdout.length > 1 ? (holdout.at(-1).at - holdout[0].at) / (7 * DAY) : 0
      const falseAlerts = alerts.length - timely.length
      return [
        name,
        {
          trainP90: threshold,
          holdoutAlerts: alerts.length,
          timelyAlerts: timely.length,
          alertedEpisodes: alertedEpisodes.size,
          falseAlerts,
          falseAlertsPerVenueWeek: weeks > 0 ? falseAlerts / weeks : null,
          earliestLeadHours: timely.length
            ? Math.max(...timely.map((r) => (episodeOf(r).first - r.at) / HOUR))
            : null,
        },
      ]
    }),
  )
  return {
    ...target,
    candidateWindows: candidates.length,
    independentEpisodes: episodes.length,
    independentControls: controls.length,
    incompleteFollowup,
    missingOutcomeWindows,
    episodes: episodes.slice(0, 30).map((e) => ({
      firstCross: new Date(e.first * 1000).toISOString(),
      lastCross: new Date(e.last * 1000).toISOString(),
    })),
    trainWindows: train.length,
    trainTargetWindows: train.filter((r) => r.crossing !== null).length,
    trainIndependentEpisodes: trainEpisodes.length,
    trainIndependentControls: trainControls.length,
    holdoutWindows: holdout.length,
    holdoutTargetWindows: holdout.filter((r) => r.crossing !== null).length,
    holdoutIndependentEpisodes: holdoutEpisodes.length,
    holdoutIndependentControls: holdoutControls.length,
    embargoedOrSpanningEpisodes: episodes.length - trainEpisodes.length - holdoutEpisodes.length,
    exploratorySignals,
    promotionEligible: false,
    reason:
      episodes.length < 20 || controls.length < 20
        ? 'Fewer than 20 independent episodes or 20 controls; predictive promotion gate fails.'
        : 'Full walk-forward precision, baseline improvement, bootstrap and calibration gate not implemented; no predictive claim.',
  }
}

console.log(
  JSON.stringify(
    {
      study: 'preregistered scrvUSD direct underlying best-single-Curve-pool quote',
      headBlock: Number(head),
      days,
      stepBlocks,
      firstBlock: rows[0].block,
      lastBlock: rows.at(-1).block,
      firstAt: new Date(rows[0].at * 1000).toISOString(),
      lastAt: new Date(rows.at(-1).at * 1000).toISOString(),
      samples: rows.length,
      largestGapHours,
      samplesArtifact: options['samples-out'] ?? options['samples-in'] ?? null,
      missing,
      pools: markets.map(({ name, address, token0, token1, exitFrom }) => ({
        name,
        address,
        token0,
        token1,
        exitFrom,
      })),
      firstSample: rows[0],
      lastSample: rows.at(-1),
      targets: targets.map(evaluate),
      caveat:
        'Pilot only. Direct crvUSD swap leg; not scrvUSD redemption, a routed aggregate, or executable guaranteed exit. Current imbalance can coincide with quote damage. No predictive flag authorized.',
    },
    null,
    2,
  ),
)
