// Local v4 aggregate-cash model evidence. Training may use retrospective
// receipts, but every model issue is linked to a later prospective persistence
// issue and every outcome is linked to its sealed persistence score.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import * as projectionNamespace from '../../lib/carry/historicalCashProjection.ts'
import { LOCAL_CARRY_CASH_ROOT, verifyLocalCarryCash } from './localCarryCashStore.mjs'
import { LOCAL_CARRY_ISSUE_ROOT, verifyLocalCashIssueLedger } from './localCarryCashIssueStore.mjs'

const projectHistoricalCash =
  projectionNamespace.projectHistoricalCash ??
  projectionNamespace.default?.projectHistoricalCash ??
  projectionNamespace.default

export const LOCAL_CARRY_CASH_MODEL_ROOT = resolve(
  'data/research/venue-signals/local-carry-cash-model-v4',
)
export const LOCAL_CARRY_CASH_MODEL_STUDY = 'carry-aug-2026-67-subject-aggregate-cash-model-v4'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const SHA = /^[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const MAX_RAW = (1n << 256n) - 1n
const MIN_FREE = 1024 * 1024 * 1024
const MAX_RECORDS = 100_000
const MAX_BYTES = 512 * 1024
const EMPTY_LOCK_GRACE_MS = 60_000
const LOCK_OWNER = 'owner.json'
const MODEL_KINDS = new Set([
  'historical_cash_delta_model_v1',
  'historical_cash_persistence_band_v1',
])
const RECORD_KINDS = new Set(['artifact', 'enrollment', 'model_tick', 'model_issue', 'model_score'])
const UNTOUCHED_HOLDOUT_POLICY = 'untouched_holdout_v1'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const filename = (sequence) => `${String(sequence).padStart(12, '0')}.json`
const subjectKey = (routeKey, destination) => `${routeKey}\0${destination}`
const cellKey = (routeKey, destination, horizonHours) =>
  `${routeKey}\0${destination}\0${horizonHours}`
const hourSlot = (at) => new Date(Math.floor(utc(at) / HOUR) * HOUR).toISOString()
const nextHourSlot = (at) => new Date(Math.ceil(utc(at) / HOUR) * HOUR).toISOString()
const absolute = (value) => (value < 0n ? -value : value)
const clampRaw = (value) => (value < 0n ? 0n : value > MAX_RAW ? MAX_RAW : value)

function fail(code) {
  throw new Error(code)
}

function utc(value, code = 'local_cash_model_bad_time') {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(code)
  return Date.parse(value)
}

function raw(value, code = 'local_cash_model_bad_raw') {
  if (typeof value !== 'string' || !RAW.test(value) || value.length > 78) fail(code)
  const parsed = BigInt(value)
  if (parsed > MAX_RAW) fail(code)
  return parsed
}

function identity(row, subject, decimals = null) {
  return (
    row?.state === 'observed' &&
    row.asset === subject.asset &&
    Number.isInteger(row.assetDecimals) &&
    row.assetDecimals >= 0 &&
    row.assetDecimals <= 255 &&
    (decimals === null || row.assetDecimals === decimals) &&
    typeof row.cashRaw === 'string' &&
    RAW.test(row.cashRaw) &&
    BigInt(row.cashRaw) <= MAX_RAW
  )
}

function subjectRow(receipt, subject) {
  const rows = receipt.rows.filter(
    (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
  )
  if (rows.length !== 1) fail('local_cash_model_subject_row_count')
  return rows[0]
}

function receiptView(receipt) {
  return {
    sequence: receipt.sequence,
    sha256: receipt.sha256,
    collectionMode: receipt.collectionMode,
    anchorAt: receipt.anchorAt,
    block: receipt.block,
    blockHash: receipt.blockHash,
    blockAt: receipt.blockAt,
    firstLocalReceiptAt: receipt.firstLocalReceiptAt,
    rows: receipt.rows,
  }
}

function exactPairs(records, subject, horizonHours, availableAt) {
  const availableMs = utc(availableAt)
  const retrospective = records
    .filter(
      (receipt) =>
        receipt.collectionMode === 'retrospective' &&
        utc(receipt.firstLocalReceiptAt) <= availableMs,
    )
    .sort((a, b) => Date.parse(a.anchorAt) - Date.parse(b.anchorAt) || a.sequence - b.sequence)

  if (horizonHours === 24) {
    const receipts = retrospective
      .filter((receipt) => receipt.anchorAt.endsWith('T00:00:00.000Z'))
      .slice(-120)
    if (receipts.length !== 120) return { status: 'unavailable', reason: 'insufficient_history' }
    let decimals = null
    const daily = []
    for (const receipt of receipts) {
      const row = subjectRow(receipt, subject)
      if (row.state === 'unassessed') return { status: 'unavailable', reason: 'subject_unassessed' }
      if (row.state === 'no_code') return { status: 'unavailable', reason: 'insufficient_history' }
      if (row.state !== 'observed' || !identity(row, subject, decimals))
        return { status: 'unavailable', reason: 'identity_mismatch' }
      decimals ??= row.assetDecimals
      daily.push({ receipt, row })
    }
    const pairs = []
    for (let index = 0; index < daily.length; index += 2) {
      const source = daily[index]
      const target = daily[index + 1]
      if (
        Date.parse(target.receipt.anchorAt) - Date.parse(source.receipt.anchorAt) !== DAY ||
        target.receipt.block <= source.receipt.block ||
        Math.abs(Date.parse(target.receipt.blockAt) - Date.parse(source.receipt.blockAt) - DAY) >
          HOUR
      )
        return { status: 'unavailable', reason: 'malformed_history' }
      pairs.push(pair(source, target, subject, horizonHours))
    }
    return { status: 'pairs', assetDecimals: decimals, pairs }
  }

  const usable = []
  let reason = 'insufficient_history'
  let decimals = null
  for (const receipt of retrospective) {
    const row = subjectRow(receipt, subject)
    if (row.state === 'unassessed') {
      reason = 'subject_unassessed'
      continue
    }
    if (row.state !== 'observed') {
      if (row.state === 'identity_mismatch') reason = 'identity_mismatch'
      if (row.state === 'no_code') reason = 'insufficient_history'
      continue
    }
    if (!identity(row, subject, decimals)) {
      reason = 'identity_mismatch'
      continue
    }
    decimals ??= row.assetDecimals
    usable.push({ receipt, row })
  }
  if (decimals === null) return { status: 'unavailable', reason }

  const byAnchor = new Map()
  for (const point of usable) {
    const anchorMs = utc(point.receipt.anchorAt)
    if (anchorMs % HOUR !== 0 || byAnchor.has(anchorMs)) continue
    byAnchor.set(anchorMs, point)
  }
  const candidates = []
  for (const [anchorMs, source] of [...byAnchor.entries()].sort((a, b) => a[0] - b[0])) {
    const target = byAnchor.get(anchorMs + HOUR)
    if (!target) continue
    const sourceMs = utc(source.receipt.blockAt)
    const targetMs = utc(target.receipt.blockAt)
    if (
      target.receipt.block <= source.receipt.block ||
      targetMs <= sourceMs ||
      Math.abs(targetMs - sourceMs - HOUR) > 15 * 60_000
    )
      continue
    candidates.push({ sourceMs, targetMs, value: pair(source, target, subject, horizonHours) })
  }
  const disjoint = []
  let lastTarget = -Infinity
  for (const candidate of candidates) {
    if (candidate.sourceMs <= lastTarget) continue
    disjoint.push(candidate.value)
    lastTarget = candidate.targetMs
  }
  if (disjoint.length < 60) return { status: 'unavailable', reason: 'insufficient_history' }
  return { status: 'pairs', assetDecimals: decimals, pairs: disjoint.slice(-60) }
}

function pair(source, target, subject, horizonHours) {
  return {
    subjectKey: `${subject.route_key}\0${subject.destination}\0${subject.asset}`,
    sourceAt: source.receipt.blockAt,
    targetAt: target.receipt.blockAt,
    sourceCashRaw: source.row.cashRaw,
    targetCashRaw: target.row.cashRaw,
    sourceReceiptSha256: source.receipt.sha256,
    targetReceiptSha256: target.receipt.sha256,
    sourceBlock: source.receipt.block,
    sourceBlockHash: source.receipt.blockHash,
    targetBlock: target.receipt.block,
    targetBlockHash: target.receipt.blockHash,
    horizonHours,
  }
}

function projectionPairs(pairs) {
  return pairs.map(({ subjectKey: key, sourceAt, targetAt, sourceCashRaw, targetCashRaw }) => ({
    subjectKey: key,
    sourceAt,
    targetAt,
    sourceCashRaw,
    targetCashRaw,
  }))
}

function artifactFromPairs(
  subject,
  horizonHours,
  assetDecimals,
  pairs,
  registeredAt,
  requireUntouchedHoldout,
) {
  const projection = projectHistoricalCash({
    subjectKey: pairs[0].subjectKey,
    horizonHours,
    currentAt: registeredAt,
    currentCashRaw: pairs.at(-1).targetCashRaw,
    pairs: projectionPairs(pairs),
  })
  const learnedSelected = projection.status === 'historical_projection'
  const persistenceSelected =
    !learnedSelected && projection.baselineBand?.selectionCoveragePassed === true
  const untouchedHoldoutPassed = learnedSelected
    ? projection.holdout?.coveragePassed === true &&
      projection.holdout?.pointBeatsPersistence === true
    : persistenceSelected && projection.baselineBand?.coveragePassed === true
  const learned = learnedSelected && (!requireUntouchedHoldout || untouchedHoldoutPassed)
  const persistence = persistenceSelected && (!requireUntouchedHoldout || untouchedHoldoutPassed)
  if (!learned && !persistence)
    return {
      status: 'unavailable',
      reason:
        requireUntouchedHoldout && (learnedSelected || persistenceSelected)
          ? 'untouched_holdout_failed'
          : projection.reason === 'insufficient_history'
            ? 'insufficient_history'
            : projection.reason === 'no_skill_over_persistence'
              ? 'model_selection_failed'
              : projection.reason,
    }
  const modelKind = learned ? 'learned_delta' : 'persistence_band'
  const content = {
    kind: learned ? 'historical_cash_delta_model_v1' : 'historical_cash_persistence_band_v1',
    modelVersion: `${learned ? 'hdelta4-local' : 'hband4-local'}-${Math.floor(
      Date.parse(pairs[0].sourceAt) / 1000,
    )}-${Math.floor(Date.parse(pairs.at(-1).targetAt) / 1000)}`,
    modelKind,
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    assetDecimals,
    horizonHours,
    sourceManifestSha256: null,
    pairSelection:
      horizonHours === 24
        ? 'latest_120_midnight_retrospective_receipts_paired_adjacent'
        : 'latest_60_greedy_disjoint_exact_hour_retrospective_pairs',
    pairs,
    counts: projection.counts,
    selection: projection.selection,
    untouchedTest: projection.holdout,
    baselineBand: projection.baselineBand
      ? {
          calibrationChangeP05Raw: projection.baselineBand.calibrationChangeP05Raw,
          calibrationChangeP95Raw: projection.baselineBand.calibrationChangeP95Raw,
          selectionCovered: projection.baselineBand.selectionCovered,
          selectionTotal: projection.baselineBand.selectionTotal,
          selectionCoveragePassed: projection.baselineBand.selectionCoveragePassed,
          untouchedTestCovered: projection.baselineBand.holdoutCovered,
          untouchedTestTotal: projection.baselineBand.holdoutTotal,
          untouchedTestCoveragePassed: projection.baselineBand.coveragePassed,
        }
      : null,
    fitMedianDeltaRaw: learned ? projection.projection.fitMedianDeltaRaw : '0',
    calibrationResidualP05Raw: learned
      ? projection.projection.calibrationResidualP05Raw
      : projection.baselineBand.calibrationChangeP05Raw,
    calibrationResidualP95Raw: learned
      ? projection.projection.calibrationResidualP95Raw
      : projection.baselineBand.calibrationChangeP95Raw,
    claim: 'aggregate_cash_proxy_only',
    historicalBacktestOnly: true,
    prospectiveValidated: false,
    holderExecutableExit: false,
  }
  return { status: 'artifact', content }
}

function localCashModelPlan(manifest, cashRecords, registeredAt, requireUntouchedHoldout) {
  utc(registeredAt)
  if (!manifest || manifest.subjects?.length !== 67 || !SHA.test(manifest.sha256 ?? ''))
    fail('local_cash_model_manifest')
  const artifacts = []
  const cells = []
  for (const subject of manifest.subjects) {
    for (const horizonHours of [1, 24]) {
      const history = exactPairs(cashRecords, subject, horizonHours, registeredAt)
      if (history.status !== 'pairs') {
        cells.push({
          routeKey: subject.route_key,
          destination: subject.destination,
          asset: subject.asset,
          horizonHours,
          status: 'abstained',
          reason: history.reason,
          artifactContentSha256: null,
        })
        continue
      }
      const built = artifactFromPairs(
        subject,
        horizonHours,
        history.assetDecimals,
        history.pairs,
        registeredAt,
        requireUntouchedHoldout,
      )
      if (built.status !== 'artifact') {
        cells.push({
          routeKey: subject.route_key,
          destination: subject.destination,
          asset: subject.asset,
          horizonHours,
          status: 'abstained',
          reason: built.reason,
          artifactContentSha256: null,
        })
        continue
      }
      built.content.sourceManifestSha256 = manifest.sha256
      const contentSha256 = digest(JSON.stringify(built.content))
      artifacts.push({ contentSha256, content: built.content })
      cells.push({
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: subject.asset,
        horizonHours,
        status: 'enrolled',
        reason: null,
        artifactContentSha256: contentSha256,
      })
    }
  }
  if (
    cells.length !== 134 ||
    new Set(cells.map((cell) => cellKey(cell.routeKey, cell.destination, cell.horizonHours)))
      .size !== 134
  )
    fail('local_cash_model_plan_grid')
  return { artifacts, cells }
}

export function buildLocalCashModelPlan(manifest, cashRecords, registeredAt) {
  return localCashModelPlan(manifest, cashRecords, registeredAt, true)
}

function artifactPassesUntouchedHoldout(content) {
  if (content.modelKind === 'learned_delta')
    return (
      content.untouchedTest?.coveragePassed === true &&
      content.untouchedTest?.pointBeatsPersistence === true
    )
  return (
    content.modelKind === 'persistence_band' &&
    content.baselineBand?.selectionCoveragePassed === true &&
    content.baselineBand?.untouchedTestCoveragePassed === true
  )
}

function canonical(path) {
  const bytes = readFileSync(path, 'utf8')
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail('local_cash_model_record_oversize')
  const record = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(record)}\n`) fail('local_cash_model_noncanonical')
  const { sha256, ...body } = record
  if (!SHA.test(sha256 ?? '') || digest(JSON.stringify(body)) !== sha256)
    fail('local_cash_model_hash_mismatch')
  if (
    !RECORD_KINDS.has(record.kind) ||
    !SHA.test(record.contentSha256 ?? '') ||
    digest(JSON.stringify(record.content)) !== record.contentSha256
  )
    fail('local_cash_model_content_hash_mismatch')
  return record
}

function verifyArtifact(record, manifest, cashBySha) {
  const content = record.content
  if (
    !MODEL_KINDS.has(content.kind) ||
    !['learned_delta', 'persistence_band'].includes(content.modelKind) ||
    content.sourceManifestSha256 !== manifest.sha256 ||
    ![1, 24].includes(content.horizonHours) ||
    content.claim !== 'aggregate_cash_proxy_only' ||
    content.historicalBacktestOnly !== true ||
    content.prospectiveValidated !== false ||
    content.holderExecutableExit !== false ||
    !Array.isArray(content.pairs) ||
    content.pairs.length !== 60 ||
    content.counts?.fit !== 20 ||
    content.counts?.calibration !== 20 ||
    content.counts?.selection !== 10 ||
    content.counts?.holdout !== 10
  )
    fail('local_cash_model_artifact_identity')
  const subject = manifest.subjects.find(
    (row) => row.route_key === content.routeKey && row.destination === content.destination,
  )
  if (!subject || subject.asset !== content.asset) fail('local_cash_model_artifact_subject')
  const expectedSubjectKey = `${subject.route_key}\0${subject.destination}\0${subject.asset}`
  const expectedVersion = `${content.modelKind === 'learned_delta' ? 'hdelta4-local' : 'hband4-local'}-${Math.floor(
    Date.parse(content.pairs[0].sourceAt) / 1000,
  )}-${Math.floor(Date.parse(content.pairs.at(-1).targetAt) / 1000)}`
  if (
    content.kind !==
      (content.modelKind === 'learned_delta'
        ? 'historical_cash_delta_model_v1'
        : 'historical_cash_persistence_band_v1') ||
    content.modelVersion !== expectedVersion ||
    content.pairSelection !==
      (content.horizonHours === 24
        ? 'latest_120_midnight_retrospective_receipts_paired_adjacent'
        : 'latest_60_greedy_disjoint_exact_hour_retrospective_pairs')
  )
    fail('local_cash_model_artifact_version')
  for (const entry of content.pairs) {
    const source = cashBySha.get(entry.sourceReceiptSha256)
    const target = cashBySha.get(entry.targetReceiptSha256)
    if (
      !source ||
      !target ||
      source.collectionMode !== 'retrospective' ||
      target.collectionMode !== 'retrospective' ||
      source.blockAt !== entry.sourceAt ||
      target.blockAt !== entry.targetAt ||
      source.block !== entry.sourceBlock ||
      source.blockHash !== entry.sourceBlockHash ||
      target.block !== entry.targetBlock ||
      target.blockHash !== entry.targetBlockHash ||
      entry.horizonHours !== content.horizonHours ||
      entry.subjectKey !== expectedSubjectKey ||
      utc(source.firstLocalReceiptAt) > utc(record.recordedAt) ||
      utc(target.firstLocalReceiptAt) > utc(record.recordedAt)
    )
      fail('local_cash_model_artifact_receipt')
    const sourceRow = subjectRow(source, subject)
    const targetRow = subjectRow(target, subject)
    if (
      !identity(sourceRow, subject, content.assetDecimals) ||
      !identity(targetRow, subject, content.assetDecimals) ||
      sourceRow.cashRaw !== entry.sourceCashRaw ||
      targetRow.cashRaw !== entry.targetCashRaw
    )
      fail('local_cash_model_artifact_cash')
  }
  const replay = projectHistoricalCash({
    subjectKey: content.pairs[0].subjectKey,
    horizonHours: content.horizonHours,
    currentAt: record.recordedAt,
    currentCashRaw: content.pairs.at(-1).targetCashRaw,
    pairs: projectionPairs(content.pairs),
  })
  const learned = content.modelKind === 'learned_delta'
  if (
    (learned && replay.status !== 'historical_projection') ||
    (!learned &&
      (replay.status !== 'unavailable' ||
        replay.reason !== 'no_skill_over_persistence' ||
        replay.baselineBand?.selectionCoveragePassed !== true)) ||
    JSON.stringify(content.counts) !== JSON.stringify(replay.counts) ||
    JSON.stringify(content.selection) !== JSON.stringify(replay.selection) ||
    JSON.stringify(content.untouchedTest) !== JSON.stringify(replay.holdout)
  )
    fail('local_cash_model_artifact_replay')
  const expectedBand = replay.baselineBand
    ? {
        calibrationChangeP05Raw: replay.baselineBand.calibrationChangeP05Raw,
        calibrationChangeP95Raw: replay.baselineBand.calibrationChangeP95Raw,
        selectionCovered: replay.baselineBand.selectionCovered,
        selectionTotal: replay.baselineBand.selectionTotal,
        selectionCoveragePassed: replay.baselineBand.selectionCoveragePassed,
        untouchedTestCovered: replay.baselineBand.holdoutCovered,
        untouchedTestTotal: replay.baselineBand.holdoutTotal,
        untouchedTestCoveragePassed: replay.baselineBand.coveragePassed,
      }
    : null
  if (
    JSON.stringify(content.baselineBand) !== JSON.stringify(expectedBand) ||
    content.fitMedianDeltaRaw !== (learned ? replay.projection.fitMedianDeltaRaw : '0') ||
    content.calibrationResidualP05Raw !==
      (learned
        ? replay.projection.calibrationResidualP05Raw
        : replay.baselineBand.calibrationChangeP05Raw) ||
    content.calibrationResidualP95Raw !==
      (learned
        ? replay.projection.calibrationResidualP95Raw
        : replay.baselineBand.calibrationChangeP95Raw)
  )
    fail('local_cash_model_artifact_parameters')
}

function applyArtifact(content, currentCashRaw, targetAt) {
  const current = raw(currentCashRaw)
  const center =
    content.modelKind === 'learned_delta' ? current + BigInt(content.fitMedianDeltaRaw) : current
  const low = center + BigInt(content.calibrationResidualP05Raw)
  const high = center + BigInt(content.calibrationResidualP95Raw)
  return {
    targetAt,
    pointRaw: clampRaw(center).toString(),
    bandLowRaw: clampRaw(low).toString(),
    bandHighRaw: clampRaw(high).toString(),
  }
}

function findBaselineIssue(baseline, content) {
  return baseline.records.find(
    (row) => row.kind === 'issue' && row.sha256 === content.baselineIssueSha256,
  )
}

function expectedTick(content, enrollment, baseline) {
  const slotMs = utc(content.slotAt)
  if (
    content.enrollmentContentSha256 !== enrollment.contentSha256 ||
    content.slotAt !== hourSlot(content.slotAt) ||
    slotMs < utc(enrollment.content.schedule.firstSlotAt) ||
    !Number.isInteger(content.baselineLedgerSequence) ||
    content.baselineLedgerSequence < enrollment.content.baselineCutoverSequence ||
    content.baselineLedgerSequence > baseline.count ||
    content.baselineLedgerSha256 !==
      (content.baselineLedgerSequence
        ? baseline.records[content.baselineLedgerSequence - 1].sha256
        : null)
  )
    fail('local_cash_model_tick_identity')
  const prefix = baseline.records.slice(0, content.baselineLedgerSequence)
  const issue = prefix.find(
    (record) =>
      record.kind === 'issue' &&
      record.slotAt === content.slotAt &&
      record.sequence > enrollment.content.baselineCutoverSequence &&
      record.issuedAt >= enrollment.content.activatedAt,
  )
  const slotEnd = slotMs + HOUR
  const onTime = issue && utc(issue.issuedAt) < slotEnd && utc(content.recordedAt) < slotEnd
  return {
    enrollmentContentSha256: enrollment.contentSha256,
    slotAt: content.slotAt,
    recordedAt: content.recordedAt,
    status: !issue ? 'baseline_missing' : onTime ? 'on_time' : 'late',
    baselineLedgerSequence: content.baselineLedgerSequence,
    baselineLedgerSha256: content.baselineLedgerSha256,
    baselineIssueSha256: issue?.sha256 ?? null,
  }
}

function buildTickBodies(enrollment, baseline, ticks, now) {
  const firstMs = utc(enrollment.content.schedule.firstSlotAt)
  const currentMs = utc(hourSlot(now))
  const latestMs = ticks.length ? utc(ticks.at(-1).content.slotAt) : firstMs - HOUR
  const start = Math.max(firstMs, latestMs + HOUR)
  const slots = []
  for (let slot = start; slot <= currentMs && slots.length < 168; slot += HOUR)
    slots.push(new Date(slot).toISOString())
  return slots.map((slotAt) => {
    const seed = {
      enrollmentContentSha256: enrollment.contentSha256,
      slotAt,
      recordedAt: now,
      baselineLedgerSequence: baseline.count,
      baselineLedgerSha256: baseline.last?.sha256 ?? null,
    }
    return {
      kind: 'model_tick',
      recordedAt: now,
      content: expectedTick(seed, enrollment, baseline),
    }
  })
}

function plannedModelIssue(
  content,
  enrollment,
  tick,
  artifacts,
  baseline,
  cashBySha,
  requireUntouchedHoldout,
) {
  const issue = findBaselineIssue(baseline, content)
  if (
    !issue ||
    issue.sequence <= enrollment.content.baselineCutoverSequence ||
    issue.issuedAt < enrollment.content.activatedAt ||
    content.baselineIssueSequence !== issue.sequence ||
    content.baselineIssueSlotAt !== issue.slotAt ||
    content.tickSlotAt !== issue.slotAt ||
    !tick ||
    tick.content.slotAt !== issue.slotAt ||
    tick.content.status !== 'on_time' ||
    tick.content.enrollmentContentSha256 !== enrollment.contentSha256 ||
    tick.content.baselineIssueSha256 !== issue.sha256 ||
    content.enrollmentContentSha256 !== enrollment.contentSha256 ||
    utc(content.issuedAt) < utc(issue.issuedAt)
  )
    fail('local_cash_model_issue_baseline')
  const cells = new Map(
    enrollment.content.cells.map((cell) => [
      cellKey(cell.routeKey, cell.destination, cell.horizonHours),
      cell,
    ]),
  )
  return issue.attempts.map((attempt) => {
    const key = cellKey(attempt.routeKey, attempt.destination, attempt.horizonHours)
    const enrolled = cells.get(key)
    const base = {
      routeKey: attempt.routeKey,
      destination: attempt.destination,
      asset: attempt.asset,
      horizonHours: attempt.horizonHours,
      targetAt: attempt.targetAt,
      targetLowAt: attempt.targetLowAt,
      targetHighAt: attempt.targetHighAt,
    }
    if (!enrolled || enrolled.asset !== attempt.asset)
      return { ...base, status: 'abstained', reason: 'enrollment_identity_mismatch' }
    if (attempt.status !== 'issued')
      return { ...base, status: 'abstained', reason: `baseline_${attempt.status}` }
    if (enrolled.status !== 'enrolled')
      return { ...base, status: 'abstained', reason: enrolled.reason }
    const artifact = artifacts.get(enrolled.artifactContentSha256)
    if (!artifact) fail('local_cash_model_issue_artifact_missing')
    if (requireUntouchedHoldout && !artifactPassesUntouchedHoldout(artifact.content))
      return { ...base, status: 'abstained', reason: 'untouched_holdout_failed' }
    if (utc(artifact.recordedAt) > utc(issue.issuedAt))
      return { ...base, status: 'abstained', reason: 'artifact_registered_after_baseline' }
    if (attempt.source.assetDecimals !== artifact.content.assetDecimals)
      return { ...base, status: 'abstained', reason: 'asset_decimals_changed' }
    if (utc(content.issuedAt) >= utc(attempt.targetLowAt))
      return { ...base, status: 'abstained', reason: 'late_issue' }
    const receipt = cashBySha.get(attempt.source?.receiptSha256)
    const subject = {
      route_key: attempt.routeKey,
      destination: attempt.destination,
      asset: attempt.asset,
    }
    const row = receipt && subjectRow(receipt, subject)
    if (
      !receipt ||
      receipt.collectionMode !== 'current' ||
      receipt.block !== attempt.source.block ||
      receipt.blockHash !== attempt.source.blockHash ||
      receipt.blockAt !== attempt.source.blockAt ||
      !identity(row, subject, attempt.source.assetDecimals) ||
      row.cashRaw !== attempt.source.cashRaw ||
      attempt.forecastCashRaw !== attempt.source.cashRaw
    )
      fail('local_cash_model_issue_source_receipt')
    const forecast = applyArtifact(artifact.content, attempt.source.cashRaw, attempt.targetAt)
    return {
      ...base,
      status: 'issued',
      reason: null,
      artifactContentSha256: artifact.contentSha256,
      modelKind: artifact.content.modelKind,
      source: {
        receiptSha256: receipt.sha256,
        block: receipt.block,
        blockHash: receipt.blockHash,
        blockAt: receipt.blockAt,
        assetDecimals: row.assetDecimals,
        cashRaw: row.cashRaw,
      },
      forecast,
    }
  })
}

function plannedModelScore(content, issueRecord, baseline) {
  const modelAttempts = issueRecord.content.attempts.filter(
    (attempt) => attempt.horizonHours === content.horizonHours && attempt.status === 'issued',
  )
  const baselineScore = baseline.records.find(
    (row) => row.kind === 'score' && row.sha256 === content.baselineScoreSha256,
  )
  if (
    !baselineScore ||
    baselineScore.issueSha256 !== issueRecord.content.baselineIssueSha256 ||
    (Object.hasOwn(baselineScore, 'horizonHours') &&
      baselineScore.horizonHours !== content.horizonHours) ||
    content.modelIssueContentSha256 !== issueRecord.contentSha256 ||
    content.baselineScoreSequence !== baselineScore.sequence ||
    utc(content.scoredAt) < utc(baselineScore.scoredAt)
  )
    fail('local_cash_model_score_baseline')
  const rows = new Map(
    baselineScore.attempts
      .filter(Boolean)
      .filter((attempt) => attempt.horizonHours === content.horizonHours)
      .map((attempt) => [subjectKey(attempt.routeKey, attempt.destination), attempt]),
  )
  return modelAttempts.map((attempt) => {
    const outcome = rows.get(subjectKey(attempt.routeKey, attempt.destination))
    if (!outcome) fail('local_cash_model_score_outcome_missing')
    const base = {
      routeKey: attempt.routeKey,
      destination: attempt.destination,
      asset: attempt.asset,
      horizonHours: attempt.horizonHours,
      artifactContentSha256: attempt.artifactContentSha256,
      sourceAt: attempt.source.blockAt,
      targetAt: attempt.targetAt,
      targetHighAt: attempt.targetHighAt,
    }
    if (outcome.status === 'censored_no_target')
      return {
        ...base,
        status: 'censored_missing',
        outcome: null,
        pointAbsoluteErrorRaw: null,
        persistenceAbsoluteErrorRaw: null,
        bandCovered: null,
      }
    if (outcome.status !== 'scored' || !outcome.target) fail('local_cash_model_score_status')
    const outcomeRaw = raw(outcome.target.cashRaw)
    const point = raw(attempt.forecast.pointRaw)
    const persistence = raw(attempt.source.cashRaw)
    return {
      ...base,
      status: 'observed',
      outcome: {
        receiptSha256: outcome.target.receiptSha256,
        block: outcome.target.block,
        blockHash: outcome.target.blockHash,
        blockAt: outcome.target.blockAt,
        assetDecimals: outcome.target.assetDecimals,
        cashRaw: outcome.target.cashRaw,
      },
      pointAbsoluteErrorRaw: absolute(outcomeRaw - point).toString(),
      persistenceAbsoluteErrorRaw: absolute(outcomeRaw - persistence).toString(),
      bandCovered:
        outcomeRaw >= raw(attempt.forecast.bandLowRaw) &&
        outcomeRaw <= raw(attempt.forecast.bandHighRaw),
    }
  })
}

export function buildLocalCashModelScorecard(records, options = {}) {
  const baselineRecords = options.baselineRecords ?? []
  const candidateTimes = [
    ...records.map((record) => record.recordedAt).filter(Boolean),
    ...baselineRecords.map((record) => record.issuedAt ?? record.scoredAt).filter(Boolean),
  ]
  const evaluationAt = options.asOf ?? candidateTimes.sort((a, b) => utc(a) - utc(b)).at(-1) ?? null
  const evaluationMs = evaluationAt === null ? null : utc(evaluationAt)
  const visibleRecords =
    evaluationMs === null
      ? records
      : records.filter((record) => !record.recordedAt || utc(record.recordedAt) <= evaluationMs)
  const visibleBaseline =
    evaluationMs === null
      ? baselineRecords
      : baselineRecords.filter((record) => utc(record.issuedAt ?? record.scoredAt) <= evaluationMs)
  const artifacts = new Map(
    visibleRecords
      .filter((record) => record.kind === 'artifact')
      .map((record) => [record.contentSha256, record]),
  )
  const enrollmentRecords = visibleRecords
    .filter((record) => record.kind === 'enrollment')
    .sort(
      (a, b) =>
        utc(a.recordedAt ?? a.content.activatedAt) - utc(b.recordedAt ?? b.content.activatedAt) ||
        (a.sequence ?? 0) - (b.sequence ?? 0),
    )
  const enrollments = new Map(enrollmentRecords.map((record) => [record.contentSha256, record]))
  const issues = visibleRecords.filter((record) => record.kind === 'model_issue')
  const scores = visibleRecords.filter((record) => record.kind === 'model_score')
  const ticks = visibleRecords.filter((record) => record.kind === 'model_tick')
  const tickBySlot = new Map(ticks.map((record) => [record.content.slotAt, record]))
  const issueByTick = new Map(
    issues.map((record) => [
      `${record.content.enrollmentContentSha256}\0${record.content.tickSlotAt}`,
      record,
    ]),
  )
  const baselineScoreKeys = new Set(
    visibleBaseline
      .filter((record) => record.kind === 'score')
      .flatMap((record) =>
        (Object.hasOwn(record, 'horizonHours') ? [record.horizonHours] : [1, 24]).map(
          (horizonHours) => `${record.issueSha256}\0${horizonHours}`,
        ),
      ),
  )
  const scoreByIssueHorizon = new Map(
    scores.map((record) => [
      `${record.content.modelIssueContentSha256}\0${record.content.horizonHours}`,
      record,
    ]),
  )
  const groups = new Map()
  function groupFor(cell) {
    const artifact = artifacts.get(cell.artifactContentSha256)
    if (!artifact) fail('local_cash_model_scorecard_artifact_missing')
    const key = `${cellKey(cell.routeKey, cell.destination, cell.horizonHours)}\0${cell.artifactContentSha256}`
    if (!groups.has(key))
      groups.set(key, {
        routeKey: cell.routeKey,
        destination: cell.destination,
        asset: cell.asset,
        horizonHours: cell.horizonHours,
        artifactContentSha256: cell.artifactContentSha256,
        modelKind: artifact.content.modelKind,
        historicalQualificationPassed: artifactPassesUntouchedHoldout(artifact.content),
        issued: 0,
        observed: [],
        censoredMissing: 0,
        pending: 0,
        pendingImmature: 0,
        pendingOverdue: 0,
        scheduleExpected: 0,
        scheduleTicksOnTime: 0,
        scheduleMissing: 0,
        scheduleAbstentions: new Map(),
        latestExpectedSlotAt: null,
        lastTickSlotAt: null,
      })
    return groups.get(key)
  }
  for (const enrollment of enrollmentRecords)
    for (const cell of enrollment.content.cells.filter((row) => row.status === 'enrolled'))
      groupFor(cell)

  const firstSlotMs = enrollmentRecords.length
    ? Math.min(...enrollmentRecords.map((record) => utc(record.content.schedule.firstSlotAt)))
    : null
  const latestCompletedSlotMs =
    evaluationMs === null ? null : Math.floor((evaluationMs - HOUR) / HOUR) * HOUR
  const latestTickMs = ticks.length
    ? Math.max(...ticks.map((record) => utc(record.content.slotAt)))
    : null
  const boundaryCandidates = [latestCompletedSlotMs, latestTickMs].filter(
    (value) => value !== null && (firstSlotMs === null || value >= firstSlotMs),
  )
  const evaluationBoundaryMs = boundaryCandidates.length ? Math.max(...boundaryCandidates) : null
  const activeEnrollment = (slotMs) =>
    enrollmentRecords
      .filter((record) => utc(record.recordedAt ?? record.content.activatedAt) < slotMs + HOUR)
      .at(-1) ?? null

  for (
    let slotMs = firstSlotMs ?? 0;
    evaluationBoundaryMs !== null && slotMs <= evaluationBoundaryMs;
    slotMs += HOUR
  ) {
    const slotAt = new Date(slotMs).toISOString()
    const tick = tickBySlot.get(slotAt)
    const enrollment = tick
      ? enrollments.get(tick.content.enrollmentContentSha256)
      : activeEnrollment(slotMs)
    if (!enrollment) continue
    const issue = tick
      ? issueByTick.get(`${enrollment.contentSha256}\0${tick.content.slotAt}`)
      : null
    const attempts = new Map(
      (issue?.content.attempts ?? []).map((attempt) => [
        cellKey(attempt.routeKey, attempt.destination, attempt.horizonHours),
        attempt,
      ]),
    )
    for (const cell of enrollment.content.cells.filter((row) => row.status === 'enrolled')) {
      const group = groupFor(cell)
      group.scheduleExpected++
      group.latestExpectedSlotAt = slotAt
      if (tick) group.lastTickSlotAt = slotAt
      if (tick?.content.status === 'on_time') group.scheduleTicksOnTime++
      const attempt = attempts.get(cellKey(cell.routeKey, cell.destination, cell.horizonHours))
      let abstentionReason = null
      if (!tick) {
        abstentionReason = 'tick_missing'
        group.scheduleMissing++
      } else if (tick.content.status !== 'on_time') abstentionReason = `tick_${tick.content.status}`
      else if (!issue) abstentionReason = 'model_issue_missing'
      else if (!attempt) abstentionReason = 'attempt_missing'
      else if (
        attempt.status !== 'issued' ||
        attempt.artifactContentSha256 !== cell.artifactContentSha256
      )
        abstentionReason = attempt.reason ?? 'artifact_mismatch'
      if (abstentionReason) {
        group.scheduleAbstentions.set(
          abstentionReason,
          (group.scheduleAbstentions.get(abstentionReason) ?? 0) + 1,
        )
        continue
      }
      group.issued++
      const score = scoreByIssueHorizon.get(`${issue.contentSha256}\0${attempt.horizonHours}`)
      if (!score) {
        group.pending++
        const overdue =
          baselineScoreKeys.has(`${issue.content.baselineIssueSha256}\0${attempt.horizonHours}`) ||
          (evaluationMs !== null && evaluationMs >= utc(attempt.targetHighAt) + HOUR)
        if (overdue) group.pendingOverdue++
        else group.pendingImmature++
        continue
      }
      const outcome = score.content.outcomes.find(
        (row) => row.routeKey === attempt.routeKey && row.destination === attempt.destination,
      )
      if (!outcome) fail('local_cash_model_scorecard_missing_outcome')
      if (outcome.status === 'censored_missing') group.censoredMissing++
      else group.observed.push(outcome)
    }
  }
  const bySubject = [...groups.values()]
    .map((group) => {
      const observed = [...group.observed].sort(
        (a, b) => utc(a.sourceAt) - utc(b.sourceAt) || utc(a.targetAt) - utc(b.targetAt),
      )
      const independent = []
      let lastTargetHigh = -Infinity
      for (const row of observed) {
        const source = utc(row.sourceAt)
        const targetHigh = utc(row.targetHighAt)
        if (source <= lastTargetHigh) continue
        independent.push(row)
        lastTargetHigh = targetHigh
      }
      const covered = independent.filter((row) => row.bandCovered).length
      const modelError = independent.reduce(
        (total, row) => total + BigInt(row.pointAbsoluteErrorRaw),
        0n,
      )
      const persistenceError = independent.reduce(
        (total, row) => total + BigInt(row.persistenceAbsoluteErrorRaw),
        0n,
      )
      const enough = independent.length >= 20
      const coveragePassed = enough && covered * 100 >= 80 * independent.length
      const sealed = observed.length + group.censoredMissing + group.pendingOverdue
      const outcomeAvailabilityPassed = enough && sealed > 0 && observed.length * 100 >= 80 * sealed
      const scheduleCoveragePassed =
        enough && group.scheduleExpected > 0 && group.issued * 100 >= 80 * group.scheduleExpected
      const scheduleFresh =
        group.lastTickSlotAt !== null &&
        group.latestExpectedSlotAt !== null &&
        utc(group.lastTickSlotAt) >= utc(group.latestExpectedSlotAt)
      const pointBeatsPersistence = modelError < persistenceError
      const skillPassed = group.modelKind === 'persistence_band' || pointBeatsPersistence
      return {
        routeKey: group.routeKey,
        destination: group.destination,
        asset: group.asset,
        horizonHours: group.horizonHours,
        artifactContentSha256: group.artifactContentSha256,
        modelKind: group.modelKind,
        issued: group.issued,
        observed: observed.length,
        censoredMissing: group.censoredMissing,
        pending: group.pending,
        pendingImmature: group.pendingImmature,
        pendingOverdue: group.pendingOverdue,
        independentObserved: independent.length,
        bandCovered: covered,
        coveragePassed,
        outcomeAvailabilityPassed,
        scheduleExpected: group.scheduleExpected,
        scheduleOnTime: group.scheduleTicksOnTime,
        scheduleIssued: group.issued,
        scheduleAbstained: group.scheduleExpected - group.issued,
        scheduleMissing: group.scheduleMissing,
        scheduleFresh,
        latestExpectedSlotAt: group.latestExpectedSlotAt,
        lastTickSlotAt: group.lastTickSlotAt,
        scheduleAbstentions: Object.fromEntries(
          [...group.scheduleAbstentions].sort(([a], [b]) => a.localeCompare(b)),
        ),
        scheduleCoveragePassed,
        pointBeatsPersistence:
          group.modelKind === 'learned_delta' && independent.length ? pointBeatsPersistence : null,
        modelMae: {
          numeratorRaw: modelError.toString(),
          denominator: independent.length,
        },
        persistenceMae: {
          numeratorRaw: persistenceError.toString(),
          denominator: independent.length,
        },
        prospectiveValidated:
          group.historicalQualificationPassed &&
          enough &&
          coveragePassed &&
          outcomeAvailabilityPassed &&
          scheduleCoveragePassed &&
          scheduleFresh &&
          skillPassed,
        claim: 'aggregate_cash_proxy_only',
        holderExecutableExit: false,
      }
    })
    .sort(
      (a, b) =>
        a.routeKey.localeCompare(b.routeKey) ||
        a.destination.localeCompare(b.destination) ||
        a.horizonHours - b.horizonHours ||
        a.artifactContentSha256.localeCompare(b.artifactContentSha256),
    )
  return {
    kind: 'prospective_aggregate_cash_model_scorecard_v1',
    evaluationAt,
    latestExpectedSlotAt:
      evaluationBoundaryMs === null ? null : new Date(evaluationBoundaryMs).toISOString(),
    lastTickSlotAt: latestTickMs === null ? null : new Date(latestTickMs).toISOString(),
    recorderFresh:
      evaluationBoundaryMs === null ||
      (latestCompletedSlotMs !== null &&
        latestTickMs !== null &&
        latestTickMs >= latestCompletedSlotMs),
    validationUnit: 'exact_subject_horizon_artifact',
    independenceRule: 'greedy_source_after_previous_target_high',
    minimumIndependentObserved: 20,
    minimumBandCoveragePercent: 80,
    minimumOutcomeAvailabilityPercent: 80,
    minimumScheduleCoveragePercent: 80,
    holderExecutableExit: false,
    validatedSubjects: bySubject.filter((row) => row.prospectiveValidated).length,
    bySubject,
  }
}

export function verifyLocalCarryCashModelLedger(
  manifest,
  cashRoot = LOCAL_CARRY_CASH_ROOT,
  baselineRoot = LOCAL_CARRY_ISSUE_ROOT,
  root = LOCAL_CARRY_CASH_MODEL_ROOT,
  dependencies = null,
) {
  const cash = dependencies?.cash ?? verifyLocalCarryCash(manifest, cashRoot)
  const baseline =
    dependencies?.baseline ?? verifyLocalCashIssueLedger(manifest, cashRoot, baselineRoot)
  validateVerifiedDependencies(manifest, cash, baseline)
  const cashBySha = new Map(cash.records.map((record) => [record.sha256, receiptView(record)]))
  if (!existsSync(root))
    return {
      count: 0,
      last: null,
      records: [],
      artifacts: new Map(),
      enrollments: [],
      ticks: [],
      issues: [],
      scores: [],
      scorecard: buildLocalCashModelScorecard([], { baselineRecords: baseline.records }),
      cash,
      baseline,
    }
  const files = readdirSync(root)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
  if (files.length > MAX_RECORDS) fail('local_cash_model_count_limit')
  const records = []
  const artifacts = new Map()
  const enrollments = []
  const ticks = []
  const tickBySlot = new Map()
  const issues = []
  const scores = []
  const issueByContent = new Map()
  const issuedBaselines = new Set()
  const scoredIssueHorizons = new Set()
  for (const [index, file] of files.entries()) {
    if (file !== filename(index + 1)) fail('local_cash_model_sequence_gap')
    const record = canonical(join(root, file))
    if (
      record.study !== LOCAL_CARRY_CASH_MODEL_STUDY ||
      record.schemaVersion !== 4 ||
      record.sequence !== index + 1 ||
      record.previousSha256 !== (records.at(-1)?.sha256 ?? null) ||
      record.manifestSha256 !== manifest.sha256 ||
      (records.length && utc(record.recordedAt) < utc(records.at(-1).recordedAt))
    )
      fail('local_cash_model_chain_identity')
    utc(record.recordedAt)
    if (record.kind === 'artifact') {
      if (artifacts.has(record.contentSha256)) fail('local_cash_model_duplicate_artifact')
      verifyArtifact(record, manifest, cashBySha)
      artifacts.set(record.contentSha256, record)
    } else if (record.kind === 'enrollment') {
      const content = record.content
      if (content.activatedAt !== enrollments[0]?.content.activatedAt && enrollments.length > 0)
        fail('local_cash_model_activation_changed')
      if (
        enrollments.length > 0 &&
        (content.baselineCutoverSequence !== enrollments[0].content.baselineCutoverSequence ||
          content.baselineCutoverSha256 !== enrollments[0].content.baselineCutoverSha256 ||
          JSON.stringify(content.schedule) !== JSON.stringify(enrollments[0].content.schedule))
      )
        fail('local_cash_model_cutover_changed')
      if (
        !Array.isArray(content.cells) ||
        content.cells.length !== 134 ||
        new Set(
          content.cells.map((cell) => cellKey(cell.routeKey, cell.destination, cell.horizonHours)),
        ).size !== 134 ||
        !Number.isInteger(content.cashLedgerSequenceBoundary) ||
        content.cashLedgerSequenceBoundary < 0 ||
        content.cashLedgerSequenceBoundary > cash.count ||
        content.cashLedgerBoundarySha256 !==
          (content.cashLedgerSequenceBoundary
            ? cash.records[content.cashLedgerSequenceBoundary - 1].sha256
            : null) ||
        !Number.isInteger(content.baselineCutoverSequence) ||
        content.baselineCutoverSequence < 0 ||
        content.baselineCutoverSequence > baseline.count ||
        content.baselineCutoverSha256 !==
          (content.baselineCutoverSequence
            ? baseline.records[content.baselineCutoverSequence - 1].sha256
            : null) ||
        utc(content.activatedAt) !==
          utc(enrollments[0]?.content.activatedAt ?? content.activatedAt) ||
        content.plannedAt !== record.recordedAt ||
        (!enrollments.length && content.activatedAt !== record.recordedAt) ||
        utc(record.recordedAt) < utc(content.activatedAt) ||
        content.schedule?.cadence !== 'utc_hour' ||
        content.schedule?.intervalHours !== 1 ||
        content.schedule?.firstSlotAt !== nextHourSlot(content.activatedAt) ||
        content.schedule?.issueDeadline !== 'strictly_before_target_low' ||
        content.claim !== 'aggregate_cash_proxy_only' ||
        content.holderExecutableExit !== false
      )
        fail('local_cash_model_enrollment_identity')
      const boundaryRecords = cash.records.slice(0, content.cashLedgerSequenceBoundary)
      if (
        content.qualificationPolicy !== undefined &&
        content.qualificationPolicy !== UNTOUCHED_HOLDOUT_POLICY
      )
        fail('local_cash_model_enrollment_identity')
      const replay = localCashModelPlan(
        manifest,
        boundaryRecords,
        content.plannedAt,
        content.qualificationPolicy === UNTOUCHED_HOLDOUT_POLICY,
      )
      const replayCells = replay.cells
      if (JSON.stringify(content.cells) !== JSON.stringify(replayCells))
        fail('local_cash_model_enrollment_replay')
      for (const cell of content.cells.filter((cell) => cell.status === 'enrolled')) {
        const artifact = artifacts.get(cell.artifactContentSha256)
        if (!artifact || utc(artifact.recordedAt) > utc(record.recordedAt))
          fail('local_cash_model_enrollment_artifact')
      }
      enrollments.push(record)
    } else if (record.kind === 'model_tick') {
      const enrollment = enrollments.find(
        (row) => row.contentSha256 === record.content.enrollmentContentSha256,
      )
      const previousTick = ticks.at(-1)
      if (
        !enrollment ||
        record.recordedAt !== record.content.recordedAt ||
        tickBySlot.has(record.content.slotAt) ||
        record.content.slotAt !==
          (previousTick
            ? new Date(utc(previousTick.content.slotAt) + HOUR).toISOString()
            : enrollment.content.schedule.firstSlotAt) ||
        JSON.stringify(record.content) !==
          JSON.stringify(expectedTick(record.content, enrollment, baseline))
      )
        fail('local_cash_model_tick_replay')
      ticks.push(record)
      tickBySlot.set(record.content.slotAt, record)
    } else if (record.kind === 'model_issue') {
      const enrollment = enrollments.find(
        (row) => row.contentSha256 === record.content.enrollmentContentSha256,
      )
      if (
        !enrollment ||
        issuedBaselines.has(record.content.baselineIssueSha256) ||
        record.recordedAt !== record.content.issuedAt
      )
        fail('local_cash_model_issue_identity')
      const expected = plannedModelIssue(
        record.content,
        enrollment,
        tickBySlot.get(record.content.tickSlotAt),
        artifacts,
        baseline,
        cashBySha,
        record.content.qualificationPolicy === UNTOUCHED_HOLDOUT_POLICY,
      )
      if (
        record.content.qualificationPolicy !== undefined &&
        record.content.qualificationPolicy !== UNTOUCHED_HOLDOUT_POLICY
      )
        fail('local_cash_model_issue_identity')
      if (
        expected.length !== 134 ||
        JSON.stringify(record.content.attempts) !== JSON.stringify(expected)
      )
        fail('local_cash_model_issue_replay')
      issuedBaselines.add(record.content.baselineIssueSha256)
      issues.push(record)
      issueByContent.set(record.contentSha256, record)
    } else if (record.kind === 'model_score') {
      const issue = issueByContent.get(record.content.modelIssueContentSha256)
      const key = `${record.content.modelIssueContentSha256}\0${record.content.horizonHours}`
      if (
        !issue ||
        scoredIssueHorizons.has(key) ||
        record.recordedAt !== record.content.scoredAt ||
        ![1, 24].includes(record.content.horizonHours)
      )
        fail('local_cash_model_score_identity')
      const expected = plannedModelScore(record.content, issue, baseline)
      if (JSON.stringify(record.content.outcomes) !== JSON.stringify(expected))
        fail('local_cash_model_score_replay')
      scoredIssueHorizons.add(key)
      scores.push(record)
    }
    records.push(record)
  }
  return {
    count: records.length,
    last: records.at(-1) ?? null,
    records,
    artifacts,
    enrollments,
    ticks,
    issues,
    scores,
    scorecard: buildLocalCashModelScorecard(records, {
      baselineRecords: baseline.records,
    }),
    cash,
    baseline,
  }
}

/**
 * API-safe reuse path. The caller supplies outputs it already obtained from
 * the two canonical verifiers; identity and cross-ledger receipt bindings are
 * checked here without scanning either archive again.
 */
export function verifyLocalCarryCashModelLedgerFromVerified(
  manifest,
  dependencies,
  root = LOCAL_CARRY_CASH_MODEL_ROOT,
) {
  return verifyLocalCarryCashModelLedger(manifest, null, null, root, dependencies)
}

function validateVerifiedDependencies(manifest, cash, baseline) {
  if (
    !cash ||
    !baseline ||
    !Array.isArray(cash.records) ||
    !Array.isArray(baseline.records) ||
    cash.count !== cash.records.length ||
    baseline.count !== baseline.records.length ||
    (cash.count ? cash.last?.sha256 !== cash.records.at(-1)?.sha256 : cash.last !== null) ||
    (baseline.count
      ? baseline.last?.sha256 !== baseline.records.at(-1)?.sha256
      : baseline.last !== null) ||
    cash.records.some((record, index) => {
      const { sha256, ...body } = record
      return (
        record.sequence !== index + 1 ||
        record.manifestSha256 !== manifest.sha256 ||
        record.previousSha256 !== (cash.records[index - 1]?.sha256 ?? null) ||
        !SHA.test(sha256 ?? '') ||
        digest(JSON.stringify(body)) !== sha256
      )
    }) ||
    baseline.records.some((record, index) => {
      const { sha256, ...body } = record
      return (
        record.sequence !== index + 1 ||
        record.manifestSha256 !== manifest.sha256 ||
        record.previousSha256 !== (baseline.records[index - 1]?.sha256 ?? null) ||
        !SHA.test(sha256 ?? '') ||
        digest(JSON.stringify(body)) !== sha256
      )
    })
  )
    fail('local_cash_model_verified_dependency_identity')
  const cashShas = new Set(cash.records.map((record) => record.sha256))
  for (const record of baseline.records) {
    if (record.kind === 'issue') {
      for (const attempt of record.attempts.filter((row) => row.status === 'issued')) {
        if (!cashShas.has(attempt.source?.receiptSha256))
          fail('local_cash_model_verified_dependency_receipt')
      }
    } else if (record.kind === 'score') {
      for (const attempt of record.attempts.filter(Boolean)) {
        if (attempt.status === 'scored' && !cashShas.has(attempt.target?.receiptSha256))
          fail('local_cash_model_verified_dependency_receipt')
      }
    }
  }
}

function reserve(root, bytes) {
  let path = root
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) fail('local_cash_model_disk_root')
    path = parent
  }
  const fs = statfsSync(path)
  if (Number(fs.bavail) * Number(fs.bsize) - bytes < MIN_FREE) fail('local_cash_model_disk_reserve')
}

function dedupeBodies(bodies, verified) {
  const artifactShas = new Set(verified.artifacts.keys())
  const enrollmentShas = new Set(verified.enrollments.map((record) => record.contentSha256))
  const enrollmentShapes = new Set(
    verified.enrollments.map((record) =>
      JSON.stringify({
        cashLedgerSequenceBoundary: record.content.cashLedgerSequenceBoundary,
        cashLedgerBoundarySha256: record.content.cashLedgerBoundarySha256,
        qualificationPolicy: record.content.qualificationPolicy ?? null,
        cells: record.content.cells,
      }),
    ),
  )
  const baselineIssues = new Set(
    verified.issues.map((record) => record.content.baselineIssueSha256),
  )
  const tickSlots = new Set(verified.ticks.map((record) => record.content.slotAt))
  const scoreKeys = new Set(
    verified.scores.map(
      (record) => `${record.content.modelIssueContentSha256}\0${record.content.horizonHours}`,
    ),
  )
  return bodies.filter((body) => {
    let contentSha256 = digest(JSON.stringify(body.content))
    if (body.kind === 'artifact') {
      if (artifactShas.has(contentSha256)) return false
      artifactShas.add(contentSha256)
      return true
    }
    if (body.kind === 'enrollment') {
      const activation = verified.enrollments[0]?.content
      if (activation && body.content.activatedAt !== activation.activatedAt) {
        body.content = {
          ...body.content,
          activatedAt: activation.activatedAt,
          baselineCutoverSequence: activation.baselineCutoverSequence,
          baselineCutoverSha256: activation.baselineCutoverSha256,
          schedule: activation.schedule,
        }
        contentSha256 = digest(JSON.stringify(body.content))
      }
      const shape = JSON.stringify({
        cashLedgerSequenceBoundary: body.content.cashLedgerSequenceBoundary,
        cashLedgerBoundarySha256: body.content.cashLedgerBoundarySha256,
        qualificationPolicy: body.content.qualificationPolicy ?? null,
        cells: body.content.cells,
      })
      if (enrollmentShas.has(contentSha256) || enrollmentShapes.has(shape)) return false
      enrollmentShas.add(contentSha256)
      enrollmentShapes.add(shape)
      return true
    }
    if (body.kind === 'model_issue') {
      if (baselineIssues.has(body.content.baselineIssueSha256)) return false
      baselineIssues.add(body.content.baselineIssueSha256)
      return true
    }
    if (body.kind === 'model_tick') {
      if (tickSlots.has(body.content.slotAt)) return false
      tickSlots.add(body.content.slotAt)
      return true
    }
    if (body.kind === 'model_score') {
      const key = `${body.content.modelIssueContentSha256}\0${body.content.horizonHours}`
      if (scoreKeys.has(key)) return false
      scoreKeys.add(key)
      return true
    }
    fail('local_cash_model_append_kind')
  })
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function processStartIdentity(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim()
  } catch {
    return null
  }
}

function readLockOwner(lock) {
  const bytes = readFileSync(lock, 'utf8')
  let owner
  try {
    owner = JSON.parse(bytes)
  } catch {
    fail('local_cash_model_lock_corrupt')
  }
  if (
    bytes !== `${JSON.stringify(owner)}\n` ||
    !Number.isInteger(owner.pid) ||
    owner.pid < 1 ||
    typeof owner.token !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.token) ||
    !['ps', 'unverified'].includes(owner.processStartSource) ||
    typeof owner.processStartIdentity !== 'string' ||
    !owner.processStartIdentity
  )
    fail('local_cash_model_lock_corrupt')
  return owner
}

function publishLock(lock) {
  const authoritativeIdentity = processStartIdentity(process.pid)
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    processStartSource: authoritativeIdentity ? 'ps' : 'unverified',
    processStartIdentity:
      authoritativeIdentity ?? `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`,
    createdAt: new Date().toISOString(),
  }
  const candidate = `${lock}.${owner.token}.candidate`
  let fd
  try {
    fd = openSync(candidate, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(owner)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(candidate, lock)
    return owner
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(candidate)) unlinkSync(candidate)
  }
}

function recoverLegacyDirectoryLock(lock) {
  const ageMs = Date.now() - statSync(lock).mtimeMs
  let owner = null
  try {
    owner = JSON.parse(readFileSync(join(lock, LOCK_OWNER), 'utf8'))
  } catch {
    // Legacy directory locks were not atomically populated. A recent empty
    // directory may still have a writer between mkdir and owner creation.
  }
  if (owner && pidIsAlive(owner.pid)) fail('local_cash_model_lock_busy')
  if (!owner && ageMs < EMPTY_LOCK_GRACE_MS) fail('local_cash_model_lock_busy')
  const stale = `${lock}.stale-${randomUUID()}`
  renameSync(lock, stale)
  rmSync(stale, { recursive: true, force: true })
}

function acquireLock(lock) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return publishLock(lock)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stats
      try {
        stats = statSync(lock)
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue
        throw statError
      }
      if (stats.isDirectory()) {
        try {
          recoverLegacyDirectoryLock(lock)
        } catch (recoveryError) {
          if (recoveryError?.code !== 'ENOENT') throw recoveryError
        }
        continue
      }
      const owner = readLockOwner(lock)
      if (pidIsAlive(owner.pid)) {
        const identity = processStartIdentity(owner.pid)
        if (
          owner.processStartSource !== 'ps' ||
          !identity ||
          identity === owner.processStartIdentity
        )
          fail('local_cash_model_lock_busy')
      }
      const stale = `${lock}.stale-${randomUUID()}`
      try {
        renameSync(lock, stale)
        unlinkSync(stale)
        const abandonedCandidate = `${lock}.${owner.token}.candidate`
        if (existsSync(abandonedCandidate)) unlinkSync(abandonedCandidate)
      } catch (recoveryError) {
        if (recoveryError?.code !== 'ENOENT') fail('local_cash_model_lock_recovery')
      }
    }
  }
  fail('local_cash_model_lock_busy')
}

function releaseLock(lock, owner) {
  try {
    const current = readLockOwner(lock)
    if (
      current.token !== owner.token ||
      current.pid !== owner.pid ||
      current.processStartSource !== owner.processStartSource ||
      current.processStartIdentity !== owner.processStartIdentity
    )
      return
    unlinkSync(lock)
  } catch {
    // Ownership could not be proven, so leave the lock for safe stale recovery.
  }
}

function appendBodies(bodies, manifest, cashRoot, baselineRoot, root) {
  if (!bodies.length) return { status: 'already_recorded', records: [] }
  mkdirSync(dirname(root), { recursive: true })
  const lock = `${root}.lock`
  const lockOwner = acquireLock(lock)
  try {
    const verified = verifyLocalCarryCashModelLedger(manifest, cashRoot, baselineRoot, root)
    const rebasedBodies = dedupeBodies(bodies, verified)
    if (!rebasedBodies.length) return { status: 'already_recorded', records: [] }
    let sequence = verified.count
    let previousSha256 = verified.last?.sha256 ?? null
    let previousAt = verified.last?.recordedAt ?? null
    const appended = []
    for (const body of rebasedBodies) {
      utc(body.recordedAt)
      if (previousAt && utc(body.recordedAt) < utc(previousAt))
        fail('local_cash_model_append_clock_rollback')
      const contentSha256 = digest(JSON.stringify(body.content))
      const core = {
        study: LOCAL_CARRY_CASH_MODEL_STUDY,
        schemaVersion: 4,
        sequence: ++sequence,
        previousSha256,
        manifestSha256: manifest.sha256,
        kind: body.kind,
        recordedAt: body.recordedAt,
        contentSha256,
        content: body.content,
      }
      const record = { ...core, sha256: digest(JSON.stringify(core)) }
      const bytes = `${JSON.stringify(record)}\n`
      if (Buffer.byteLength(bytes) > MAX_BYTES) fail('local_cash_model_record_oversize')
      reserve(root, Buffer.byteLength(bytes))
      mkdirSync(root, { recursive: true })
      const target = join(root, filename(record.sequence))
      const temp = join(root, `.${randomUUID()}.tmp`)
      let fd
      try {
        fd = openSync(temp, 'wx', 0o600)
        writeFileSync(fd, bytes)
        fsyncSync(fd)
        closeSync(fd)
        fd = undefined
        linkSync(temp, target)
      } finally {
        if (fd !== undefined) closeSync(fd)
        if (existsSync(temp)) unlinkSync(temp)
      }
      appended.push(record)
      previousSha256 = record.sha256
      previousAt = record.recordedAt
    }
    // Replay the newly extended chain before reporting success.
    verifyLocalCarryCashModelLedger(manifest, cashRoot, baselineRoot, root)
    return { status: 'recorded', records: appended }
  } finally {
    releaseLock(lock, lockOwner)
  }
}

function historyBoundary(cash) {
  const retrospective = cash.records.filter((record) => record.collectionMode === 'retrospective')
  const boundary = retrospective.at(-1)?.sequence ?? 0
  return {
    sequence: boundary,
    sha256: boundary ? cash.records[boundary - 1].sha256 : null,
    records: cash.records.slice(0, boundary),
  }
}

export function registerLocalCashModels(
  manifest,
  cashRoot = LOCAL_CARRY_CASH_ROOT,
  baselineRoot = LOCAL_CARRY_ISSUE_ROOT,
  root = LOCAL_CARRY_CASH_MODEL_ROOT,
  now = new Date().toISOString(),
) {
  utc(now)
  const verified = verifyLocalCarryCashModelLedger(manifest, cashRoot, baselineRoot, root)
  const boundary = historyBoundary(verified.cash)
  const first = verified.enrollments[0]
  const activatedAt = first?.content.activatedAt ?? now
  const cutoverSequence = first?.content.baselineCutoverSequence ?? verified.baseline.count
  const cutoverSha256 =
    first?.content.baselineCutoverSha256 ?? verified.baseline.last?.sha256 ?? null
  const plan = buildLocalCashModelPlan(manifest, boundary.records, now)
  const missingArtifacts = plan.artifacts.filter(
    (artifact) => !verified.artifacts.has(artifact.contentSha256),
  )
  const latestEnrollment = verified.enrollments.at(-1)
  const unchangedEnrollment =
    latestEnrollment &&
    latestEnrollment.content.qualificationPolicy === UNTOUCHED_HOLDOUT_POLICY &&
    latestEnrollment.content.cashLedgerSequenceBoundary === boundary.sequence &&
    latestEnrollment.content.cashLedgerBoundarySha256 === boundary.sha256 &&
    JSON.stringify(latestEnrollment.content.cells) === JSON.stringify(plan.cells)
  const enrollment = unchangedEnrollment
    ? latestEnrollment.content
    : {
        activatedAt,
        plannedAt: now,
        cashLedgerSequenceBoundary: boundary.sequence,
        cashLedgerBoundarySha256: boundary.sha256,
        baselineCutoverSequence: cutoverSequence,
        baselineCutoverSha256: cutoverSha256,
        schedule: {
          cadence: 'utc_hour',
          intervalHours: 1,
          firstSlotAt: first?.content.schedule.firstSlotAt ?? nextHourSlot(activatedAt),
          issueDeadline: 'strictly_before_target_low',
        },
        qualificationPolicy: UNTOUCHED_HOLDOUT_POLICY,
        cells: plan.cells,
        claim: 'aggregate_cash_proxy_only',
        holderExecutableExit: false,
      }
  const enrollmentSha = digest(JSON.stringify(enrollment))
  const hasEnrollment = verified.enrollments.some(
    (record) => record.contentSha256 === enrollmentSha,
  )
  const bodies = [
    ...missingArtifacts.map((artifact) => ({
      kind: 'artifact',
      recordedAt: now,
      content: artifact.content,
    })),
    ...(hasEnrollment ? [] : [{ kind: 'enrollment', recordedAt: now, content: enrollment }]),
  ]
  const result = appendBodies(bodies, manifest, cashRoot, baselineRoot, root)
  const registeredArtifacts = result.records.filter((record) => record.kind === 'artifact').length
  const recordedEnrollments = result.records.filter((record) => record.kind === 'enrollment').length
  return {
    status: result.status,
    artifactsRegistered: registeredArtifacts,
    enrollmentRecorded: recordedEnrollments,
    enrolled: plan.cells.filter((cell) => cell.status === 'enrolled').length,
    abstained: plan.cells.filter((cell) => cell.status === 'abstained').length,
    byHorizon: [1, 24].map((horizonHours) => ({
      horizonHours,
      enrolled: plan.cells.filter(
        (cell) => cell.horizonHours === horizonHours && cell.status === 'enrolled',
      ).length,
      abstained: plan.cells.filter(
        (cell) => cell.horizonHours === horizonHours && cell.status === 'abstained',
      ).length,
    })),
  }
}

export function issueLocalCashModels(
  manifest,
  cashRoot = LOCAL_CARRY_CASH_ROOT,
  baselineRoot = LOCAL_CARRY_ISSUE_ROOT,
  root = LOCAL_CARRY_CASH_MODEL_ROOT,
  now = new Date().toISOString(),
) {
  utc(now)
  const verified = verifyLocalCarryCashModelLedger(manifest, cashRoot, baselineRoot, root)
  const enrollment = verified.enrollments.at(-1)
  if (!enrollment) return { status: 'abstained', reason: 'model_not_enrolled', processed: 0 }
  const tickBodies = buildTickBodies(enrollment, verified.baseline, verified.ticks, now)
  const ticksBySlot = new Map([
    ...verified.ticks.map((record) => [record.content.slotAt, record]),
    ...tickBodies.map((body) => [body.content.slotAt, body]),
  ])
  const modeled = new Set(verified.issues.map((record) => record.content.baselineIssueSha256))
  const allEligible = verified.baseline.records.filter(
    (record) =>
      record.kind === 'issue' &&
      record.sequence > enrollment.content.baselineCutoverSequence &&
      record.issuedAt >= enrollment.content.activatedAt &&
      record.slotAt >= enrollment.content.schedule.firstSlotAt &&
      ticksBySlot.get(record.slotAt)?.content.status === 'on_time' &&
      ticksBySlot.get(record.slotAt)?.content.enrollmentContentSha256 ===
        enrollment.contentSha256 &&
      ticksBySlot.get(record.slotAt)?.content.baselineIssueSha256 === record.sha256 &&
      !modeled.has(record.sha256),
  )
  const eligible = allEligible.slice(0, 4)
  const bodies = eligible.map((baselineIssue) => {
    const content = {
      enrollmentContentSha256: enrollment.contentSha256,
      qualificationPolicy: UNTOUCHED_HOLDOUT_POLICY,
      baselineIssueSequence: baselineIssue.sequence,
      baselineIssueSha256: baselineIssue.sha256,
      baselineIssueSlotAt: baselineIssue.slotAt,
      tickSlotAt: baselineIssue.slotAt,
      issuedAt: now,
      attempts: [],
    }
    content.attempts = plannedModelIssue(
      content,
      enrollment,
      ticksBySlot.get(baselineIssue.slotAt),
      verified.artifacts,
      verified.baseline,
      new Map(verified.cash.records.map((record) => [record.sha256, receiptView(record)])),
      true,
    )
    return { kind: 'model_issue', recordedAt: now, content }
  })
  const result = appendBodies([...tickBodies, ...bodies], manifest, cashRoot, baselineRoot, root)
  const appended = result.records.filter((record) => record.kind === 'model_issue')
  const appendedTicks = result.records.filter((record) => record.kind === 'model_tick')
  return {
    status: result.status,
    processed: appended.length,
    issued: appended.reduce(
      (total, record) =>
        total + record.content.attempts.filter((row) => row.status === 'issued').length,
      0,
    ),
    abstained: appended.reduce(
      (total, record) =>
        total + record.content.attempts.filter((row) => row.status === 'abstained').length,
      0,
    ),
    remaining: Math.max(0, allEligible.length - appended.length),
    ticksRecorded: appendedTicks.length,
    missedTicks: appendedTicks.filter((record) => record.content.status !== 'on_time').length,
  }
}

export function scoreLocalCashModels(
  manifest,
  cashRoot = LOCAL_CARRY_CASH_ROOT,
  baselineRoot = LOCAL_CARRY_ISSUE_ROOT,
  root = LOCAL_CARRY_CASH_MODEL_ROOT,
  now = new Date().toISOString(),
) {
  utc(now)
  const verified = verifyLocalCarryCashModelLedger(manifest, cashRoot, baselineRoot, root)
  const existing = new Set(
    verified.scores.map(
      (record) => `${record.content.modelIssueContentSha256}\0${record.content.horizonHours}`,
    ),
  )
  const baselineScores = verified.baseline.records.filter((record) => record.kind === 'score')
  const due = []
  for (const issue of verified.issues) {
    for (const horizonHours of [1, 24]) {
      if (existing.has(`${issue.contentSha256}\0${horizonHours}`)) continue
      if (
        !issue.content.attempts.some(
          (row) => row.horizonHours === horizonHours && row.status === 'issued',
        )
      )
        continue
      const baselineScore = baselineScores.find(
        (score) =>
          score.issueSha256 === issue.content.baselineIssueSha256 &&
          (!Object.hasOwn(score, 'horizonHours') || score.horizonHours === horizonHours),
      )
      if (baselineScore) due.push({ issue, horizonHours, baselineScore })
    }
  }
  const bodies = due.slice(0, 4).map(({ issue, horizonHours, baselineScore }) => {
    const content = {
      modelIssueContentSha256: issue.contentSha256,
      baselineScoreSequence: baselineScore.sequence,
      baselineScoreSha256: baselineScore.sha256,
      horizonHours,
      scoredAt: now,
      outcomes: [],
    }
    content.outcomes = plannedModelScore(content, issue, verified.baseline)
    return { kind: 'model_score', recordedAt: now, content }
  })
  const result = appendBodies(bodies, manifest, cashRoot, baselineRoot, root)
  const appended = result.records.filter((record) => record.kind === 'model_score')
  return {
    status: result.status,
    due: due.length,
    processed: appended.length,
    observed: appended.reduce(
      (total, record) =>
        total + record.content.outcomes.filter((row) => row.status === 'observed').length,
      0,
    ),
    censoredMissing: appended.reduce(
      (total, record) =>
        total + record.content.outcomes.filter((row) => row.status === 'censored_missing').length,
      0,
    ),
  }
}

export function evaluateLocalCarryCashModels(
  manifest,
  cashRoot = LOCAL_CARRY_CASH_ROOT,
  baselineRoot = LOCAL_CARRY_ISSUE_ROOT,
  root = LOCAL_CARRY_CASH_MODEL_ROOT,
  now = new Date().toISOString(),
) {
  utc(now)
  const verified = verifyLocalCarryCashModelLedger(manifest, cashRoot, baselineRoot, root)
  const scorecard = buildLocalCashModelScorecard(verified.records, {
    asOf: now,
    baselineRecords: verified.baseline.records,
  })
  return {
    ...scorecard,
    records: verified.count,
    artifacts: verified.artifacts.size,
    enrollments: verified.enrollments.length,
    ticks: verified.ticks.length,
    issues: verified.issues.length,
    scores: verified.scores.length,
  }
}

export function readLocalCarryCashModelEvidence(
  verified,
  question,
  now = new Date().toISOString(),
) {
  utc(now)
  if (!verified || !Array.isArray(verified.records))
    return { status: 'unavailable', reason: 'ledger_unavailable' }
  const liveScorecard = buildLocalCashModelScorecard(verified.records, {
    asOf: now,
    baselineRecords: verified.baseline?.records ?? [],
  })
  const enrollment = verified.enrollments.at(-1)
  const cell = enrollment?.content.cells.find(
    (row) =>
      row.routeKey === question.routeKey &&
      row.destination === question.destination &&
      row.horizonHours === question.horizonHours,
  )
  if (!cell)
    return { status: 'unavailable', reason: 'not_enrolled', detailReason: 'subject_not_enrolled' }
  if (cell.asset !== question.asset)
    return { status: 'unavailable', reason: 'not_enrolled', detailReason: 'identity_mismatch' }
  if (cell.status !== 'enrolled')
    return {
      status: 'unavailable',
      reason: 'not_enrolled',
      detailReason: cell.reason,
      prospective: null,
    }
  const enrolledArtifact = verified.artifacts.get(cell.artifactContentSha256)
  if (!enrolledArtifact) return { status: 'unavailable', reason: 'ledger_unavailable' }
  if (!artifactPassesUntouchedHoldout(enrolledArtifact.content))
    return {
      status: 'unavailable',
      reason: 'not_enrolled',
      detailReason: 'untouched_holdout_failed',
      prospective: null,
    }
  const ticksBySlot = new Map(
    (verified.ticks ?? []).map((record) => [record.content.slotAt, record]),
  )
  const candidates = verified.issues
    .flatMap((record) =>
      record.content.attempts
        .filter((attempt) => {
          const tick = ticksBySlot.get(record.content.tickSlotAt)
          return (
            attempt.status === 'issued' &&
            attempt.routeKey === question.routeKey &&
            attempt.destination === question.destination &&
            attempt.asset === question.asset &&
            attempt.horizonHours === question.horizonHours &&
            attempt.artifactContentSha256 === cell.artifactContentSha256 &&
            tick?.content.status === 'on_time' &&
            tick.content.enrollmentContentSha256 === record.content.enrollmentContentSha256 &&
            tick.content.baselineIssueSha256 === record.content.baselineIssueSha256
          )
        })
        .map((attempt) => ({ record, attempt })),
    )
    .sort(
      (a, b) =>
        utc(b.record.content.issuedAt) - utc(a.record.content.issuedAt) ||
        utc(b.attempt.source.blockAt) - utc(a.attempt.source.blockAt) ||
        utc(b.attempt.targetAt) - utc(a.attempt.targetAt) ||
        b.record.content.baselineIssueSequence - a.record.content.baselineIssueSequence,
    )
  const current = candidates.find(
    ({ record, attempt }) =>
      utc(record.content.issuedAt) <= utc(now) && utc(attempt.targetAt) > utc(now),
  )
  const scorecard = liveScorecard.bySubject.find(
    (row) =>
      row.routeKey === question.routeKey &&
      row.destination === question.destination &&
      row.horizonHours === question.horizonHours &&
      row.artifactContentSha256 === cell.artifactContentSha256,
  ) ?? {
    issued: 0,
    observed: 0,
    censoredMissing: 0,
    pending: 0,
    pendingImmature: 0,
    pendingOverdue: 0,
    independentObserved: 0,
    bandCovered: 0,
    coveragePassed: false,
    outcomeAvailabilityPassed: false,
    scheduleExpected: 0,
    scheduleOnTime: 0,
    scheduleIssued: 0,
    scheduleAbstained: 0,
    scheduleMissing: 0,
    scheduleFresh: false,
    latestExpectedSlotAt: null,
    lastTickSlotAt: null,
    scheduleAbstentions: {},
    scheduleCoveragePassed: false,
    pointBeatsPersistence: null,
    modelMae: { numeratorRaw: '0', denominator: 0 },
    persistenceMae: { numeratorRaw: '0', denominator: 0 },
    prospectiveValidated: false,
  }
  if (!current)
    return {
      status: 'unavailable',
      reason: 'no_current_issue',
      detailReason: candidates.length ? 'no_future_issue' : 'no_prospective_issue',
      prospective: scorecard,
    }
  const payload = enrolledArtifact.content
  return {
    status: 'historical_projection',
    claim: 'aggregate_cash_proxy_only',
    sourceKind: 'local_sha_replayed_prospective_model_v4',
    modelKind: payload.modelKind,
    prospectiveValidated: scorecard.prospectiveValidated,
    holderExecutableExit: false,
    artifact: {
      contentSha256: enrolledArtifact.contentSha256,
      modelVersion: payload.modelVersion,
    },
    projection: {
      issuedAt: current.record.content.issuedAt,
      targetAt: current.attempt.targetAt,
      sourceReceiptSha256: current.attempt.source.receiptSha256,
      sourceBlockAt: current.attempt.source.blockAt,
      pointRaw: current.attempt.forecast.pointRaw,
      bandLowRaw: current.attempt.forecast.bandLowRaw,
      bandHighRaw: current.attempt.forecast.bandHighRaw,
      assetDecimals: current.attempt.source.assetDecimals,
    },
    backtest: {
      fit: payload.counts.fit,
      calibration: payload.counts.calibration,
      selection: payload.counts.selection,
      selectionCovered:
        payload.modelKind === 'learned_delta'
          ? payload.selection.covered
          : payload.baselineBand.selectionCovered,
      selectionCoveragePassed:
        payload.modelKind === 'learned_delta'
          ? payload.selection.coveragePassed
          : payload.baselineBand.selectionCoveragePassed,
      holdout: payload.counts.holdout,
      holdoutCovered:
        payload.modelKind === 'learned_delta'
          ? payload.untouchedTest.covered
          : payload.baselineBand.untouchedTestCovered,
      holdoutCoveragePassed:
        payload.modelKind === 'learned_delta'
          ? payload.untouchedTest.coveragePassed
          : payload.baselineBand.untouchedTestCoveragePassed,
      holdoutPointBeatsPersistence:
        payload.modelKind === 'learned_delta' ? payload.untouchedTest.pointBeatsPersistence : null,
      holdoutModelMae:
        payload.modelKind === 'learned_delta' ? payload.untouchedTest.modelMae : null,
      holdoutPersistenceMae:
        payload.modelKind === 'learned_delta' ? payload.untouchedTest.persistenceMae : null,
    },
    prospective: scorecard,
  }
}
