// Historical H1 Aave PT reserve cash band: immutable artifact and prospective
// DB-clock issue/score receipts. Never Twyne wrapper cash or holder exit.
// Run with `node --import tsx` because the pure study imports TypeScript.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { readEnv } from './lib/venue-reads.mjs'
import { TWYNE_PT_RESERVE } from './record-twyne-pt-reserve.mjs'
import { studyTwynePtReserve } from './research/twyne-pt-reserve-study.mjs'

const METRIC = 'aave_pt_reserve_cash_raw'
const KIND = 'historical_aave_pt_reserve_persistence_band_v1'
const MAX_U256 = (1n << 256n) - 1n
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const iso = (value) => new Date(value).toISOString()
const clamp = (value) => (value < 0n ? 0n : value > MAX_U256 ? MAX_U256 : value)

export function buildTwynePtModelArtifact(rows, current) {
  const result = studyTwynePtReserve(rows, current)
  const band = result.projection.baselineBand
  if (result.metric !== METRIC || band?.coveragePassed !== true)
    throw new Error('twyne_pt_h1_historical_band_unqualified')
  const counts = result.projection.counts
  const anchors = rows.map((row) => ({
    anchorAt: iso(row.anchor_at),
    block: String(row.block),
    blockHash: String(row.block_hash),
    observedAt: iso(row.observed_at),
    ptDecimals: Number(row.pt_decimals),
    aavePtReserveCashRaw: String(row.aave_pt_reserve_cash_raw),
    backfillPayloadSha256: sha256(String(row.payload_bytes)),
  }))
  const payloadBytes = JSON.stringify({
    kind: KIND,
    metric: METRIC,
    routeKey: result.routeKey,
    wrapper: result.wrapper,
    pt: result.pt,
    aToken: result.aToken,
    pool: result.pool,
    assetDecimals: result.assetDecimals,
    horizonHours: 1,
    firstArchiveAnchorAt: result.firstAnchorAt,
    lastArchiveAnchorAt: result.lastAnchorAt,
    archiveAnchors: result.archiveAnchors,
    anchors,
    pairs: result.pairs.map(({ sourceAt, targetAt, sourceCashRaw, targetCashRaw }) => ({
      sourceAt,
      targetAt,
      sourceCashRaw,
      targetCashRaw,
    })),
    counts,
    holdout: result.projection.holdout,
    baselineBand: {
      calibrationChangeP05Raw: band.calibrationChangeP05Raw,
      calibrationChangeP95Raw: band.calibrationChangeP95Raw,
      holdoutCovered: band.holdoutCovered,
      holdoutTotal: band.holdoutTotal,
      coveragePassed: band.coveragePassed,
    },
    fitMedianDeltaRaw: '0',
    calibrationResidualP05Raw: band.calibrationChangeP05Raw,
    calibrationResidualP95Raw: band.calibrationChangeP95Raw,
    historicalBacktestOnly: true,
    prospectiveValidated: false,
    holderExecutableExit: false,
  })
  return {
    sha256: sha256(payloadBytes),
    modelVersion: `hband1-${Math.floor(Date.parse(result.firstAnchorAt) / 1000)}-${Math.floor(Date.parse(result.lastAnchorAt) / 1000)}`,
    metric: METRIC,
    routeKey: result.routeKey,
    wrapper: result.wrapper,
    pt: result.pt,
    aToken: result.aToken,
    pool: result.pool,
    assetDecimals: result.assetDecimals,
    horizonHours: 1,
    firstArchiveAnchorAt: result.firstAnchorAt,
    lastArchiveAnchorAt: result.lastAnchorAt,
    archiveAnchors: result.archiveAnchors,
    fitPairs: counts.fit,
    calibrationPairs: counts.calibration,
    holdoutPairs: counts.holdout,
    holdoutCovered: band.holdoutCovered,
    calibrationChangeP05Raw: band.calibrationChangeP05Raw,
    calibrationChangeP95Raw: band.calibrationChangeP95Raw,
    payloadBytes,
  }
}

async function readStudyInputs(sql) {
  const [rows, live] = await Promise.all([
    sql`SELECT anchor_at, capture_kind, chain_id, wrapper, pt, atoken, pool,
      block, block_hash, observed_at, pt_decimals, aave_pt_reserve_cash_raw, payload_bytes
      FROM twyne_pt_reserve_backfill WHERE wrapper = ${TWYNE_PT_RESERVE.wrapper}
      ORDER BY anchor_at DESC LIMIT 721`,
    sql`SELECT wrapper, pt, atoken, pool, block, block_hash, observed_at,
      first_local_receipt_at, pt_decimals, aave_pt_reserve_cash_raw
      FROM twyne_pt_reserve_observations WHERE wrapper = ${TWYNE_PT_RESERVE.wrapper}
      ORDER BY block DESC LIMIT 1`,
  ])
  if (live.length !== 1) throw new Error('twyne_pt_no_prospective_source')
  return { rows: rows.slice(0, 720).reverse(), current: live[0] }
}

