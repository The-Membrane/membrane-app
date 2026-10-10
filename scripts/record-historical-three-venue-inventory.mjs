// Native Mac hourly stage: bounded retrospective, pinned Ethereum inventory.
// Usage: node scripts/record-historical-three-venue-inventory.mjs --capture --batch 32
//        node scripts/record-historical-three-venue-inventory.mjs --verify
// Every pass extends a frozen 900-block grid backward. Interrupted passes
// resume at the next missing block. No row is a prospective issue or forecast.
import { pathToFileURL } from 'node:url'
import { makeClient, readEnv } from './lib/venue-reads.mjs'
import {
  STEP_BLOCKS,
  manifestFromConfig,
  readHistoricalInventoryAt,
  verifyHistoricalThreeVenueInventory,
  appendHistoricalThreeVenueInventory,
  nextHistoricalBlock,
} from './lib/historicalThreeVenueInventory.mjs'

export function parseOptions(args) {
  let mode = null
  let batch = 32
  let maxDays = 400
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--capture' || args[i] === '--verify') {
      if (mode) throw new Error('historical_inventory_duplicate_mode')
      mode = args[i].slice(2)
    } else if (args[i] === '--batch' || args[i] === '--max-days') {
      const key = args[i++]
      const value = Number(args[i])
      if (!Number.isInteger(value)) throw new Error('historical_inventory_invalid_bound')
      if (key === '--batch') batch = value
      else maxDays = value
    } else throw new Error(`historical_inventory_unknown_option:${args[i]}`)
  }
  if (!mode || batch < 1 || batch > 64 || maxDays < 1 || maxDays > 400)
    throw new Error('historical_inventory_invalid_options')
  return { mode, batch, maxDays }
}

function rpcUrl() {
  let env = () => undefined
  try {
    env = readEnv().get
  } catch {
    /* Process env remains valid. */
  }
  return (
    process.env.RECORDER_RPC_URLS ||
    env('RECORDER_RPC_URLS') ||
    process.env.RECORDER_RPC_URL ||
    env('RECORDER_RPC_URL')
  )
}

export async function captureHistoricalThreeVenueInventory(
  client,
  {
    batch = 32,
    maxDays = 400,
    pause = () => new Promise((resolve) => setTimeout(resolve, 125)),
  } = {},
) {
  if ((await client.getChainId()) !== 1) throw new Error('historical_inventory_wrong_chain')
  const manifest = manifestFromConfig()
  const initial = verifyHistoricalThreeVenueInventory(undefined, manifest)
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  if (typeof finalized.number !== 'bigint' || typeof finalized.timestamp !== 'bigint')
    throw new Error('historical_inventory_bad_finalized_head')
  if (Date.now() / 1000 - Number(finalized.timestamp) > 2 * 3600)
    throw new Error('historical_inventory_stale_finalized_head')
  const cutoff = Number(finalized.timestamp) - maxDays * 86400
  let block = nextHistoricalBlock(finalized.number, initial.last)
  let captured = 0
  let oldest = initial.last?.source.timestamp ?? null
  for (; captured < batch && block > 0n; block -= STEP_BLOCKS) {
    const source = await client.getBlock({ blockNumber: block })
    if (Number(source.timestamp) < cutoff) break
    const point = await readHistoricalInventoryAt(client, block, manifest)
    const record = appendHistoricalThreeVenueInventory(point, { manifest })
    captured++
    oldest = record.source.timestamp
    if (captured < batch) await pause()
  }
  const verified = verifyHistoricalThreeVenueInventory(undefined, manifest)
  return {
    status: captured ? 'captured' : 'no_new_point',
    retrospective: true,
    captured,
    total: verified.count,
    newestBlock: verified.count
      ? Number(BigInt(verified.last.source.block) + STEP_BLOCKS * BigInt(verified.count - 1))
      : null,
    oldestBlock: verified.last?.source.block ?? null,
    oldestAt: oldest ? new Date(oldest * 1000).toISOString() : null,
    nextBlock: block > 0n ? block.toString() : null,
    sourceScope: ['sUSDe:Curve DOLA output', 'sUSDS:shared Sky USDC Pocket', 'sGHO:GHO vault cash'],
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.mode === 'verify') {
    const status = verifyHistoricalThreeVenueInventory()
    console.log(
      JSON.stringify({
        verified: true,
        count: status.count,
        oldestBlock: status.last?.source.block ?? null,
      }),
    )
    return
  }
  const url = rpcUrl()
  if (!url) throw new Error('RECORDER_RPC_URL_or_URLS_required')
  const result = await captureHistoricalThreeVenueInventory(makeClient(url), options)
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`historical-three-venue-inventory failed: ${error.message}`)
    process.exitCode = 1
  })
}
