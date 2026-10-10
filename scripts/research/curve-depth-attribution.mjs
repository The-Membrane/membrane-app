// Read-only transaction-class reconciliation of the latest observed Curve
// exit-depth event. Event classes say what moved the exit-token balance, not
// why actors chose to trade/add/remove liquidity.
// node scripts/research/curve-depth-attribution.mjs --venue scrvUSD

import { neon } from '@neondatabase/serverless'
import { parseAbiItem, toEventHash } from 'viem'
import { readEnv, makeClient, loadConfig } from '../lib/venue-reads.mjs'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const name = flag('venue') || 'scrvUSD'
const eventId = flag('event-id')
const venue = loadConfig().find((item) => item.name === name && item.enabled)
if (!venue) throw new Error(`unknown enabled venue: ${name}`)
const markets = (venue.depthMarkets ?? []).filter(
  (item) => item.enabled && item.kind === 'curve-stableswap',
)
if (!markets.length) throw new Error(`${name} has no configured Curve exit market`)
const { get } = readEnv()
const sql = neon(get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL'))
const client = makeClient(get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL)
const [event] = eventId
  ? await sql`
    SELECT id, snapshot_id, observed_at FROM venue_events
    WHERE id = ${eventId}::uuid AND venue = ${name}
      AND kind = 'param_changed' AND next ? 'depth_usd' LIMIT 1`
  : await sql`
    SELECT id, snapshot_id, observed_at FROM venue_events
    WHERE venue = ${name} AND kind = 'param_changed' AND next ? 'depth_usd'
    ORDER BY observed_at DESC LIMIT 1`
if (!event?.snapshot_id) throw new Error(`no observed depth event for ${name}`)
const [after] =
  await sql`SELECT block, observed_at, params FROM venue_snapshots WHERE id = ${event.snapshot_id}`
const [before] = await sql`
  SELECT block, observed_at, params FROM venue_snapshots
  WHERE venue = ${name} AND source = 'observed' AND observed_at < ${after.observed_at}
  ORDER BY observed_at DESC LIMIT 1`
if (!before) throw new Error('event has no prior observed snapshot')

const transfer = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const balanceAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
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
const types = new Map(
  [
    ['TokenExchange(address,int128,uint256,int128,uint256)', 'swap'],
    ['TokenExchangeUnderlying(address,int128,uint256,int128,uint256)', 'swap'],
    ['AddLiquidity(address,uint256[2],uint256[2],uint256,uint256)', 'lp_add'],
    ['RemoveLiquidity(address,uint256[2],uint256[2],uint256)', 'lp_remove'],
    ['RemoveLiquidityOne(address,uint256,uint256,uint256)', 'lp_remove'],
    ['RemoveLiquidityImbalance(address,uint256[2],uint256[2],uint256,uint256)', 'lp_remove'],
  ].map(([signature, type]) => [toEventHash(signature), type]),
)

async function logsInChunks(address, fromBlock, toBlock, extra = {}) {
  const result = []
  for (let from = fromBlock; from <= toBlock; from += 1900n) {
    const to = from + 1899n < toBlock ? from + 1899n : toBlock
    result.push(...(await client.getLogs({ address, fromBlock: from, toBlock: to, ...extra })))
  }
  return result
}

function savedMarket(snapshot, market) {
  return snapshot.params?.depthMarkets?.find(
    (item) => item.address?.toLowerCase() === market.address.toLowerCase(),
  )
}

const results = []
for (const market of markets) {
  const prior = savedMarket(before, market)
  const current = savedMarket(after, market)
  if (
    !prior ||
    !current ||
    prior.exitableUsd == null ||
    current.exitableUsd == null ||
    prior.reads?.reserve0 !== true ||
    prior.reads?.reserve1 !== true ||
    current.reads?.reserve0 !== true ||
    current.reads?.reserve1 !== true
  ) {
    results.push({ market: market.name, status: 'unavailable: incomplete market snapshot' })
    continue
  }
  const fromIs0 = market.exitFrom.toLowerCase() === market.token0.toLowerCase()
  const exitToken = fromIs0 ? market.token1 : market.token0
  const [decimals, onchainBefore, onchainAfter] = await Promise.all([
    client.readContract({
      address: exitToken,
      abi: decimalsAbi,
      functionName: 'decimals',
      blockNumber: BigInt(before.block),
    }),
    client.readContract({
      address: exitToken,
      abi: balanceAbi,
      functionName: 'balanceOf',
      args: [market.address],
      blockNumber: BigInt(before.block),
    }),
    client.readContract({
      address: exitToken,
      abi: balanceAbi,
      functionName: 'balanceOf',
      args: [market.address],
      blockNumber: BigInt(after.block),
    }),
  ])
  const scale = 10 ** Number(decimals)
  const fromBlock = BigInt(before.block) + 1n
  const toBlock = BigInt(after.block)
  const [poolLogs, sent, received] = await Promise.all([
    logsInChunks(market.address, fromBlock, toBlock),
    logsInChunks(exitToken, fromBlock, toBlock, {
      event: transfer,
      args: { from: market.address },
    }),
    logsInChunks(exitToken, fromBlock, toBlock, { event: transfer, args: { to: market.address } }),
  ])
  const classByTx = new Map()
  for (const log of poolLogs) {
    const category = types.get(log.topics[0])
    if (!category) continue
    const set = classByTx.get(log.transactionHash) ?? new Set()
    set.add(category)
    classByTx.set(log.transactionHash, set)
  }
  const transferLogs = new Map()
  for (const log of [...sent, ...received])
    transferLogs.set(`${log.transactionHash}:${log.logIndex}`, log)
  const tx = new Map()
  for (const log of transferLogs.values()) {
    const from = log.args.from.toLowerCase()
    const to = log.args.to.toLowerCase()
    const pool = market.address.toLowerCase()
    if ((from === pool) === (to === pool)) continue
    const delta = ((to === pool ? 1 : -1) * Number(log.args.value)) / scale
    tx.set(log.transactionHash, (tx.get(log.transactionHash) ?? 0) + delta)
  }
  const totals = { swap: 0, lp_add: 0, lp_remove: 0, mixed: 0, direct_or_other: 0 }
  const transactions = []
  for (const [hash, netUsdProxy] of tx) {
    const classes = classByTx.get(hash) ?? new Set()
    const category =
      classes.size === 1 ? [...classes][0] : classes.size > 1 ? 'mixed' : 'direct_or_other'
    totals[category] += netUsdProxy
    transactions.push({ hash, category, netUsdProxy })
  }
  transactions.sort((a, b) => Math.abs(b.netUsdProxy) - Math.abs(a.netUsdProxy))
  const transferNet = Object.values(totals).reduce((a, b) => a + b, 0)
  const balanceDelta = Number(onchainAfter - onchainBefore) / scale
  const recordedDelta = Number(current.exitableUsd) - Number(prior.exitableUsd)
  const residual = recordedDelta - transferNet
  const grossMovement = transactions.reduce((sum, row) => sum + Math.abs(row.netUsdProxy), 0)
  const residualPct =
    (Math.abs(residual) / Math.max(Math.abs(recordedDelta), grossMovement, 1)) * 100
  const unclassifiedGross = transactions
    .filter((row) => row.category === 'direct_or_other')
    .reduce((sum, row) => sum + Math.abs(row.netUsdProxy), 0)
  const unclassifiedPct = (unclassifiedGross / Math.max(grossMovement, 1)) * 100
  results.push({
    market: market.name,
    exitToken,
    recordedReserveDeltaUsdProxy: recordedDelta,
    erc20BalanceDeltaUsdProxy: balanceDelta,
    transferNetUsdProxy: transferNet,
    byTransactionClassUsdProxy: totals,
    residualVsRecordedUsdProxy: residual,
    residualPctOfGrossMovement: residualPct,
    unclassifiedPctOfGrossMovement: unclassifiedPct,
    attributionGate95Pct:
      residualPct <= 5 && unclassifiedPct <= 5 && Math.abs(balanceDelta - transferNet) < 1,
    countedPoolLogs: poolLogs.length,
    countedTransferLogs: transferLogs.size,
    topTransactions: transactions.slice(0, 8),
  })
}
console.log(
  JSON.stringify(
    {
      eventId: event.id,
      venue: name,
      window: {
        from: new Date(before.observed_at).toISOString(),
        to: new Date(after.observed_at).toISOString(),
        fromBlock: Number(before.block),
        toBlock: Number(after.block),
      },
      blockPinnedSnapshots:
        before.params.read_block_pinned === true && after.params.read_block_pinned === true,
      results,
      caveat:
        'Classifies ERC20 transfers into Curve swap/LP event transactions and reconciles the exit-token balance. It does not infer actor motives, PegKeeper identity, or a causal volatility/governance effect. Older recorder snapshots may straddle stored blocks.',
    },
    null,
    2,
  ),
)
