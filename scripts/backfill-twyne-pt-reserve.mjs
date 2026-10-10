// Separate historical Aave PT reserve cash, shared by suppliers. This is
// never Twyne wrapper cash, a holder exit quote, or a prospective receipt.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { readEnv, makeClient } from './lib/venue-reads.mjs'
import { anchorGrid, parseOptions, resolveAnchorBlock } from './backfill-carry-cash-archive.mjs'
import { collectTwynePtReserveObservation } from './record-twyne-pt-reserve.mjs'

export async function persistBackfill(sql, anchorAt, row) {
  const payloadBytes = JSON.stringify({
    anchorAt,
    captureKind: 'backfilled',
    chainId: row.chainId,
    wrapper: row.wrapper,
    pt: row.pt,
    aToken: row.aToken,
    pool: row.pool,
    block: row.block,
    blockHash: row.blockHash,
    observedAt: row.observedAt,
    ptDecimals: row.ptDecimals,
    aavePtReserveCashRaw: row.aavePtReserveCashRaw,
  })
  await sql`INSERT INTO twyne_pt_reserve_backfill
    (anchor_at, capture_kind, chain_id, wrapper, pt, atoken, pool,
      block, block_hash, observed_at, pt_decimals, aave_pt_reserve_cash_raw, payload_bytes)
    VALUES (${anchorAt}, 'backfilled', ${row.chainId}, ${row.wrapper}, ${row.pt},
      ${row.aToken}, ${row.pool}, ${row.block}, ${row.blockHash},
      ${row.observedAt}, ${row.ptDecimals}, ${row.aavePtReserveCashRaw}, ${payloadBytes})
    ON CONFLICT (anchor_at, wrapper) DO NOTHING`
  const stored = await sql`SELECT payload_bytes FROM twyne_pt_reserve_backfill
    WHERE anchor_at = ${anchorAt} AND wrapper = ${row.wrapper}`
  if (stored.length !== 1 || stored[0].payload_bytes !== payloadBytes)
    throw new Error('twyne_backfill_replay_mismatch')
}

export async function run(client, sql, options) {
  if ((await client.getChainId()) !== 1) throw new Error('twyne_backfill_wrong_chain')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const finalizedAt = new Date(Number(finalized.timestamp) * 1000).toISOString()
  const finalizedAge = Date.now() - Date.parse(finalizedAt)
  if (!Number.isSafeInteger(finalizedAge) || finalizedAge < -120_000 || finalizedAge > 7_200_000)
    throw new Error('twyne_backfill_finalized_head_stale')
  const anchors = anchorGrid(options, finalizedAt)
  const head = {
    number: finalized.number,
    hash: finalized.hash.toLowerCase(),
    timestamp: finalized.timestamp,
    at: finalizedAt,
  }
  let lower = 1n
  for (const anchorAt of anchors) {
    const block = await resolveAnchorBlock(client, anchorAt, head, lower)
    lower = block.number
    const row = await collectTwynePtReserveObservation(client, { blockNumber: block.number })
    if (row.block !== block.number.toString() || row.blockHash !== block.hash)
      throw new Error('twyne_backfill_block_mismatch')
    if (options.mode === 'commit') await persistBackfill(sql, anchorAt, row)
  }
  return {
    captureKind: 'backfilled',
    mode: options.mode,
    anchors: anchors.length,
    firstAnchorAt: anchors[0],
    lastAnchorAt: anchors.at(-1),
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const { get } = readEnv()
  const rpc =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('rpc_missing')
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (options.mode === 'commit' && !url) throw new Error('database_url_required')
  const result = await run(makeClient(rpc), url ? neon(url) : null, options)
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Twyne PT reserve backfill failed closed.\n')
    process.exitCode = 1
  })
}
