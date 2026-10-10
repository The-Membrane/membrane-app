// Read-only historical model evaluation for Aave PT reserve cash.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { readEnv } from '../lib/venue-reads.mjs'
import { TWYNE_PT_RESERVE } from '../record-twyne-pt-reserve.mjs'
import { studyTwynePtReserve } from './twyne-pt-reserve-study.mjs'

export async function evaluate(sql) {
  const [rows, live] = await Promise.all([
    sql`SELECT anchor_at, capture_kind, chain_id, wrapper, pt, atoken, pool,
      block, block_hash, observed_at, pt_decimals, aave_pt_reserve_cash_raw, payload_bytes
      FROM twyne_pt_reserve_backfill
      WHERE wrapper = ${TWYNE_PT_RESERVE.wrapper}
      ORDER BY anchor_at LIMIT 720`,
    sql`SELECT wrapper, pt, atoken, pool, block, block_hash, observed_at,
      first_local_receipt_at, pt_decimals, aave_pt_reserve_cash_raw
      FROM twyne_pt_reserve_observations
      WHERE wrapper = ${TWYNE_PT_RESERVE.wrapper}
      ORDER BY block DESC LIMIT 1`,
  ])
  if (live.length !== 1) throw new Error('twyne_study_no_live_source')
  const result = studyTwynePtReserve(rows, live[0])
  return {
    metric: result.metric,
    routeKey: result.routeKey,
    archiveAnchors: result.archiveAnchors,
    independentPairs: result.pairs.length,
    firstAnchorAt: result.firstAnchorAt,
    lastAnchorAt: result.lastAnchorAt,
    modelStatus: result.projection.status,
    reason: result.projection.reason ?? null,
    counts: result.projection.counts,
    holdout: result.projection.holdout,
    baselineBand: result.projection.baselineBand,
    prospectiveValidated: false,
    holderExecutableExit: false,
  }
}

async function main() {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('database_url_required')
  process.stdout.write(JSON.stringify(await evaluate(neon(url))) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Twyne PT reserve evaluation failed closed.\n')
    process.exitCode = 1
  })
}
