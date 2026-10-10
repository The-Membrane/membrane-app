// Read-only, block-pinned upstream features for the preregistered scrvUSD quote target.
// node scripts/research/curve-upstream-feature-study.mjs --samples-in /private/tmp/scrvusd-leading-120d-20260925.json --features-out /private/tmp/scrvusd-features.json
// --tail-days 7 bounds an ABI/RPC pilot; it is NOT a promotion backtest.
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { decodeEventLog, parseAbiItem } from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'

const HOUR = 3600
const DAY = 24 * HOUR
const REGULATOR = '0x36a04CAffc681fa179558B2Aaba30395CDdd855f'
const TOKEN_EXCHANGE = parseAbiItem(
  'event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)',
)
const poolAbi = [
  {
    type: 'function',
    name: 'get_p',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'price_oracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]
const regulatorAbi = [
  {
    type: 'function',
    name: 'peg_keepers',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'address' }, { type: 'address' }, { type: 'bool' }, { type: 'bool' }],
  },
  {
    type: 'function',
    name: 'withdraw_allowed',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]
const keeperAbi = [
  {
    type: 'function',
    name: 'debt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'pool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
]
function flag(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? undefined : process.argv[at + 1]
}
function requirePath(name) {
  const value = flag(name)
  if (!value || value.startsWith('--')) throw new Error(`Pass --${name} PATH`)
  return value
}
function positiveInt(name, fallback, max) {
  const value = Number(flag(name) ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`--${name} must be an integer from 1 to ${max}`)
  return value
}
// Reuse the expensive pinned upstream reads for the original target or a
// separately labeled post-outcome split-route target. Zero RPC calls.
if (flag('features-in')) {
  const stored = JSON.parse(readFileSync(requirePath('features-in'), 'utf8'))
  const split = flag('split-in') ? JSON.parse(readFileSync(requirePath('split-in'), 'utf8')) : null
  const features = stored.features
  const splitRows = split?.rows
  if (
    !Array.isArray(features) ||
    (split && (!Array.isArray(splitRows) || features.length !== splitRows.length)) ||
    features.some(
      (r, i) =>
        !Number.isSafeInteger(r.block) ||
        !Number.isSafeInteger(r.at) ||
        !Number.isFinite(r.quote20m) ||
        (split &&
          (r.block !== splitRows[i].block ||
            r.at !== splitRows[i].at ||
            !Number.isFinite(splitRows[i].splitQuote))),
    )
  )
    throw new Error('Offline target does not exactly join to every pinned upstream feature row')
  const rowsWithSplit = features.map((r, i) => ({
    ...r,
    quote20m: split ? splitRows[i].splitQuote : r.quote20m,
  }))
  const candidates = []
  const crossingTimes = []
  for (let i = 0; i < rowsWithSplit.length; i++) {
    const row = rowsWithSplit[i]
    const future = rowsWithSplit.slice(i + 1).filter((r) => r.at - row.at <= DAY)
    if (
      !future.length ||
      future.at(-1).at - row.at < 20 * HOUR ||
      future.some((r, j) => r.at - (j ? future[j - 1].at : row.at) > 4 * HOUR)
    )
      continue
    const cross = future.find((r) => (row.quote20m - r.quote20m) * 100 >= 1)
    candidates.push({ ...row, crossing: cross?.at ?? null })
    if (cross) crossingTimes.push(cross.at)
  }
  crossingTimes.sort((a, b) => a - b)
  const episodes = []
  for (const at of crossingTimes) {
    const last = episodes.at(-1)
    if (!last || at - last.last >= 48 * HOUR) episodes.push({ first: at, last: at })
    else last.last = at
  }
  const splitAt = rowsWithSplit[0].at + (rowsWithSplit.at(-1).at - rowsWithSplit[0].at) * 0.7
  const train = candidates.filter((r) => r.at < splitAt - DAY)
  const holdout = candidates.filter((r) => r.at >= splitAt + DAY)
  const controls = []
  for (const row of candidates) {
    if (
      row.crossing ||
      episodes.some((e) => row.at >= e.first - 48 * HOUR && row.at <= e.last + 48 * HOUR)
    )
      continue
    if (!controls.length || row.at - controls.at(-1) >= 48 * HOUR) controls.push(row.at)
  }
  const featureFns = {
    netCrvUsdFlow6h: (r) => r.netCrvUsdFlow6h.total,
    netCrvUsdFlow24h: (r) => r.netCrvUsdFlow24h.total,
    maxAbsSpotOracleBps: (r) => r.maxAbsSpotOracleBps,
    negativeMinDebtWithdrawAllowance: (r) => -r.totalMinDebtWithdrawAllowanceCrvUsd,
  }
  const results = Object.fromEntries(
    Object.entries(featureFns).map(([name, score]) => {
      const sorted = train
        .map(score)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
      const threshold = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.9)] : null
      const flagged = holdout.filter((r) => threshold !== null && score(r) >= threshold)
      const alerts = []
      for (const row of flagged)
        if (!alerts.length || row.at - alerts.at(-1).at >= DAY) alerts.push(row)
      const hits = alerts.map((row) => {
        if (row.crossing === null) return null
        const e = episodes.find((x) => row.crossing >= x.first && row.crossing <= x.last)
        return e && e.first - row.at >= 6 * HOUR ? e.first : null
      })
      return [
        name,
        {
          trainP90: threshold,
          flaggedWindows: flagged.length,
          deduplicatedHoldoutAlerts: alerts.length,
          timelyAlerts: hits.filter((x) => x !== null).length,
          alertedEpisodes: new Set(hits.filter((x) => x !== null)).size,
          falseAlerts: hits.filter((x) => x === null).length,
        },
      ]
    }),
  )
  console.log(
    JSON.stringify(
      {
        study: split
          ? 'POST-OUTCOME exploratory split-route target, not preregistered'
          : 'preregistered best-single-pool direct crvUSD quote target, offline replay',
        sourceFeatures: flag('features-in'),
        splitArtifact: flag('split-in'),
        samples: rowsWithSplit.length,
        candidateWindows: candidates.length,
        independentEpisodes: episodes.length,
        independentControls: controls.length,
        trainIndependentEpisodes: episodes.filter((e) => e.last < splitAt - DAY).length,
        holdoutIndependentEpisodes: episodes.filter((e) => e.first >= splitAt + DAY).length,
        holdoutTargetWindows: holdout.filter((r) => r.crossing !== null).length,
        results,
        promotionEligible: false,
        caveat: split
          ? 'Redesigned target inspected after original outcomes; fewer than 20 nominal clusters and cluster independence unproven. No predictive alert authorized.'
          : 'No baseline/bootstrap gate and cluster independence unproven. No predictive alert authorized.',
      },
      null,
      2,
    ),
  )
  process.exit(0)
}
const inputPath = requirePath('samples-in')
const outputPath = requirePath('features-out')
const swapsInPath = flag('swaps-in')
const swapsOutPath = flag('swaps-out')
if (
  (process.argv.includes('--swaps-in') && !swapsInPath) ||
  (process.argv.includes('--swaps-out') && !swapsOutPath)
)
  throw new Error('Pass a path after --swaps-in or --swaps-out')
