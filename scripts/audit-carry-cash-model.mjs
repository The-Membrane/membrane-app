// Reconstruct every current artifact from the immutable historical archive.
// A passing audit is retrospective provenance, never live forecast validation.
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
const abort = (code) => {
  throw new Error(code)
}
const MAX_RAW = (1n << 256n) - 1n
const RAW = /^(0|[1-9][0-9]*)$/
const clampRaw = (value) => (value < 0n ? 0n : value > MAX_RAW ? MAX_RAW : value)
const absolute = (value) => (value < 0n ? -value : value)
const ordered = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const lowerMedian = (values) => ordered(values)[Math.floor((values.length - 1) / 2)]
const percentile = (values, percent) =>
  ordered(values)[Math.ceil((percent * values.length) / 100) - 1]

/** Frozen three-stage replay for immutable hdelta3/hband3 artifacts. */
export function replayLegacyV3(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 60) abort('model_legacy_pairs_invalid')
  const checked = pairs.map((pair) => {
    if (!RAW.test(pair.sourceCashRaw) || !RAW.test(pair.targetCashRaw))
      abort('model_legacy_pairs_invalid')
    const sourceCash = BigInt(pair.sourceCashRaw)
    const targetCash = BigInt(pair.targetCashRaw)
    if (sourceCash > MAX_RAW || targetCash > MAX_RAW) abort('model_legacy_pairs_invalid')
    return { sourceCash, targetCash, delta: targetCash - sourceCash }
  })
  const fitCount = Math.floor(checked.length / 3)
  const calibrationCount = Math.floor(checked.length / 3)
  const holdoutCount = checked.length - fitCount - calibrationCount
  if (fitCount < 20 || calibrationCount < 20 || holdoutCount < 20)
    abort('model_legacy_pairs_invalid')
  const counts = {
    total: checked.length,
    fit: fitCount,
    calibration: calibrationCount,
    holdout: holdoutCount,
  }
  const fitMedianDelta = lowerMedian(checked.slice(0, fitCount).map((pair) => pair.delta))
  const calibration = checked.slice(fitCount, fitCount + calibrationCount)
  const residualP05 = percentile(
    calibration.map((pair) => pair.delta - fitMedianDelta),
    5,
  )
  const residualP95 = percentile(
    calibration.map((pair) => pair.delta - fitMedianDelta),
    95,
  )
  const changeP05 = percentile(
    calibration.map((pair) => pair.delta),
    5,
  )
  const changeP95 = percentile(
    calibration.map((pair) => pair.delta),
    95,
  )
  let covered = 0
  let baselineCovered = 0
  let modelErrorTotal = 0n
  let persistenceErrorTotal = 0n
  for (const pair of checked.slice(fitCount + calibrationCount)) {
    const point = clampRaw(pair.sourceCash + fitMedianDelta)
    const low = clampRaw(pair.sourceCash + fitMedianDelta + residualP05)
    const high = clampRaw(pair.sourceCash + fitMedianDelta + residualP95)
    if (pair.targetCash >= low && pair.targetCash <= high) covered++
    if (
      pair.targetCash >= clampRaw(pair.sourceCash + changeP05) &&
      pair.targetCash <= clampRaw(pair.sourceCash + changeP95)
    )
      baselineCovered++
    modelErrorTotal += absolute(pair.targetCash - point)
    persistenceErrorTotal += absolute(pair.targetCash - pair.sourceCash)
  }
  const holdout = {
    covered,
    total: holdoutCount,
    coveragePassed: covered * 100 >= holdoutCount * 80,
    pointBeatsPersistence: modelErrorTotal < persistenceErrorTotal,
    modelMae: { numeratorRaw: modelErrorTotal.toString(), denominator: holdoutCount },
    persistenceMae: {
      numeratorRaw: persistenceErrorTotal.toString(),
      denominator: holdoutCount,
    },
  }
  const baselineBand = {
    calibrationChangeP05Raw: changeP05.toString(),
    calibrationChangeP95Raw: changeP95.toString(),
    holdoutCovered: baselineCovered,
    holdoutTotal: holdoutCount,
    coveragePassed: baselineCovered * 100 >= holdoutCount * 80,
  }
  const learned = holdout.coveragePassed && holdout.pointBeatsPersistence
  return {
    status: learned ? 'historical_projection' : 'unavailable',
    reason: learned ? null : 'no_skill_over_persistence',
    counts,
    holdout,
    baselineBand,
    projection: {
      fitMedianDeltaRaw: fitMedianDelta.toString(),
      calibrationResidualP05Raw: residualP05.toString(),
      calibrationResidualP95Raw: residualP95.toString(),
    },
  }
}

