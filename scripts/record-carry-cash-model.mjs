// Immutable prospective attempts for the exact-subject historical cash model.
// Backfill trains the frozen artifact; only later, DB-clock baseline receipts
// may source an issue. Outcomes are scored through the independent baseline.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import projectionModule from '../lib/carry/historicalCashProjection.ts'
import { assertModelGuards } from './apply-carry-cash-model-ddl.mjs'
import { readEnv } from './lib/venue-reads.mjs'
import { buildSubjectManifest } from './record-carry-cash-issues.mjs'
import { readRows, study } from './research/carry-cash-backfill-study.mjs'

const { projectHistoricalCash } = projectionModule
const hash = (value) => createHash('sha256').update(value).digest('hex')
const iso = (value) => new Date(value).toISOString()
const subjectKey = (routeKey, destination) => `${routeKey}\0${destination}`

export function planModelAttempts(corpus, baselineRows, manifestSha256) {
  if (
    corpus.captureKind !== 'backfilled' ||
    corpus.subjectManifestSha256 !== manifestSha256 ||
    corpus.subjectCount !== 67 ||
    corpus.whollyMissingArchiveAnchors !== 0 ||
    corpus.missingSubjectAnchorRows !== 0 ||
    !Array.isArray(baselineRows) ||
    baselineRows.length !== 134
  )
    throw new Error('cash_model_incomplete_grid')
  const subjects = new Map(
    corpus.subjects.map((subject) => [subjectKey(subject.routeKey, subject.destination), subject]),
  )
  const artifacts = new Map()
  const attempts = []
  const seen = new Set()
  for (const baseline of baselineRows) {
    const key = subjectKey(baseline.route_key, baseline.destination)
    const exact = `${key}\0${baseline.horizon_hours}`
    if (seen.has(exact)) throw new Error('cash_model_duplicate_baseline')
    seen.add(exact)
    const subject = subjects.get(key)
    const horizon = subject?.horizons.find((item) => item.horizonHours === baseline.horizon_hours)
    if (
      !subject ||
      !horizon ||
      subject.asset !== baseline.asset ||
      (baseline.status === 'issued' && subject.assetDecimals !== Number(baseline.asset_decimals)) ||
      (baseline.status === 'issued' &&
        (!baseline.source_observed_at ||
          !Number.isFinite(Date.parse(iso(baseline.source_observed_at))))) ||
      !Array.isArray(horizon.pairs)
    )
      throw new Error('cash_model_subject_mismatch')
    const base = {
      slotAt: iso(baseline.slot_at),
      routeKey: baseline.route_key,
      destination: baseline.destination,
      horizonHours: baseline.horizon_hours,
      status: '',
      modelArtifactSha256: null,
      sourceCashRaw: null,
      forecastPointRaw: null,
      forecastLowRaw: null,
      forecastHighRaw: null,
      reason: null,
    }
    if (baseline.status !== 'issued') {
      base.status = baseline.status === 'unassessed' ? 'unassessed' : 'baseline_unissued'
      base.reason = baseline.status
      attempts.push(base)
      continue
    }
    const sourceObservedAt = iso(baseline.source_observed_at)
    if (
      Date.parse(sourceObservedAt) > Date.parse(iso(baseline.issued_at)) ||
      Date.parse(subject.lastAnchorAt) >= Date.parse(sourceObservedAt)
    ) {
      base.status = 'model_unavailable'
      base.reason = 'future_outcome'
      attempts.push(base)
      continue
    }
    const projection = projectHistoricalCash({
      subjectKey: key,
      horizonHours: baseline.horizon_hours,
      currentAt: sourceObservedAt,
      currentCashRaw: String(baseline.source_cash_raw),
      pairs: horizon.pairs,
    })
    const learnedDelta = projection.status === 'historical_projection'
    const qualifiedBaselineBand = projection.baselineBand?.selectionCoveragePassed === true
    if (!learnedDelta && !qualifiedBaselineBand) {
      base.status =
        projection.reason === 'insufficient_history'
          ? 'insufficient_history'
          : projection.reason === 'no_skill_over_persistence'
            ? 'historical_backtest_failed'
            : 'model_unavailable'
      base.reason = projection.reason
      attempts.push(base)
      continue
    }
    const projectionValues = learnedDelta ? projection.projection : projection.baselineBand
    const kind = learnedDelta
      ? 'historical_cash_delta_model_v1'
      : 'historical_cash_persistence_band_v1'
    const payloadBytes = JSON.stringify({
      kind,
      routeKey: subject.routeKey,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: subject.assetDecimals,
      horizonHours: horizon.horizonHours,
      sourceManifestSha256: manifestSha256,
      firstArchiveAnchorAt: subject.firstAnchorAt,
      lastArchiveAnchorAt: subject.lastAnchorAt,
      independentSelection: horizon.independentSelection,
      pairs: horizon.pairs.map(({ sourceAt, targetAt, sourceCashRaw, targetCashRaw }) => ({
        sourceAt,
        targetAt,
        sourceCashRaw,
        targetCashRaw,
      })),
      counts: projection.counts,
      selection: projection.selection,
      holdout: projection.holdout,
      baselineBand: projection.baselineBand
        ? {
            calibrationChangeP05Raw: projection.baselineBand.calibrationChangeP05Raw,
            calibrationChangeP95Raw: projection.baselineBand.calibrationChangeP95Raw,
            selectionCovered: projection.baselineBand.selectionCovered,
            selectionTotal: projection.baselineBand.selectionTotal,
            selectionCoveragePassed: projection.baselineBand.selectionCoveragePassed,
            holdoutCovered: projection.baselineBand.holdoutCovered,
            holdoutTotal: projection.baselineBand.holdoutTotal,
            coveragePassed: projection.baselineBand.coveragePassed,
          }
        : null,
      fitMedianDeltaRaw: learnedDelta ? projection.projection.fitMedianDeltaRaw : '0',
      calibrationResidualP05Raw: learnedDelta
        ? projection.projection.calibrationResidualP05Raw
        : projection.baselineBand.calibrationChangeP05Raw,
      calibrationResidualP95Raw: learnedDelta
        ? projection.projection.calibrationResidualP95Raw
        : projection.baselineBand.calibrationChangeP95Raw,
      historicalBacktestOnly: true,
      prospectiveValidated: false,
      holderExecutableExit: false,
    })
    const artifactSha256 = hash(payloadBytes)
    artifacts.set(artifactSha256, {
      sha256: artifactSha256,
      modelVersion: `${learnedDelta ? 'hdelta4' : 'hband4'}-${Math.floor(Date.parse(subject.firstAnchorAt) / 1000)}-${Math.floor(Date.parse(subject.lastAnchorAt) / 1000)}`,
      routeKey: subject.routeKey,
      destination: subject.destination,
      asset: subject.asset,
      horizonHours: horizon.horizonHours,
      sourceManifestSha256: manifestSha256,
      firstArchiveAnchorAt: subject.firstAnchorAt,
      lastArchiveAnchorAt: subject.lastAnchorAt,
      fitPairs: projection.counts.fit,
      calibrationPairs: projection.counts.calibration,
      selectionPairs: projection.counts.selection,
      holdoutPairs: projection.counts.holdout,
      payloadBytes,
    })
    base.status = 'issued'
    base.modelArtifactSha256 = artifactSha256
    base.sourceCashRaw = String(baseline.source_cash_raw)
    base.forecastPointRaw = projectionValues.pointRaw
    base.forecastLowRaw = projectionValues.bandLowRaw
    base.forecastHighRaw = projectionValues.bandHighRaw
    attempts.push(base)
  }
  if (seen.size !== 134) throw new Error('cash_model_missing_baseline')
  return { artifacts: [...artifacts.values()], attempts }
}