if (swapsInPath && swapsOutPath)
  throw new Error('--swaps-in and --swaps-out are mutually exclusive')
if (
  (swapsInPath && !swapsInPath.endsWith('.json.gz')) ||
  (swapsOutPath && !swapsOutPath.endsWith('.json.gz'))
)
  throw new Error('Raw swap artifacts use .json.gz (gzip-compressed JSON)')
const tailDays = flag('tail-days') === undefined ? null : positiveInt('tail-days', 7, 120)
const chunkBlocks = positiveInt('chunk-blocks', 50_000, 100_000)
const rpc = flag('rpc') || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
if (!rpc) throw new Error('Set RECORDER_RPC_URL or pass --rpc for archive reads')
const client = makeClient(rpc)
const artifact = JSON.parse(readFileSync(inputPath, 'utf8'))
if (
  artifact.study !== 'scrvUSD historical direct quotes' ||
  !Array.isArray(artifact.rows) ||
  artifact.rows.length < 10
)
  throw new Error('Input must be a verified scrvUSD historical direct quotes artifact')
const allRows = artifact.rows
for (let i = 1; i < allRows.length; i++) {
  if (
    !Number.isSafeInteger(allRows[i].block) ||
    !Number.isSafeInteger(allRows[i].at) ||
    allRows[i].block - allRows[i - 1].block !== artifact.stepBlocks ||
    allRows[i].at <= allRows[i - 1].at
  )
    throw new Error(`Invalid quote artifact block/timestamp grid at row ${i}`)
}
if (allRows.some((r) => !Number.isFinite(r.quotes?.[20_000_000])))
  throw new Error('Quote artifact has a missing $20m target quote')
