// Rebuild the frozen Twyne Aave PT reserve model from historical receipts.
// This is independent of the prospective issue and score writer.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { readEnv } from './lib/venue-reads.mjs'
import { buildTwynePtModelArtifact } from './record-twyne-pt-model.mjs'
import { TWYNE_PT_RESERVE } from './record-twyne-pt-reserve.mjs'

const iso = (value) => new Date(value).toISOString()

export async function audit(sql) {
  const artifacts = await sql`SELECT * FROM twyne_pt_model_artifacts ORDER BY registered_at`
  const live = await sql`SELECT wrapper, pt, atoken, pool, block, block_hash,
    observed_at, first_local_receipt_at, pt_decimals, aave_pt_reserve_cash_raw
    FROM twyne_pt_reserve_observations WHERE wrapper = ${TWYNE_PT_RESERVE.wrapper}
    ORDER BY block DESC LIMIT 1`
  if (live.length !== 1) throw new Error('twyne_audit_live_source_missing')
  for (const artifact of artifacts) {
    const rows = await sql`SELECT anchor_at, capture_kind, chain_id, wrapper, pt,
      atoken, pool, block, block_hash, observed_at, pt_decimals,
      aave_pt_reserve_cash_raw, payload_bytes
      FROM twyne_pt_reserve_backfill
      WHERE wrapper = ${TWYNE_PT_RESERVE.wrapper}
        AND anchor_at BETWEEN ${artifact.first_archive_anchor_at} AND ${artifact.last_archive_anchor_at}
      ORDER BY anchor_at LIMIT 720`
    const rebuilt = buildTwynePtModelArtifact(rows, live[0])
    if (
      rebuilt.sha256 !== artifact.sha256 ||
      rebuilt.modelVersion !== artifact.model_version ||
      rebuilt.payloadBytes !== artifact.payload_bytes ||
      rebuilt.archiveAnchors !== Number(artifact.archive_anchors) ||
      rebuilt.assetDecimals !== Number(artifact.asset_decimals) ||
      rebuilt.fitPairs !== Number(artifact.fit_pairs) ||
      rebuilt.calibrationPairs !== Number(artifact.calibration_pairs) ||
      rebuilt.holdoutPairs !== Number(artifact.holdout_pairs) ||
      rebuilt.holdoutCovered !== Number(artifact.holdout_covered) ||
      rebuilt.calibrationChangeP05Raw !== String(artifact.calibration_change_p05_raw) ||
      rebuilt.calibrationChangeP95Raw !== String(artifact.calibration_change_p95_raw) ||
      rebuilt.firstArchiveAnchorAt !== iso(artifact.first_archive_anchor_at) ||
      rebuilt.lastArchiveAnchorAt !== iso(artifact.last_archive_anchor_at)
    )
      throw new Error('twyne_audit_artifact_replay_mismatch')
  }
  const issues = await sql`SELECT count(*)::integer AS total,
    count(*) FILTER (WHERE i.status = 'issued')::integer AS issued,
    count(*) FILTER (WHERE i.status = 'issued' AND (
      i.issued_at < a.registered_at OR
      i.issued_at < i.source_first_local_receipt_at OR
      i.issued_at > i.source_first_local_receipt_at + interval '5 minutes' OR
      i.target_at <> i.source_observed_at + interval '1 hour' OR
      i.source_observed_at < i.issued_at - interval '30 minutes' OR
      i.target_low_at <= i.issued_at OR
      i.source_asset_decimals <> a.asset_decimals))::integer AS invalid
    FROM twyne_pt_model_issues i
    LEFT JOIN twyne_pt_model_artifacts a ON a.sha256 = i.artifact_sha256`
  if (Number(issues[0]?.invalid) !== 0) throw new Error('twyne_audit_issue_invalid')
  const scores = await sql`SELECT
    count(*) FILTER (WHERE i.status = 'issued' AND i.score_after_at <= clock_timestamp()
      AND s.slot_at IS NULL)::integer AS overdue,
    count(*) FILTER (WHERE s.status = 'observed')::integer AS observed,
    count(*) FILTER (WHERE s.status = 'censored_missing')::integer AS censored,
    count(*) FILTER (WHERE s.slot_at IS NOT NULL AND (
      i.status <> 'issued' OR s.scored_at < i.score_after_at OR
      (s.status = 'observed' AND (
        c.block IS NULL OR s.candidate_block IS DISTINCT FROM c.block OR
        s.candidate_block_hash IS DISTINCT FROM c.block_hash OR
        s.candidate_observed_at IS DISTINCT FROM c.observed_at OR
        s.candidate_first_local_receipt_at IS DISTINCT FROM c.first_local_receipt_at OR
        s.outcome_cash_raw IS DISTINCT FROM c.aave_pt_reserve_cash_raw OR
        s.point_absolute_error_raw IS DISTINCT FROM abs(c.aave_pt_reserve_cash_raw - i.forecast_point_raw) OR
        s.persistence_absolute_error_raw IS DISTINCT FROM abs(c.aave_pt_reserve_cash_raw - i.source_cash_raw) OR
        s.band_covered IS DISTINCT FROM (c.aave_pt_reserve_cash_raw BETWEEN i.forecast_low_raw AND i.forecast_high_raw))) OR
      (s.status = 'censored_missing' AND c.block IS NOT NULL)))::integer AS invalid
    FROM twyne_pt_model_issues i
    LEFT JOIN twyne_pt_model_scores s ON s.slot_at = i.slot_at
    LEFT JOIN LATERAL (
      SELECT o.* FROM twyne_pt_reserve_observations o
      WHERE i.status = 'issued' AND o.wrapper = i.wrapper AND o.block > i.source_block
        AND o.observed_at BETWEEN i.target_low_at AND i.target_high_at
        AND o.first_local_receipt_at > i.issued_at
        AND o.first_local_receipt_at <= i.score_after_at
        AND o.pt_decimals = i.source_asset_decimals
      ORDER BY abs(extract(epoch FROM (o.observed_at - i.target_at))), o.observed_at, o.block
      LIMIT 1
    ) c ON true`
  if (Number(scores[0]?.overdue) !== 0 || Number(scores[0]?.invalid) !== 0)
    throw new Error('twyne_audit_scores_invalid')
  return {
    valid: true,
    artifacts: artifacts.length,
    issues: Number(issues[0]?.total ?? 0),
    issued: Number(issues[0]?.issued ?? 0),
    invalidIssues: 0,
    observedScores: Number(scores[0]?.observed ?? 0),
    censoredScores: Number(scores[0]?.censored ?? 0),
    overdueScores: 0,
    invalidScores: 0,
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
  process.stdout.write(JSON.stringify(await audit(neon(url))) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Twyne PT reserve model audit failed closed.\n')
    process.exitCode = 1
  })
}
