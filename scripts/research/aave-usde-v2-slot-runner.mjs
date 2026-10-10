// Dormant v2 single-slot adapter. No import or execution of the legacy recorder.
// A resolved store.start() means its standalone SQL statement committed before RPC.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { loadConfig, makeClient, readDepthMarkets, readVenueState } from '../lib/venue-reads.mjs'

const SHA = /^[0-9a-f]{64}$/
const SLOT = /^aave-v3-usde:\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function errorReason(error) {
  return String(error?.message || error || 'unknown_failure').slice(0, 240)
}

async function failAfterStart(store, manifestSha, slotId, status, error) {
  try {
    await store.finish(manifestSha, slotId, status, errorReason(error))
  } catch (terminalError) {
    throw new AggregateError([error, terminalError], 'v2 slot failure and terminal write failure')
  }
  throw error
}

export async function runAaveUsdeV2Slot({ manifestSha, slotId, store, read }) {
  if (!SHA.test(manifestSha) || !SLOT.test(slotId)) throw new Error('invalid_v2_slot_identity')
  if (
    !store ||
    !['start', 'predecessor', 'success', 'finish'].every(
      (key) => typeof store[key] === 'function',
    ) ||
    typeof read !== 'function'
  )
    throw new Error('v2_slot_dependencies_required')

  // Duplicate, unconfirmed and closed slots reject here, without an RPC read.
  // Never put this call in an open client transaction with later steps.
  await store.start(manifestSha, slotId)

  let state
  try {
    state = await read()
    if (
      !state ||
      typeof state.block !== 'bigint' ||
      state.block < 0n ||
      !Number.isFinite(state.instantUsd) ||
      state.instantUsd < 0 ||
      state.params?.read_block_pinned !== true ||
      state.params?.read_block_finalized !== true ||
      state.params?.read_block_number !== state.block.toString() ||
      !BLOCK_HASH.test(state.params?.read_block_hash || '')
    )
      throw new Error('incomplete_finalized_usde_read')
  } catch (error) {
    return failAfterStart(store, manifestSha, slotId, 'read_failure', error)
  }

  try {
    const predecessor = await store.predecessor()
    if (predecessor !== null && (typeof predecessor !== 'string' || !UUID.test(predecessor)))
      throw new Error('invalid_atomic_predecessor')
    const id = await store.success(manifestSha, slotId, state, predecessor)
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('invalid_atomic_snapshot_id')
    return { status: 'success', snapshotId: id, slotId }
  } catch (error) {
    return failAfterStart(store, manifestSha, slotId, 'insert_failure', error)
  }
}

export function createPgV2SlotStore(sql) {
  return {
    async start(manifestSha, slotId) {
      const rows =
        await sql`SELECT public.start_aave_usde_v2_recorder(${manifestSha}, ${slotId}) AS started_at`
      if (!rows[0]?.started_at) throw new Error('v2_slot_start_unacknowledged')
    },
    async predecessor() {
      const rows = await sql`SELECT public.aave_usde_v2_atomic_predecessor()::text AS id`
      return rows[0]?.id ?? null
    },
    async success(manifestSha, slotId, state, predecessor) {
      const rows = await sql`SELECT public.ingest_aave_usde_v2_recorder_success(
        ${manifestSha}, ${slotId}, ${state.block.toString()}, ${state.instantUsd},
        ${state.coolingUsd ?? null}, ${state.strandedUsd ?? null},
        ${JSON.stringify(state.params)}::jsonb, ${predecessor}::uuid) AS snapshot_id`
      return rows[0]?.snapshot_id ?? null
    },
    async finish(manifestSha, slotId, status, reason) {
      const rows = await sql`SELECT public.finish_aave_usde_v2_recorder(
        ${manifestSha}, ${slotId}, ${status}, ${reason}) AS completed_at`
      if (!rows[0]?.completed_at) throw new Error('v2_slot_terminal_unacknowledged')
    },
  }
}

export async function readFinalizedAaveUsde(client, venue, nowSeconds = Date.now() / 1000) {
  if (venue?.name !== 'aave-v3-usde' || venue?.kind !== 'atoken-liquidity' || !venue.enabled)
    throw new Error('aave_usde_config_ineligible')
  if ((await client.getChainId()) !== 1) throw new Error('v2_wrong_chain')
  const block = await client.getBlock({ blockTag: 'finalized' })
  if (
    typeof block.number !== 'bigint' ||
    typeof block.timestamp !== 'bigint' ||
    !BLOCK_HASH.test(block.hash || '') ||
    nowSeconds - Number(block.timestamp) < -120 ||
    nowSeconds - Number(block.timestamp) > 7200
  )
    throw new Error('v2_invalid_finalized_block')
  const state = await readVenueState(client, venue, block.number)
  const depth = await readDepthMarkets(client, venue, block.number)
  if (depth) Object.assign(state.params, depth)
  const recheck = await client.getBlock({ blockNumber: block.number })
  if (recheck.hash !== block.hash || recheck.timestamp !== block.timestamp)
    throw new Error('v2_finalized_block_changed')
  if (
    state.params.underlyingIdentity !== 'match' ||
    state.params.decimalsIdentity !== 'match' ||
    state.params.reads?.underlyingBalance !== true ||
    state.params.reads?.variableDebt !== true ||
    !Number.isFinite(state.instantUsd)
  )
    throw new Error('v2_incomplete_usde_cash_read')
  Object.assign(state.params, {
    read_block_pinned: true,
    read_block_finalized: true,
    read_block_number: block.number.toString(),
    read_block_hash: block.hash,
    read_block_time: Number(block.timestamp),
  })
  return { block: block.number, ...state }
}

async function main(args) {
  if (args.length === 0) {
    console.log(
      'Dry mode: no SQL or RPC. Live use: --live --manifest SHA --slot aave-v3-usde:YYYY-MM-DDTHH:00:00.000Z',
    )
    return
  }
  if (args.length !== 5 || args[0] !== '--live' || args[1] !== '--manifest' || args[3] !== '--slot')
    throw new Error('usage: --live --manifest SHA --slot aave-v3-usde:YYYY-MM-DDTHH:00:00.000Z')
  const manifestSha = args[2]
  const slotId = args[4]
  if (!SHA.test(manifestSha) || !SLOT.test(slotId)) throw new Error('invalid_v2_slot_identity')
  const dbUrl = process.env.AAVE_USDE_V2_RECORDER_DATABASE_URL
  const rpcUrl = process.env.AAVE_USDE_V2_RECORDER_RPC_URL
  if (!dbUrl || !rpcUrl) throw new Error('dedicated_v2_recorder_credentials_required')
  const { neon } = await import('@neondatabase/serverless')
  const venue = loadConfig().find((candidate) => candidate.name === 'aave-v3-usde')
  const result = await runAaveUsdeV2Slot({
    manifestSha,
    slotId,
    store: createPgV2SlotStore(neon(dbUrl)),
    read: () => readFinalizedAaveUsde(makeClient(rpcUrl), venue),
  })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(errorReason(error))
    process.exitCode = 1
  })
}