export async function registerTwynePtModelArtifact(sql) {
  const { rows, current } = await readStudyInputs(sql)
  const a = buildTwynePtModelArtifact(rows, current)
  const inserted = await sql`INSERT INTO twyne_pt_model_artifacts
    (sha256, model_version, metric, route_key, wrapper, pt, atoken, pool,
     asset_decimals, horizon_hours, first_archive_anchor_at, last_archive_anchor_at,
     archive_anchors, fit_pairs, calibration_pairs, holdout_pairs, holdout_covered,
     calibration_change_p05_raw, calibration_change_p95_raw, payload_bytes)
    VALUES (${a.sha256}, ${a.modelVersion}, ${a.metric}, ${a.routeKey},
      ${a.wrapper}, ${a.pt}, ${a.aToken}, ${a.pool}, ${a.assetDecimals},
      ${a.horizonHours}, ${a.firstArchiveAnchorAt}, ${a.lastArchiveAnchorAt},
      ${a.archiveAnchors}, ${a.fitPairs}, ${a.calibrationPairs}, ${a.holdoutPairs},
      ${a.holdoutCovered}, ${a.calibrationChangeP05Raw},
      ${a.calibrationChangeP95Raw}, ${a.payloadBytes})
    ON CONFLICT (sha256) DO NOTHING RETURNING sha256`
  const replay = await sql`SELECT sha256, model_version, payload_bytes
    FROM twyne_pt_model_artifacts WHERE sha256 = ${a.sha256} LIMIT 1`
  if (
    replay.length !== 1 ||
    replay[0].model_version !== a.modelVersion ||
    replay[0].payload_bytes !== a.payloadBytes
  )
    throw new Error('twyne_pt_artifact_replay_disagreement')
  return {
    status: inserted.length ? 'registered' : 'exact_replay',
    sha256: a.sha256,
    modelVersion: a.modelVersion,
    archiveAnchors: a.archiveAnchors,
    holdoutCovered: a.holdoutCovered,
    holdoutPairs: a.holdoutPairs,
  }
}

// Pure issue arithmetic; the INSERT guard independently recomputes it from
// the source row and the artifact, and stamps the actual issue/target clocks.
export function planTwynePtIssue(source, artifact) {
  const sourceRaw = BigInt(String(source.aave_pt_reserve_cash_raw))
  const p05 = BigInt(String(artifact.calibration_change_p05_raw))
  const p95 = BigInt(String(artifact.calibration_change_p95_raw))
  if (sourceRaw < 0n || sourceRaw > MAX_U256 || p05 > p95)
    throw new Error('twyne_pt_issue_arithmetic_invalid')
  return {
    sourceCashRaw: sourceRaw.toString(),
    forecastPointRaw: sourceRaw.toString(),
    forecastLowRaw: clamp(sourceRaw + p05).toString(),
    forecastHighRaw: clamp(sourceRaw + p95).toString(),
  }
}

export async function issueTwynePtModelSlot(sql) {
  const clock = await sql`SELECT clock_timestamp() AS now,
    date_bin('15 minutes', clock_timestamp(),
      '1970-01-01 00:00:00+00'::timestamptz) AS slot_at`
  const now = clock[0]?.now
  const slotAt = clock[0]?.slot_at
  if (!now || !slotAt) throw new Error('twyne_pt_db_clock_missing')
  const prior =
    await sql`SELECT status FROM twyne_pt_model_issues WHERE slot_at = ${slotAt} LIMIT 1`
  if (prior.length)
    return { status: 'already_attempted', slotAt: iso(slotAt), issueStatus: prior[0].status }
  const artifactRows = await sql`SELECT sha256, asset_decimals,
    calibration_change_p05_raw, calibration_change_p95_raw
    FROM twyne_pt_model_artifacts ORDER BY last_archive_anchor_at DESC, registered_at DESC LIMIT 1`
  const artifact = artifactRows[0]
  const sourceRows = artifact
    ? await sql`SELECT block, block_hash, observed_at,
    first_local_receipt_at, pt_decimals, aave_pt_reserve_cash_raw
    FROM twyne_pt_reserve_observations
    WHERE wrapper = ${TWYNE_PT_RESERVE.wrapper}
      AND first_local_receipt_at <= ${now}
      AND first_local_receipt_at >= ${now}::timestamptz - interval '5 minutes'
      AND observed_at <= ${now}
      AND observed_at >= ${now}::timestamptz - interval '30 minutes'
    ORDER BY first_local_receipt_at DESC, block DESC LIMIT 1`
    : []
  const source = sourceRows[0]
  const status = !artifact ? 'artifact_unavailable' : !source ? 'source_missing' : 'issued'
  const reason = status === 'issued' ? null : status
  const forecast = source && artifact ? planTwynePtIssue(source, artifact) : null
  const inserted = await sql`INSERT INTO twyne_pt_model_issues
    (slot_at, metric, route_key, wrapper, horizon_hours, status, reason,
     artifact_sha256, source_block, source_block_hash, source_observed_at,
     source_first_local_receipt_at, source_asset_decimals, source_cash_raw,
     forecast_point_raw, forecast_low_raw, forecast_high_raw)
    VALUES (${slotAt}, ${METRIC}, ${TWYNE_PT_RESERVE.routeKey},
      ${TWYNE_PT_RESERVE.wrapper}, 1, ${status}, ${reason},
      ${status === 'issued' ? artifact.sha256 : null},
      ${status === 'issued' ? String(source.block) : null},
      ${status === 'issued' ? source.block_hash : null},
      ${status === 'issued' ? source.observed_at : null},
      ${null},
      ${status === 'issued' ? Number(source.pt_decimals) : null},
      ${forecast?.sourceCashRaw ?? null}, ${forecast?.forecastPointRaw ?? null},
      ${forecast?.forecastLowRaw ?? null}, ${forecast?.forecastHighRaw ?? null})
    ON CONFLICT (slot_at) DO NOTHING RETURNING status, slot_at, issued_at,
      target_at, target_low_at, target_high_at, score_after_at`
  if (!inserted.length) return { status: 'already_attempted', slotAt: iso(slotAt) }
  const row = inserted[0]
  return {
    status: row.status,
    slotAt: iso(row.slot_at),
    issuedAt: iso(row.issued_at),
    targetAt: iso(row.target_at),
    targetLowAt: iso(row.target_low_at),
    targetHighAt: iso(row.target_high_at),
    scoreAfterAt: iso(row.score_after_at),
  }
}