async function registerArtifacts(sql, artifacts) {
  for (const artifact of artifacts) {
    await sql`INSERT INTO carry_cash_model_artifacts
      (sha256, model_version, route_key, destination, horizon_hours, asset,
       source_manifest_sha256, first_archive_anchor_at, last_archive_anchor_at,
       fit_pairs, calibration_pairs, selection_pairs, holdout_pairs, payload_bytes)
      VALUES (${artifact.sha256}, ${artifact.modelVersion}, ${artifact.routeKey},
        ${artifact.destination}, ${artifact.horizonHours}, ${artifact.asset},
        ${artifact.sourceManifestSha256}, ${artifact.firstArchiveAnchorAt},
        ${artifact.lastArchiveAnchorAt}, ${artifact.fitPairs},
        ${artifact.calibrationPairs}, ${artifact.selectionPairs}, ${artifact.holdoutPairs},
        ${artifact.payloadBytes})
      ON CONFLICT (sha256) DO NOTHING`
  }
}

async function buildLivePlan(sql, slot) {
  const manifest = await buildSubjectManifest()
  if (manifest.sha256 !== slot.subject_manifest_sha256)
    throw new Error('cash_model_manifest_changed')
  const corpus = study(await readRows(sql), manifest, { includePairs: true })
  const baselineRows = await sql`SELECT slot_at, route_key, destination, horizon_hours,
      status, asset, asset_decimals, issued_at, source_observed_at, source_cash_raw
    FROM carry_cash_issue_attempts WHERE slot_at = ${slot.slot_at}
    ORDER BY route_key, destination, horizon_hours`
  return planModelAttempts(corpus, baselineRows, manifest.sha256)
}

