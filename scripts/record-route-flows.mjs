// Prospective secondary-exit flow/inventory recorder. Explicit first block;
// later native ticks resume the immutable local range chain. No model output.
// node scripts/record-route-flows.mjs --venue sUSDS --from-block 26093089
// node scripts/record-route-flows.mjs --capture [--chunk 200]
// node scripts/record-route-flows.mjs --verify
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { collectRouteRange, routeFor } from './lib/routeFlow.mjs'
import { localRouteFlowStore } from './lib/localRouteFlowStore.mjs'
import { loadConfig, makeClient, readEnv } from './lib/venue-reads.mjs'

function flag(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`route_flow_missing_${name}`)
  return value
}
function blockFlag(name) {
  const raw = flag(name)
  if (raw === undefined) return undefined
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`route_flow_invalid_${name}`)
  return BigInt(raw)
}

export async function recordRouteVenue({
  client,
  store,
  venue,
  fromBlock,
  toBlock,
  chunk = 200n,
  maxRanges,
  collectRange = collectRouteRange,
}) {
  routeFor(venue)
  if (chunk < 1n || chunk > 2000n) throw new Error('route_flow_invalid_chunk')
  if (
    maxRanges !== undefined &&
    (typeof maxRanges !== 'bigint' || maxRanges < 1n || maxRanges > 1000n)
  )
    throw new Error('route_flow_invalid_max_ranges')
  if ((await client.getChainId()) !== 1) throw new Error('route_flow_wrong_chain')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  if (
    typeof finalized?.number !== 'bigint' ||
    typeof finalized?.timestamp !== 'bigint' ||
    !/^0x[0-9a-fA-F]{64}$/.test(finalized.hash ?? '')
  )
    throw new Error('route_flow_invalid_finalized_head')
  const end = toBlock ?? finalized.number
  if (end > finalized.number) throw new Error('route_flow_nonfinalized_head')
  const prior = store.read(venue).at(-1)
  const from = prior ? BigInt(prior.toBlock) + 1n : fromBlock
  if (prior && fromBlock !== undefined && fromBlock !== from)
    throw new Error('route_flow_bootstrap_conflicts_chain')
  if (from === undefined) throw new Error('route_flow_bootstrap_required')
  if (from < 1n) throw new Error('route_flow_invalid_start')
  if (from > end) return { ranges: 0, events: 0, caughtUp: true }
  if (prior) {
    const boundary = await client.getBlock({ blockNumber: from - 1n })
    if (boundary.hash?.toLowerCase() !== prior.end.hash)
      throw new Error('route_flow_boundary_moved')
  }
  let ranges = 0
  let events = 0
  let lastSealedBlock = from - 1n
  for (
    let start = from;
    start <= end && (maxRanges === undefined || BigInt(ranges) < maxRanges);
    start += chunk
  ) {
    const stop = start + chunk - 1n < end ? start + chunk - 1n : end
    const range = await collectRange({ client, venue, from: start, to: stop, finalized })
    store.append(venue, range)
    lastSealedBlock = stop
    ranges++
    events += range.events.length
    console.log(
      JSON.stringify({
        venue: venue.name,
        status: 'sealed',
        from: String(start),
        to: String(stop),
        events: range.events.length,
        observedInventoryDeltaRaw: range.after.map((row, i) =>
          String(BigInt(row.inventoryRaw) - BigInt(range.before[i].inventoryRaw)),
        ),
      }),
    )
  }
  return { ranges, events, caughtUp: lastSealedBlock >= end }
}

async function main() {
  const names = new Set(['sUSDe', 'sUSDS', 'scrvUSD'])
  const selected = flag('venue')
  if (selected && !names.has(selected)) throw new Error('route_flow_invalid_venue')
  const venues = loadConfig().filter(
    (venue) => names.has(venue.name) && (!selected || venue.name === selected),
  )
  if (venues.length !== (selected ? 1 : 3)) throw new Error('route_flow_config_missing_venue')
  const store = localRouteFlowStore()
  if (process.argv.includes('--verify')) {
    for (const venue of venues) {
      const records = store.read(venue)
      console.log(
        JSON.stringify({
          venue: venue.name,
          status: 'verified_local',
          ranges: records.length,
          to: records.at(-1)?.toBlock ?? null,
          providerCompleteness: 'not_independently_proven',
        }),
      )
    }
    return
  }
  const { get } = readEnv()
  const rpc =
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL') ||
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL
  if (!rpc) throw new Error('route_flow_rpc_required')
  const client = makeClient(rpc)
  let failed = false
  for (const venue of venues) {
    try {
      const result = await recordRouteVenue({
        client,
        store,
        venue,
        fromBlock: blockFlag('from-block'),
        toBlock: blockFlag('to-block'),
        chunk: blockFlag('chunk') ?? 200n,
        maxRanges: blockFlag('max-ranges-per-venue'),
      })
      console.log(
        JSON.stringify({
          venue: venue.name,
          status: result.caughtUp ? 'caught_up' : 'bounded_progress',
          ...result,
        }),
      )
    } catch (error) {
      failed = true
      console.error(
        JSON.stringify({
          venue: venue.name,
          status:
            error.message === 'route_flow_bootstrap_required' ? 'bootstrap_required' : 'unsealed',
          reason: error.message,
        }),
      )
    }
  }
  if (failed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main()