const rows =
  tailDays === null ? allRows : allRows.filter((r) => r.at >= allRows.at(-1).at - tailDays * DAY)
if (rows.length < 10) throw new Error('Too few samples for feature study')
const venue = loadConfig().find((v) => v.name === 'scrvUSD' && v.enabled)
const markets = venue?.depthMarkets?.filter((m) => m.enabled && m.kind === 'curve-stableswap')
if (
  markets?.length !== 2 ||
  rows.some(
    (r) =>
      r.pools?.length !== 2 ||
      r.pools.some((p, i) => p.address?.toLowerCase() !== markets[i].address.toLowerCase()),
  )
)
  throw new Error('Configured pool mapping does not match pinned quote samples')
if (markets.some((m) => m.token1.toLowerCase() !== m.exitFrom.toLowerCase()))
  throw new Error('Expected crvUSD coin 1 in both configured pools; review TokenExchange direction')

// Include the pre-anchor 24h history. eth_getLogs ranges are deliberately
// bounded because archive providers reject broad requests even when sparse.
const fromBlock = BigInt(Math.max(0, rows[0].block - 8500))
const toBlock = BigInt(rows.at(-1).block)
const swaps = []
let logChunks = 0
if (swapsInPath) {
  const stored = JSON.parse(gunzipSync(readFileSync(swapsInPath)).toString('utf8'))
  if (
    stored.study !== 'scrvUSD raw Curve TokenExchange logs' ||
    stored.chainId !== 1 ||
    stored.fromBlock > Number(fromBlock) ||
    stored.toBlock < Number(toBlock) ||
    !Array.isArray(stored.poolAddresses) ||
    stored.poolAddresses.length !== markets.length ||
    stored.poolAddresses.some((p, i) => p.toLowerCase() !== markets[i].address.toLowerCase()) ||
    !Array.isArray(stored.swaps) ||
    stored.decodedSwaps !== stored.swaps.length
  )
    throw new Error('Raw swap artifact does not cover the requested pinned pools/block range')
  for (const swap of stored.swaps) {
    const sold = BigInt(swap.tokensSold)
    const bought = BigInt(swap.tokensBought)
    if (
      !Number.isSafeInteger(swap.block) ||
      swap.block < stored.fromBlock ||
      swap.block > stored.toBlock ||
      !Number.isSafeInteger(swap.logIndex) ||
      !markets.some((m) => m.address.toLowerCase() === swap.pool.toLowerCase()) ||
      ![0, 1].includes(swap.soldId) ||
      ![0, 1].includes(swap.boughtId) ||
      swap.soldId === swap.boughtId ||
      !Number.isFinite(swap.netCrvUsd) ||
      Math.abs(swap.netCrvUsd - Number(swap.soldId === 1 ? sold : -bought) / 1e18) > 1e-9
    )
      throw new Error(`Invalid cached swap at block ${swap.block}`)
    if (swap.block >= Number(fromBlock) && swap.block <= Number(toBlock)) swaps.push(swap)
  }
  logChunks = stored.logChunks
} else {
  for (const market of markets) {
    for (let from = fromBlock; from <= toBlock; from += BigInt(chunkBlocks)) {
      const to = from + BigInt(chunkBlocks - 1) < toBlock ? from + BigInt(chunkBlocks - 1) : toBlock
      const logs = await client.getLogs({
        address: market.address,
        fromBlock: from,
        toBlock: to,
        event: TOKEN_EXCHANGE,
      })
      logChunks++
      for (const log of logs) {
        if (log.topics.length !== 2)
          throw new Error(
            `Unexpected deployed TokenExchange indexed fields at block ${log.blockNumber}`,
          )
        const event = decodeEventLog({
          abi: [TOKEN_EXCHANGE],
          data: log.data,
          topics: log.topics,
          strict: true,
        })
        const { sold_id, tokens_sold, bought_id, tokens_bought } = event.args
        if (![0n, 1n].includes(sold_id) || ![0n, 1n].includes(bought_id) || sold_id === bought_id)
          throw new Error(`Unexpected coin ids at block ${log.blockNumber}`)
        const netCrvUsd = Number(sold_id === 1n ? tokens_sold : -tokens_bought) / 1e18
        if (!Number.isFinite(netCrvUsd))
          throw new Error(`Swap amount not finite at block ${log.blockNumber}`)
        swaps.push({
          block: Number(log.blockNumber),
          pool: market.address,
          logIndex: Number(log.logIndex),
          transactionHash: log.transactionHash,
          buyer: event.args.buyer,
          soldId: Number(sold_id),
          tokensSold: String(tokens_sold),
          boughtId: Number(bought_id),
          tokensBought: String(tokens_bought),
          netCrvUsd,
        })
      }
    }
  }
}
swaps.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
if (swapsOutPath) {
  const raw = {
    study: 'scrvUSD raw Curve TokenExchange logs',
    chainId: 1,
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    poolAddresses: markets.map((m) => m.address),
    logChunks,
    decodedSwaps: swaps.length,
    swaps,
  }
  writeFileSync(swapsOutPath, gzipSync(JSON.stringify(raw) + '\n', { level: 6 }), { flag: 'wx' })
}