export async function registerLatestModelArtifacts(sql) {
  await assertModelGuards(sql)
  const slots = await sql`SELECT slot_at, subject_manifest_sha256
    FROM carry_cash_issue_slots ORDER BY slot_at DESC LIMIT 1`
  const slot = slots[0]
  if (!slot) throw new Error('cash_model_baseline_slot_missing')
  const plan = await buildLivePlan(sql, slot)
  await registerArtifacts(sql, plan.artifacts)
  return { status: 'registered', archiveModels: plan.artifacts.length, slotAt: slot.slot_at }
}

export async function issueCurrentModelSlot(sql) {
  await assertModelGuards(sql)
  const slots = await sql`SELECT s.slot_at, s.started_at, s.subject_manifest_sha256
    FROM carry_cash_issue_slots s CROSS JOIN carry_cash_model_guard_epoch e
      CROSS JOIN carry_cash_model_v4_epoch v4
    WHERE e.id = true AND s.started_at >= e.activated_at
      AND v4.id = true AND s.started_at >= v4.activated_at
      AND s.started_at > clock_timestamp() - interval '5 minutes'
    ORDER BY s.started_at DESC LIMIT 1`
  const slot = slots[0]
  if (!slot) throw new Error('cash_model_current_baseline_slot_missing')
  const existing = await sql`SELECT count(*)::integer AS n,
    count(*) FILTER (WHERE status = 'issued' AND horizon_hours = 1)::integer AS issued_h1
    FROM carry_cash_model_attempts
    WHERE slot_at = ${slot.slot_at}`
  if (Number(existing[0]?.n) === 134) {
    if (Number(existing[0]?.issued_h1) !== 66)
      throw new Error('cash_model_h1_subject_coverage_incomplete')
    return { status: 'already_issued', slotAt: slot.slot_at, inserted: 0 }
  }
  if (Number(existing[0]?.n) !== 0) throw new Error('cash_model_partial_slot')

  const plan = await buildLivePlan(sql, slot)
  await registerArtifacts(sql, plan.artifacts)
  const rows = await sql`
    WITH planned AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(plan.attempts)}::jsonb) AS p(
        "slotAt" timestamptz, "routeKey" text, destination text,
        "horizonHours" smallint, status text, "modelArtifactSha256" text,
        "sourceCashRaw" numeric, "forecastPointRaw" numeric,
        "forecastLowRaw" numeric, "forecastHighRaw" numeric, reason text)
    ), inserted AS (
      INSERT INTO carry_cash_model_attempts
        (slot_at, route_key, destination, horizon_hours, status,
         model_artifact_sha256, source_cash_raw, forecast_point_raw,
         forecast_low_raw, forecast_high_raw, reason)
      SELECT p."slotAt", p."routeKey", p.destination, p."horizonHours",
        p.status, p."modelArtifactSha256", p."sourceCashRaw",
        p."forecastPointRaw", p."forecastLowRaw", p."forecastHighRaw", p.reason
      FROM planned p JOIN carry_cash_issue_attempts b ON b.slot_at = p."slotAt"
        AND b.route_key = p."routeKey" AND b.destination = p.destination
        AND b.horizon_hours = p."horizonHours"
      WHERE NOT EXISTS (SELECT 1 FROM carry_cash_model_attempts existing
        WHERE existing.slot_at = p."slotAt" AND existing.route_key = p."routeKey"
          AND existing.destination = p.destination AND existing.horizon_hours = p."horizonHours")
      RETURNING status, horizon_hours
    ) SELECT count(*)::integer AS inserted,
      count(*) FILTER (WHERE status = 'issued')::integer AS issued,
      count(*) FILTER (WHERE status = 'issued' AND horizon_hours = 1)::integer AS issued_h1,
      count(*) FILTER (WHERE status = 'late')::integer AS late
    FROM inserted`
  const result = rows[0]
  if (Number(result?.inserted) !== 134) throw new Error('cash_model_partial_slot')
  if (Number(result?.issued_h1) !== 66) throw new Error('cash_model_h1_subject_coverage_incomplete')
  return {
    status: 'recorded',
    slotAt: slot.slot_at,
    inserted: Number(result.inserted),
    issued: Number(result.issued),
    late: Number(result.late),
    artifacts: plan.artifacts.length,
  }
}

