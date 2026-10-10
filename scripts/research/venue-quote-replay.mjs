// Read-only historical executable quote replay for the latest observed
// secondary-depth event. Uses each Curve pool's own StableSwap get_dy, NOT a
// constant-product approximation. Direct underlying swap leg only.
// node scripts/research/venue-quote-replay.mjs --venue scrvUSD

import { neon } from '@neondatabase/serverless'
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
      SELECT snapshot_id, observed_at, prev, next FROM venue_events
      WHERE id = ${eventId}::uuid AND venue = ${name}
        AND kind = 'param_changed' AND next ? 'depth_usd' LIMIT 1`
  : await sql`
      SELECT snapshot_id, observed_at, prev, next FROM venue_events
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

function fullMarketSet(snapshot) {
  const observed = snapshot.params?.depthMarkets
  const expected = (venue.depthMarkets ?? []).filter((item) => item.enabled)
  return (
    Array.isArray(observed) &&
    observed.length === expected.length &&
    expected.every((item) => {
      const row = observed.find(
        (market) => market.address?.toLowerCase() === item.address.toLowerCase(),
      )
      return (
        row &&
        row.exitableUsd != null &&
        (item.kind === 'psm-buffer'
          ? row.reads?.buffer === true
          : row.reads?.reserve0 === true && row.reads?.reserve1 === true)
      )
    })
  )
}
if (!fullMarketSet(before) || !fullMarketSet(after))
  throw new Error('event snapshots have incomplete or mismatched market reads')

const dyAbi = [
  {
    type: 'function',
    name: 'get_dy',
    stateMutability: 'view',
    inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
]
const decAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
]
const sizes = (flag('sizes') ?? '10000,1000000,10000000,20000000')
  .split(',')
  .map((item) => Number(item))
  .filter((item) => Number.isInteger(item) && item > 0)
if (!sizes.length || sizes.length > 12) throw new Error('specify 1–12 positive integer USD sizes')

async function quote(market, snapshot, size) {
  const fromIs0 = market.exitFrom.toLowerCase() === market.token0.toLowerCase()
  const from = fromIs0 ? market.token0 : market.token1
  const to = fromIs0 ? market.token1 : market.token0
  const blockNumber = BigInt(snapshot.block)
  const [fromDecimals, toDecimals] = await Promise.all([
    client.readContract({ address: from, abi: decAbi, functionName: 'decimals', blockNumber }),
    client.readContract({ address: to, abi: decAbi, functionName: 'decimals', blockNumber }),
  ])
  const amount = BigInt(size) * 10n ** BigInt(fromDecimals)
  const out = await client.readContract({
    address: market.address,
    abi: dyAbi,
    functionName: 'get_dy',
    args: [fromIs0 ? 0n : 1n, fromIs0 ? 1n : 0n, amount],
    blockNumber,
  })
  const output = Number(out) / 10 ** Number(toDecimals)
  return { inputUsdProxy: size, outputUsdProxy: output, discountPct: (1 - output / size) * 100 }
}

const states = []
for (const [label, snapshot] of [
  ['before', before],
  ['after', after],
]) {
  const marketRows = []
  for (const market of markets) {
    const quotes = []
    for (const size of sizes) {
      try {
        quotes.push(await quote(market, snapshot, size))
      } catch (error) {
        quotes.push({ inputUsdProxy: size, error: String(error).split('\n')[0].slice(0, 160) })
      }
    }
    const saved = snapshot.params.depthMarkets.find(
      (item) => item.address.toLowerCase() === market.address.toLowerCase(),
    )
    marketRows.push({
      market: market.name,
      exitableInventoryUsdProxy: Number(saved.exitableUsd),
      quotes,
    })
  }
  states.push({
    label,
    block: Number(snapshot.block),
    at: new Date(snapshot.observed_at).toISOString(),
    depthUsdProxy: Number(snapshot.params.depth_usd),
    markets: marketRows,
    bestSingleMarket: sizes.map((size, i) => {
      const ranked = marketRows
        .map((row) => ({ market: row.market, ...row.quotes[i] }))
        .filter((row) => Number.isFinite(row.outputUsdProxy))
        .sort((a, b) => b.outputUsdProxy - a.outputUsdProxy)
      return ranked[0] ?? { inputUsdProxy: size, error: 'no readable quote' }
    }),
  })
}
console.log(
  JSON.stringify(
    {
      venue: name,
      eventAt: new Date(event.observed_at).toISOString(),
      blockPinnedSnapshots:
        before.params.read_block_pinned === true && after.params.read_block_pinned === true,
      states,
      caveat:
        'Historical get_dy at stored blocks; direct venue-underlying swap leg, best ONE pool only. Not a routed aggregate, vault redemption quote, gas/MEV estimate, or guarantee. Older snapshots lacked block-pinned reads.',
    },
    null,
    2,
  ),
)