// The regulator tuple is (keeper, pool, is_inverse, include_index) on this
// deployed regulator, verified by pinned raw eth_call before this study.
const keeperAddresses = []
const firstBlock = BigInt(rows[0].block)
for (let i = 0; i < 2; i++) {
  const [keeper, pool, inverse, includeIndex] = await client.readContract({
    address: REGULATOR,
    abi: regulatorAbi,
    functionName: 'peg_keepers',
    args: [BigInt(i)],
    blockNumber: firstBlock,
  })
  if (pool.toLowerCase() !== markets[1 - i].address.toLowerCase() || inverse || includeIndex)
    throw new Error(`Regulator keeper ${i} did not map to the expected deployed Curve pool`)
  const mappedPool = await client.readContract({
    address: keeper,
    abi: keeperAbi,
    functionName: 'pool',
    blockNumber: firstBlock,
  })
  if (mappedPool.toLowerCase() !== pool.toLowerCase())
    throw new Error(`Keeper ${i} pool() mismatch`)
  keeperAddresses.push({ keeper, pool, index: i })
}

function resultOf(result, label, block) {
  if (result?.status !== 'success')
    throw new Error(
      `${label} failed at pinned block ${block}: ${String(result?.error?.shortMessage || result?.error).slice(0, 140)}`,
    )
  return result.result
}
function swapUpperBound(block) {
  let lo = 0
  let hi = swaps.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (swaps[mid].block <= block) lo = mid + 1
    else hi = mid
  }
  return lo
}
async function enrichRow(row) {
  const swapCursor = swapUpperBound(row.block)
  // One bounded archive lookup per lower boundary, then use the block index
  // as the log cutoff; no post-anchor swaps enter any feature.
  async function lowerBlock(seconds) {
    let lo = Math.max(0, row.block - Math.ceil(seconds / 12) - 900)
    let hi = row.block
    const target = row.at - seconds
    const loBlock = await client.getBlock({ blockNumber: BigInt(lo) })
    if (Number(loBlock.timestamp) >= target)
      throw new Error(
        `Flow history before ${new Date(target * 1000).toISOString()} is shorter than required`,
      )
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const block = await client.getBlock({ blockNumber: BigInt(mid) })
      if (Number(block.timestamp) < target) lo = mid
      else hi = mid
    }
    return hi
  }
  const [lower6, lower24] = await Promise.all([lowerBlock(6 * HOUR), lowerBlock(DAY)])
  const sumFlow = (lower) => {
    let total = 0
    const byPool = Object.fromEntries(markets.map((m) => [m.address.toLowerCase(), 0]))
    for (let i = swapCursor - 1; i >= 0 && swaps[i].block >= lower; i--) {
      total += swaps[i].netCrvUsd
      byPool[swaps[i].pool.toLowerCase()] += swaps[i].netCrvUsd
    }
    return { total, byPool }
  }
  const calls = [
    ...markets.flatMap((market) => [
      { address: market.address, abi: poolAbi, functionName: 'get_p' },
      { address: market.address, abi: poolAbi, functionName: 'price_oracle' },
    ]),
    ...keeperAddresses.flatMap(({ keeper, index }) => [
      { address: REGULATOR, abi: regulatorAbi, functionName: 'peg_keepers', args: [BigInt(index)] },
      { address: keeper, abi: keeperAbi, functionName: 'debt' },
      { address: REGULATOR, abi: regulatorAbi, functionName: 'withdraw_allowed', args: [keeper] },
    ]),
  ]
  const result = await client.multicall({
    contracts: calls,
    blockNumber: BigInt(row.block),
    allowFailure: true,
    batchSize: 16000,
  })
  const poolFeatures = markets.map((market, i) => {
    const spot = resultOf(result[2 * i], 'get_p', row.block)
    const oracle = resultOf(result[2 * i + 1], 'price_oracle', row.block)
    return {
      address: market.address,
      spot: Number(spot) / 1e18,
      oracle: Number(oracle) / 1e18,
      spotMinusOracleBps: Number(spot - oracle) / 1e14,
      spotMinusOneBps: Number(spot - 10n ** 18n) / 1e14,
    }
  })
  const keeperFeatures = keeperAddresses.map((expected, i) => {
    const offset = 4 + i * 3
    const [keeper, pool, inverse, includeIndex] = resultOf(result[offset], 'peg_keepers', row.block)
    if (
      keeper.toLowerCase() !== expected.keeper.toLowerCase() ||
      pool.toLowerCase() !== expected.pool.toLowerCase() ||
      inverse ||
      includeIndex
    )
      throw new Error(
        `Historical registered PegKeeper mapping changed at block ${row.block}; do not use stale keeper`,
      )
    const debt = resultOf(result[offset + 1], 'debt', row.block)
    const allowed = resultOf(result[offset + 2], 'withdraw_allowed', row.block)
    return {
      keeper,
      pool,
      debtCrvUsd: Number(debt) / 1e18,
      withdrawAllowedRaw: String(allowed),
      minDebtWithdrawAllowanceCrvUsd: Number(allowed < debt ? allowed : debt) / 1e18,
    }
  })
  return {
    block: row.block,
    at: row.at,
    quote20m: row.quotes[20_000_000],
    netCrvUsdFlow6h: sumFlow(lower6),
    netCrvUsdFlow24h: sumFlow(lower24),
    pools: poolFeatures,
    keepers: keeperFeatures,
    maxAbsSpotOracleBps: Math.max(...poolFeatures.map((p) => Math.abs(p.spotMinusOracleBps))),
    totalMinDebtWithdrawAllowanceCrvUsd: keeperFeatures.reduce(
      (sum, k) => sum + k.minDebtWithdrawAllowanceCrvUsd,
      0,
    ),
  }
}
const enriched = []
for (let i = 0; i < rows.length; i += 8) {
  enriched.push(...(await Promise.all(rows.slice(i, i + 8).map(enrichRow))))
  if ((i + 8) % 200 === 0 || i + 8 >= rows.length)
    process.stderr.write(`enriched ${Math.min(i + 8, rows.length)}/${rows.length} pinned samples\n`)
}