export async function scoreDueModelIssues(sql) {
  await assertModelGuards(sql)
  const rows = await sql`
    WITH due AS (
      SELECT m.*, b.status AS outcome_status, b.outcome_cash_raw,
        i.source_cash_raw AS persistence_raw
      FROM carry_cash_model_attempts m
      JOIN carry_cash_issue_scores b USING (slot_at, route_key, destination, horizon_hours)
      JOIN carry_cash_issue_attempts i USING (slot_at, route_key, destination, horizon_hours)
      WHERE m.status = 'issued' AND i.score_after_at <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM carry_cash_model_scores z
          WHERE z.slot_at = m.slot_at AND z.route_key = m.route_key
            AND z.destination = m.destination AND z.horizon_hours = m.horizon_hours)
      ORDER BY i.score_after_at, m.slot_at, m.route_key, m.destination
      LIMIT 5000
    ), inserted AS (
      INSERT INTO carry_cash_model_scores
        (slot_at, route_key, destination, horizon_hours, status,
         outcome_cash_raw, point_absolute_error_raw,
         persistence_absolute_error_raw, band_covered)
      SELECT slot_at, route_key, destination, horizon_hours, outcome_status,
        outcome_cash_raw,
        CASE WHEN outcome_status = 'observed' THEN abs(outcome_cash_raw - forecast_point_raw) END,
        CASE WHEN outcome_status = 'observed' THEN abs(outcome_cash_raw - persistence_raw) END,
        CASE WHEN outcome_status = 'observed'
          THEN outcome_cash_raw BETWEEN forecast_low_raw AND forecast_high_raw END
      FROM due RETURNING status
    ) SELECT count(*)::integer AS sealed,
      count(*) FILTER (WHERE status = 'observed')::integer AS observed,
      count(*) FILTER (WHERE status = 'censored_missing')::integer AS censored_missing
    FROM inserted`
  const result = rows[0]
  return {
    sealed: Number(result?.sealed ?? 0),
    observed: Number(result?.observed ?? 0),
    censoredMissing: Number(result?.censored_missing ?? 0),
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !['--register', '--issue', '--score'].includes(argv[0]))
    throw new Error('usage: record-carry-cash-model.mjs --register|--issue|--score')
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
      ? await registerLatestModelArtifacts(sql)
      : argv[0] === '--issue'
        ? await issueCurrentModelSlot(sql)
        : await scoreDueModelIssues(sql)
  process.stdout.write(JSON.stringify({ action: argv[0].slice(2), ...result }) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Carry cash model issue/score failed closed.\n')
    process.exitCode = 1
  })
}