export function auditArtifacts(artifacts, archiveRows, manifest) {
  const studies = new Map()
  const kinds = { learnedDelta: 0, persistenceBand: 0 }
  for (const artifact of artifacts) {
    const version = String(artifact.model_version)
    if (!/^h(delta|band)(3|4)-[0-9]+-[0-9]+$/.test(version)) abort('model_artifact_version_invalid')
    const v4 = /^h(delta|band)4-/.test(version)
    const payloadBytes = String(artifact.payload_bytes)
    if (hash(payloadBytes) !== artifact.sha256) abort('model_artifact_digest_mismatch')
    const payload = JSON.parse(payloadBytes)
    const lastAnchorAt = iso(artifact.last_archive_anchor_at)
    const firstAnchorAt = iso(artifact.first_archive_anchor_at)
    const spanKey = `${firstAnchorAt}|${lastAnchorAt}`
    if (!studies.has(spanKey)) {
      const first = Date.parse(firstAnchorAt)
      const last = Date.parse(lastAnchorAt)
      const rows = archiveRows.filter((row) => {
        const at = Date.parse(row.anchor_at)
        return at >= first && at <= last
      })
      const corpus = study(rows, manifest, { includePairs: true })
      if (corpus.whollyMissingArchiveAnchors || corpus.missingSubjectAnchorRows)
        abort('model_archive_grid_incomplete')
      studies.set(spanKey, corpus)
    }
    const corpus = studies.get(spanKey)
    const subject = corpus.subjects.find(
      (item) => item.routeKey === artifact.route_key && item.destination === artifact.destination,
    )
    const horizon = subject?.horizons.find((item) => item.horizonHours === artifact.horizon_hours)
    if (
      !subject ||
      !horizon ||
      subject.asset !== artifact.asset ||
      subject.assetDecimals !== payload.assetDecimals ||
      payload.routeKey !== subject.routeKey ||
      payload.destination !== subject.destination ||
      payload.asset !== subject.asset ||
      payload.horizonHours !== horizon.horizonHours ||
      payload.sourceManifestSha256 !== manifest.sha256 ||
      artifact.source_manifest_sha256 !== manifest.sha256 ||
      payload.firstArchiveAnchorAt !== iso(artifact.first_archive_anchor_at) ||
      payload.lastArchiveAnchorAt !== lastAnchorAt ||
      payload.firstArchiveAnchorAt !== subject.firstAnchorAt ||
      payload.lastArchiveAnchorAt !== subject.lastAnchorAt ||
      payload.independentSelection !== horizon.independentSelection ||
      iso(artifact.registered_at) <= lastAnchorAt
    )
      abort('model_artifact_subject_mismatch')
    const frozenPairs = horizon.pairs.map(
      ({ sourceAt, targetAt, sourceCashRaw, targetCashRaw }) => ({
        sourceAt,
        targetAt,
        sourceCashRaw,
        targetCashRaw,
      }),
    )
    if (JSON.stringify(payload.pairs) !== JSON.stringify(frozenPairs))
      abort('model_artifact_pairs_mismatch')
    const replay = v4
      ? projectHistoricalCash({
          subjectKey: `${subject.routeKey}\0${subject.destination}`,
          horizonHours: horizon.horizonHours,
          currentAt: iso(artifact.registered_at),
          currentCashRaw: horizon.pairs.at(-1)?.targetCashRaw ?? '0',
          pairs: horizon.pairs,
        })
      : replayLegacyV3(horizon.pairs)
    const replayBand = replay.baselineBand
    const payloadBand = payload.baselineBand
    if (
      replay.counts.fit !== Number(artifact.fit_pairs) ||
      replay.counts.calibration !== Number(artifact.calibration_pairs) ||
      (v4
        ? replay.counts.selection !== Number(artifact.selection_pairs)
        : artifact.selection_pairs !== null && artifact.selection_pairs !== undefined) ||
      replay.counts.holdout !== Number(artifact.holdout_pairs) ||
      JSON.stringify(payload.counts) !== JSON.stringify(replay.counts) ||
      (v4
        ? JSON.stringify(payload.selection) !== JSON.stringify(replay.selection)
        : Object.hasOwn(payload, 'selection')) ||
      JSON.stringify(payload.holdout) !== JSON.stringify(replay.holdout) ||
      payloadBand?.calibrationChangeP05Raw !== replayBand?.calibrationChangeP05Raw ||
      payloadBand?.calibrationChangeP95Raw !== replayBand?.calibrationChangeP95Raw ||
      payloadBand?.holdoutCovered !== replayBand?.holdoutCovered ||
      payloadBand?.holdoutTotal !== replayBand?.holdoutTotal ||
      payloadBand?.coveragePassed !== replayBand?.coveragePassed ||
      (v4 &&
        (payloadBand?.selectionCovered !== replayBand?.selectionCovered ||
          payloadBand?.selectionTotal !== replayBand?.selectionTotal ||
          payloadBand?.selectionCoveragePassed !== replayBand?.selectionCoveragePassed)) ||
      payload.historicalBacktestOnly !== true ||
      payload.prospectiveValidated !== false ||
      payload.holderExecutableExit !== false
    )
      abort('model_artifact_backtest_mismatch')
    if (version.startsWith('hdelta')) {
      if (
        payload.kind !== 'historical_cash_delta_model_v1' ||
        replay.status !== 'historical_projection' ||
        payload.fitMedianDeltaRaw !== replay.projection.fitMedianDeltaRaw ||
        payload.calibrationResidualP05Raw !== replay.projection.calibrationResidualP05Raw ||
        payload.calibrationResidualP95Raw !== replay.projection.calibrationResidualP95Raw
      )
        abort('model_artifact_delta_mismatch')
      kinds.learnedDelta++
    } else {
      if (
        payload.kind !== 'historical_cash_persistence_band_v1' ||
        replay.status !== 'unavailable' ||
        replay.reason !== 'no_skill_over_persistence' ||
        (v4 ? replayBand?.selectionCoveragePassed !== true : replayBand?.coveragePassed !== true) ||
        payload.fitMedianDeltaRaw !== '0' ||
        payload.calibrationResidualP05Raw !== replayBand.calibrationChangeP05Raw ||
        payload.calibrationResidualP95Raw !== replayBand.calibrationChangeP95Raw
      )
        abort('model_artifact_band_mismatch')
      kinds.persistenceBand++
    }
  }
  return { valid: true, artifacts: artifacts.length, ...kinds }
}