// The target, 70/30 chronological split, 24h embargo, and 48h episode
// clustering are identical to the preregistered quote study. Repeated flagged
// windows are collapsed to one user alert per 24h suppression interval.
const crossingTimes = []
const candidates = []
for (let i = 0; i < enriched.length; i++) {
  const anchor = enriched[i]
  const future = enriched.slice(i + 1).filter((r) => r.at - anchor.at <= DAY)
  if (
    !future.length ||
    future.at(-1).at - anchor.at < 20 * HOUR ||
    future.some((r, j) => r.at - (j ? future[j - 1].at : anchor.at) > 4 * HOUR)
  )
    continue
  const firstCross = future.find((r) => (anchor.quote20m - r.quote20m) * 100 >= 1)
  candidates.push({ ...anchor, crossing: firstCross?.at ?? null })
  if (firstCross) crossingTimes.push(firstCross.at)
}
crossingTimes.sort((a, b) => a - b)
const episodes = []
for (const at of crossingTimes) {
  const last = episodes.at(-1)
  if (!last || at - last.last >= 48 * HOUR) episodes.push({ first: at, last: at })
  else last.last = at
}
const split = enriched[0].at + (enriched.at(-1).at - enriched[0].at) * 0.7
const train = candidates.filter((r) => r.at < split - DAY)
const holdout = candidates.filter((r) => r.at >= split + DAY)
const quantile = (values, q) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) * q)] : null
}
const featureFns = {
  netCrvUsdFlow6h: (r) => r.netCrvUsdFlow6h.total,
  netCrvUsdFlow24h: (r) => r.netCrvUsdFlow24h.total,
  maxAbsSpotOracleBps: (r) => r.maxAbsSpotOracleBps,
  negativeMinDebtWithdrawAllowance: (r) => -r.totalMinDebtWithdrawAllowanceCrvUsd,
}
const results = Object.fromEntries(
  Object.entries(featureFns).map(([name, score]) => {
    const threshold = quantile(train.map(score), 0.9)
    const flagged = holdout.filter((r) => threshold !== null && score(r) >= threshold)
    const alerts = []
    for (const row of flagged)
      if (!alerts.length || row.at - alerts.at(-1).at >= DAY) alerts.push(row)
    const hits = alerts.map((row) => {
      if (row.crossing === null) return null
      const episode = episodes.find((e) => row.crossing >= e.first && row.crossing <= e.last)
      return episode && episode.first - row.at >= 6 * HOUR ? episode.first : null
    })
    const alertedEpisodes = new Set(hits.filter((x) => x !== null))
    return [
      name,
      {
        trainP90: threshold,
        flaggedWindows: flagged.length,
        deduplicatedHoldoutAlerts: alerts.length,
        timelyAlerts: hits.filter((x) => x !== null).length,
        alertedEpisodes: alertedEpisodes.size,
        falseAlerts: hits.filter((x) => x === null).length,
      },
    ]
  }),
)
const controls = []
for (const row of candidates) {
  if (
    row.crossing ||
    episodes.some((e) => row.at >= e.first - 48 * HOUR && row.at <= e.last + 48 * HOUR)
  )
    continue
  if (!controls.length || row.at - controls.at(-1) >= 48 * HOUR) controls.push(row.at)
}
const summary = {
  study: 'scrvUSD upstream flow, peg, and registered PegKeeper exploratory test',
  quoteArtifact: inputPath,
  firstBlock: rows[0].block,
  lastBlock: rows.at(-1).block,
  samples: enriched.length,
  tailDays,
  swapSource: swapsInPath ? 'cached raw swap artifact' : 'archive RPC',
  rawSwapArtifact: swapsInPath ?? swapsOutPath ?? null,
  sourceLogChunks: logChunks,
  logChunksReadNow: swapsInPath ? 0 : logChunks,
  decodedSwaps: swaps.length,
  keeperAddresses,
  target: '$20m best-single-pool direct crvUSD exit quote worsens >=1.00pp within 24h; >=6h lead',
  candidateWindows: candidates.length,
  independentEpisodes: episodes.length,
  holdoutIndependentEpisodes: episodes.filter((e) => e.first >= split + DAY).length,
  holdoutTargetWindows: holdout.filter((r) => r.crossing !== null).length,
  independentControls: controls.length,
  results,
  promotionEligible: false,
  caveat: tailDays
    ? 'ABI/RPC pilot only; does not cover the full quote history.'
    : episodes.length < 20 || controls.length < 20
      ? 'Fewer than 20 independent episodes or controls; no predictive alert authorized.'
      : 'Nominal 48h clusters may chain over many days; independence and baseline/bootstrap gates have not been established. No predictive alert authorized.',
}
writeFileSync(outputPath, JSON.stringify({ summary, features: enriched }) + '\n', { flag: 'wx' })
console.log(JSON.stringify(summary, null, 2))