export async function scoreDueTwynePtModelIssues(sql) {
  const rows = await sql`WITH due AS (
      SELECT i.* FROM twyne_pt_model_issues i
      WHERE i.status = 'issued' AND i.score_after_at <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM twyne_pt_model_scores s WHERE s.slot_at = i.slot_at)
      ORDER BY i.score_after_at, i.slot_at LIMIT 100
    ), selected AS (
      SELECT d.*, o.block AS candidate_block, o.block_hash AS candidate_block_hash,
        o.observed_at AS candidate_observed_at,
        o.first_local_receipt_at AS candidate_first_local_receipt_at,
        o.aave_pt_reserve_cash_raw AS outcome_cash_raw
      FROM due d LEFT JOIN LATERAL (
        SELECT * FROM twyne_pt_reserve_observations o
        WHERE o.wrapper = d.wrapper AND o.block > d.source_block
          AND o.observed_at BETWEEN d.target_low_at AND d.target_high_at
          AND o.first_local_receipt_at > d.issued_at
          AND o.first_local_receipt_at <= d.score_after_at
          AND o.pt_decimals = d.source_asset_decimals
        ORDER BY abs(extract(epoch FROM (o.observed_at - d.target_at))),
          o.observed_at, o.block LIMIT 1
      ) o ON true
    ), inserted AS (
      INSERT INTO twyne_pt_model_scores
        (slot_at, wrapper, status, candidate_block, candidate_block_hash,
         candidate_observed_at, candidate_first_local_receipt_at, outcome_cash_raw,
         point_absolute_error_raw, persistence_absolute_error_raw, band_covered)
      SELECT slot_at, wrapper,
        CASE WHEN candidate_block IS NULL THEN 'censored_missing' ELSE 'observed' END,
        candidate_block, candidate_block_hash, candidate_observed_at,
        candidate_first_local_receipt_at, outcome_cash_raw,
        CASE WHEN candidate_block IS NOT NULL THEN abs(outcome_cash_raw - forecast_point_raw) END,
        CASE WHEN candidate_block IS NOT NULL THEN abs(outcome_cash_raw - source_cash_raw) END,
        CASE WHEN candidate_block IS NOT NULL THEN outcome_cash_raw BETWEEN forecast_low_raw AND forecast_high_raw END
      FROM selected WHERE true
      ON CONFLICT (slot_at) DO NOTHING RETURNING status
    ) SELECT count(*)::integer AS sealed,
      count(*) FILTER (WHERE status = 'observed')::integer AS observed,
      count(*) FILTER (WHERE status = 'censored_missing')::integer AS censored_missing
    FROM inserted`
  const row = rows[0]
  return {
    sealed: Number(row?.sealed ?? 0),
    observed: Number(row?.observed ?? 0),
    censoredMissing: Number(row?.censored_missing ?? 0),
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !['--register', '--issue', '--score'].includes(argv[0]))
    throw new Error(
      'usage: node --import tsx scripts/record-twyne-pt-model.mjs --register|--issue|--score',
    )
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('database_url_required')
  const sql = neon(url)
  const result =
    argv[0] === '--register'
      ? await registerTwynePtModelArtifact(sql)
      : argv[0] === '--issue'
        ? await issueTwynePtModelSlot(sql)
        : await scoreDueTwynePtModelIssues(sql)
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Twyne PT reserve model operation failed closed.\n')
    process.exitCode = 1
  })
}