async function main() {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('database_url_required')
  const sql = neon(url)
  await assertModelGuards(sql)
  const manifest = await buildSubjectManifest()
  const [artifacts, archiveRows, superseded, legacyAfterV4] = await Promise.all([
    sql`SELECT sha256, model_version, route_key, destination, horizon_hours, asset,
      source_manifest_sha256, first_archive_anchor_at, last_archive_anchor_at,
      fit_pairs, calibration_pairs, selection_pairs, holdout_pairs, payload_bytes, registered_at
      FROM carry_cash_model_artifacts
      WHERE model_version LIKE 'hdelta3-%' OR model_version LIKE 'hband3-%'
        OR model_version LIKE 'hdelta4-%' OR model_version LIKE 'hband4-%'
      ORDER BY model_version, route_key, destination`,
    readRows(sql),
    sql`SELECT count(*)::integer AS n FROM carry_cash_model_attempts m
      JOIN carry_cash_model_artifacts a ON a.sha256 = m.model_artifact_sha256
      WHERE a.model_version LIKE 'hdelta1-%' OR a.model_version LIKE 'hband1-%'
        OR a.model_version LIKE 'hdelta2-%' OR a.model_version LIKE 'hband2-%'`,
    sql`WITH boundary AS (
        SELECT activated_at FROM carry_cash_model_v4_epoch WHERE id = true
      ) SELECT (SELECT count(*)::integer FROM boundary) AS boundary_count,
        (SELECT count(*)::integer FROM carry_cash_model_artifacts a, boundary e
          WHERE (a.model_version LIKE 'hdelta3-%' OR a.model_version LIKE 'hband3-%')
            AND a.registered_at >= e.activated_at)
        + (SELECT count(*)::integer FROM carry_cash_model_attempts m
          JOIN carry_cash_model_artifacts a ON a.sha256 = m.model_artifact_sha256,
          boundary e
          WHERE (a.model_version LIKE 'hdelta3-%' OR a.model_version LIKE 'hband3-%')
            AND m.issued_at >= e.activated_at) AS n`,
  ])
  if (Number(superseded[0]?.n) !== 0) abort('superseded_artifact_was_issued')
  if (Number(legacyAfterV4[0]?.boundary_count) !== 1 || Number(legacyAfterV4[0]?.n) !== 0)
    abort('legacy_v3_after_v4_boundary')
  const result = auditArtifacts(artifacts, archiveRows, manifest)
  process.stdout.write(JSON.stringify({ ...result, supersededIssued: 0 }) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Carry cash model artifact audit failed closed.\n')
    process.exitCode = 1
  })
}
