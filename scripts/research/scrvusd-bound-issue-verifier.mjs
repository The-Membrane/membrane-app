// Durable v2 NOW-issue linkage. This verifies retained bytes and a fresh,
// committed DB readback; it does not calibrate a forecast or assert continuity.
import {
  BOUND_STUDY_V2,
  boundIssueNameV2,
  readRow,
  sourceRows,
  verifyBoundIssueV2,
} from './scrvusd-exit-forecast-issue.mjs'
import { HORIZONS_SECONDS, verifyNowSchedule } from './scrvusd-now-schedule.mjs'
import { createHash } from 'node:crypto'
import {
  createPgNowAsOfStore,
  createPgNowAttemptStore,
  createPgNowScheduleStore,
} from './scrvusd-now-schedule-db.mjs'

const SHA = /^[0-9a-f]{64}$/
const XID = /^[1-9][0-9]*$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const canonicalTime = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
const ms = (value) => {
  if (!canonicalTime(value)) throw new Error('Noncanonical DB proof time')
  return Date.parse(value)
}
const xid = (value) => {
  if (!XID.test(String(value))) throw new Error('Missing DB transaction identity')
  return String(value)
}

// All objects here are caller supplied. Keep this separately callable only as
// a fail-closed validator; the public DB path below supplies fresh reads.
export function validateBoundIssueEvidenceV2({
  issueRow,
  attemptStartRow,
  sources,
  publication,
  manifestVisibility,
  run,
  sourceStart,
  runVisibility,
  nowUtc,
}) {
  const issue = issueRow?.issue
  const binding = issue?.scheduleBinding
  if (
    issue?.study !== BOUND_STUDY_V2 ||
    issue?.scheduledCoverageStatus !== 'unconfirmed' ||
    issue?.futureForecast?.status !== 'unavailable' ||
    issue?.futureForecast?.probability !== null ||
    issue?.futureForecast?.likelyDurationSeconds !== null ||
    !canonicalTime(nowUtc) ||
    !SHA.test(binding?.manifestSha256 ?? '') ||
    !SHA.test(binding?.slotId ?? '') ||
    issueRow.filename !== boundIssueNameV2(issue) ||
    ms(issue.issuedAtUtc) > ms(nowUtc)
  )
    throw new Error('Bound issue is not a retained unconfirmed v2 receipt')

  const manifest = verifyNowSchedule(publication?.manifest)
  const slot = manifest.slots.find((candidate) => candidate.slotId === binding.slotId)
  if (
    publication?.manifestSha256 !== manifest.sha256 ||
    publication?.prospectiveScheduleConfirmed !== true ||
    publication?.evidenceClass !== 'db_confirmed_manifest_only' ||
    manifest.sha256 !== binding.manifestSha256 ||
    !slot ||
    ms(publication.confirmedAtUtc) > ms(manifest.startAtUtc) - 2 * 3600_000 ||
    ms(publication.confirmedAtUtc) >= ms(slot.scheduledAtUtc)
  )
    throw new Error('Fresh DB publication proof does not bind issue slot')
  if (!manifestVisibility?.manifest)
    throw new Error('Committed exact manifest visibility witness missing or mismatched')
  const witnessedManifest = verifyNowSchedule(manifestVisibility?.manifest)
  if (
    manifestVisibility?.manifestSha256 !== manifest.sha256 ||
    witnessedManifest.sha256 !== manifest.sha256 ||
    JSON.stringify(witnessedManifest) !== JSON.stringify(manifest) ||
    manifestVisibility?.persistedAtUtc !== publication.persistedAtUtc ||
    manifestVisibility?.confirmedAtUtc !== publication.confirmedAtUtc ||
    manifestVisibility?.publisherXid !== publication.publisherXid ||
    manifestVisibility?.confirmerXid !== publication.confirmerXid ||
    manifestVisibility?.evidenceClass !== 'db_witnessed_manifest' ||
    manifestVisibility?.historicalPublicationAvailabilityCertified !== true ||
    manifestVisibility?.prospectiveScheduleConfirmed !== true ||
    ms(manifestVisibility.manifestVisibleAtUtc) < ms(publication.confirmedAtUtc) ||
    ms(manifestVisibility.manifestVisibleAtUtc) > ms(manifest.startAtUtc) - 2 * 3600_000 ||
    ms(manifestVisibility.manifestVisibleAtUtc) > ms(nowUtc)
  )
    throw new Error('Committed exact manifest visibility witness missing or mismatched')

  verifyBoundIssueV2(issue, {
    ...sources,
    manifest,
    publicationProof: publication,
    slotId: slot.slotId,
    attemptStartRow,
  })
  if (
    binding.attemptStart?.filename !== attemptStartRow.filename ||
    binding.attemptStart?.logicalSha256 !== attemptStartRow.issue.sha256 ||
    binding.attemptStart?.physicalSha256 !== attemptStartRow.physicalSha256
  )
    throw new Error('Retained attempt-start bytes are not issue bound')

  if (
    run?.manifestSha256 !== manifest.sha256 ||
    run?.slotId !== slot.slotId ||
    run?.runCoverageConfirmed !== true ||
    !Array.isArray(run.arms) ||
    run.arms.length !== HORIZONS_SECONDS.length
  )
    throw new Error('Committed four-arm run proof missing')
  const slotOpen = ms(slot.scheduledAtUtc)
  const slotClose = ms(slot.closesAtUtc)
  const startConfirmed = ms(run.startConfirmedAtUtc)
  const captureFloor = ms(run.sourceCaptureFloorUtc)
  const runConfirmed = ms(run.runConfirmedAtUtc)
  if (
    sourceStart?.manifestSha256 !== manifest.sha256 ||
    sourceStart?.slotId !== slot.slotId ||
    sourceStart?.captureFloorAtUtc !== run.sourceCaptureFloorUtc ||
    sourceStart?.captureFloorXid !== run.captureFloorXid ||
    sourceStart?.sourceCollectionIndependentlyTimed !== false ||
    !SHA.test(sourceStart?.nonceSha256 ?? '') ||
    runVisibility?.manifestSha256 !== manifest.sha256 ||
    runVisibility?.slotId !== slot.slotId ||
    runVisibility?.nonceSha256 !== sourceStart.nonceSha256 ||
    runVisibility?.sourceStartAtUtc !== sourceStart.sourceStartAtUtc ||
    runVisibility?.sourceStartXid !== sourceStart.sourceStartXid ||
    runVisibility?.runConfirmerXid !== run.runConfirmerXid ||
    runVisibility?.historicalAvailabilityCertifiedForRun !== true
  )
    throw new Error('Committed source-start or run-visibility witness missing or mismatched')
  const sourceStarted = ms(sourceStart.sourceStartAtUtc)
  const runVisible = ms(runVisibility.runVisibleAtUtc)
  const txs = [
    xid(publication.publisherXid),
    xid(publication.confirmerXid),
    xid(manifestVisibility.witnessXid),
    xid(run.startConfirmerXid),
    xid(run.captureFloorXid),
    xid(run.runConfirmerXid),
    xid(sourceStart.sourceStartXid),
    xid(runVisibility.witnessXid),
  ]
  if (
    startConfirmed < slotOpen ||
    startConfirmed >= slotClose ||
    captureFloor < startConfirmed ||
    captureFloor >= slotClose ||
    sourceStarted < captureFloor ||
    sourceStarted >= slotClose ||
    runConfirmed < captureFloor ||
    runConfirmed >= slotClose ||
    runVisible < runConfirmed ||
    runVisible < sourceStarted ||
    runVisible > ms(nowUtc)
  )
    throw new Error('DB start, visibility, or run confirmation missed slot')

  const seen = new Set()
  let selected = null
  let earliestIssuedTarget = Infinity
  for (const arm of run.arms) {
    if (
      !HORIZONS_SECONDS.includes(arm?.horizonSeconds) ||
      seen.has(arm.horizonSeconds) ||
      !['db_reported_issued_unverified', 'abstained', 'failed', 'unknown'].includes(arm.status)
    )
      throw new Error('DB run has missing, duplicate, or alien arm')
    seen.add(arm.horizonSeconds)
    const started = ms(arm.startedAtUtc)
    const result = ms(arm.resultAtUtc)
    txs.push(xid(arm.startXid), xid(arm.resultXid))
    if (
      started < slotOpen ||
      started >= slotClose ||
      started > startConfirmed ||
      result < sourceStarted ||
      result > runConfirmed ||
      !SHA.test(arm.startLogicalSha256 ?? '') ||
      !SHA.test(arm.startPhysicalSha256 ?? '') ||
      typeof arm.startPayload !== 'string'
    )
      throw new Error('DB arm commit sequence or exact start payload missing')
    const reportedStart = JSON.parse(arm.startPayload)
    const { sha256: _startSeal, ...unsignedStart } = reportedStart
    if (
      arm.startPayload !== JSON.stringify(reportedStart) ||
      reportedStart.sha256 !== arm.startLogicalSha256 ||
      sha(JSON.stringify(unsignedStart)) !== arm.startLogicalSha256 ||
      sha(`${arm.startPayload}\n`) !== arm.startPhysicalSha256 ||
      reportedStart.manifestSha256 !== manifest.sha256 ||
      reportedStart.slotId !== slot.slotId ||
      reportedStart.horizonSeconds !== arm.horizonSeconds
    )
      throw new Error('DB arm start payload differs from its seal')
    if (arm.status === 'db_reported_issued_unverified') {
      if (
        !SHA.test(arm.issueLogicalSha256 ?? '') ||
        !SHA.test(arm.issuePhysicalSha256 ?? '') ||
        typeof arm.issuePayload !== 'string' ||
        sha(`${arm.issuePayload}\n`) !== arm.issuePhysicalSha256
      )
        throw new Error('DB issued arm lacks exact payload bytes')
      const reported = JSON.parse(arm.issuePayload)
      const { sha256: _issueSeal, ...unsignedIssue } = reported
      if (
        arm.issuePayload !== JSON.stringify(reported) ||
        reported.sha256 !== arm.issueLogicalSha256 ||
        sha(JSON.stringify(unsignedIssue)) !== arm.issueLogicalSha256 ||
        reported.horizonSeconds !== arm.horizonSeconds ||
        !canonicalTime(reported.issuedAtUtc)
      )
        throw new Error('DB issued arm payload differs from its horizon')
      earliestIssuedTarget = Math.min(
        earliestIssuedTarget,
        ms(reported.issuedAtUtc) + arm.horizonSeconds * 1000,
      )
    }
    if (arm.horizonSeconds === issue.horizonSeconds) selected = arm
  }
  if (txs.length !== new Set(txs).size)
    throw new Error('DB publication, start, result, and confirmation transactions overlap')
  if (
    !selected ||
    selected.status !== 'db_reported_issued_unverified' ||
    selected.startLogicalSha256 !== attemptStartRow.issue.sha256 ||
    selected.startPhysicalSha256 !== attemptStartRow.physicalSha256 ||
    selected.startPayload !== JSON.stringify(attemptStartRow.issue) ||
    selected.issueLogicalSha256 !== issue.sha256 ||
    selected.issuePhysicalSha256 !== issueRow.physicalSha256 ||
    selected.issuePayload !== JSON.stringify(issue) ||
    ms(selected.startedAtUtc) < ms(attemptStartRow.issue.recordedAtUtc) - 60_000 ||
    ms(selected.startedAtUtc) > ms(attemptStartRow.issue.recordedAtUtc) + 60_000 ||
    ms(issue.issuedAtUtc) > ms(selected.resultAtUtc) ||
    runConfirmed >= earliestIssuedTarget ||
    runVisible >= earliestIssuedTarget
  )
    throw new Error('DB issued arm does not bind exact retained v2 issue')
  const captures = [
    sources?.latestCheckpoint?.checkpoint?.captureStartUtc,
    sources?.holderRow?.issue?.captureStartUtc,
    ...(sources?.attestationRow ? [sources.attestationRow.issue.captureStartUtc] : []),
  ]
  if (
    captures.some((value) => ms(value) < sourceStarted) ||
    ms(sources?.durationRow?.issue?.issuedAtUtc) < sourceStarted ||
    (sources?.flowRow && ms(sources.flowRow.issue.issuedAtUtc) < sourceStarted)
  )
    throw new Error('Source capture began before committed DB source start')

  return {
    issueSha256: issue.sha256,
    manifestSha256: manifest.sha256,
    slotId: slot.slotId,
    horizonSeconds: issue.horizonSeconds,
    scheduledCoverageStatus: 'verified_against_supplied_db_rows',
    captureChronology: 'self_reported_timestamps_consistent_with_db_source_start',
    sourceCollectionIndependentlyTimed: false,
    caveat:
      'Local source captureStartUtc values are self-reported; matching the DB source-start receipt does not independently prove post-start collection.',
    forecastEligible: false,
    probability: null,
    likelyDurationSeconds: null,
  }
}

export async function verifyBoundIssueFromStoresV2({
  issueOut,
  issueFilename,
  attemptStartOut,
  roots = {},
  scheduleStore,
  attemptStore,
  asOfStore,
  now = () => new Date(),
}) {
  if (
    typeof scheduleStore?.readConfirmed !== 'function' ||
    typeof scheduleStore?.readManifestWitness !== 'function' ||
    typeof attemptStore?.readRun !== 'function' ||
    typeof asOfStore?.readSourceStart !== 'function' ||
    typeof asOfStore?.readRunWitness !== 'function'
  )
    throw new Error('Fresh committed schedule, attempt, and as-of stores required')
  const issueRow = readRow(issueOut, issueFilename)
  const binding = issueRow.issue.scheduleBinding
  if (!binding || issueFilename !== boundIssueNameV2(issueRow.issue))
    throw new Error('Retained issue filename or binding mismatch')
  const attemptStartRow = readRow(attemptStartOut, binding.attemptStart.filename)
  const publication = await scheduleStore.readConfirmed(binding.manifestSha256)
  const manifestVisibility = await scheduleStore.readManifestWitness(binding.manifestSha256)
  const run = await attemptStore.readRun({
    manifestSha256: binding.manifestSha256,
    slotId: binding.slotId,
  })
  const sourceStart = await asOfStore.readSourceStart({
    manifestSha256: binding.manifestSha256,
    slotId: binding.slotId,
  })
  const runVisibility = await asOfStore.readRunWitness({
    manifestSha256: binding.manifestSha256,
    slotId: binding.slotId,
  })
  const sources = sourceRows({
    ...roots,
    now,
    atBlock: issueRow.issue.anchorBlock.number,
    issuedAtUtc: issueRow.issue.issuedAtUtc,
  })
  if (!sources) throw new Error('Retained v2 source rows unavailable')
  const result = validateBoundIssueEvidenceV2({
    issueRow,
    attemptStartRow,
    sources,
    publication,
    manifestVisibility,
    run,
    sourceStart,
    runVisibility,
    nowUtc: now().toISOString(),
  })
  // Supplied stores are substitutable and cannot authenticate the database.
  return result
}

// The trust boundary is the caller-provisioned PostgreSQL pool. Constructing
// all audited adapters here prevents caller-supplied store doubles from
// receiving the DB-linkage label through the public production path.
export async function verifyBoundIssueWithPgV2({ pool, ...options }) {
  const scheduleStore = createPgNowScheduleStore(pool)
  const attemptStore = createPgNowAttemptStore(pool)
  const asOfStore = createPgNowAsOfStore(pool)
  const result = await verifyBoundIssueFromStoresV2({
    ...options,
    scheduleStore,
    attemptStore,
    asOfStore,
  })
  return {
    ...result,
    scheduledCoverageStatus: 'db_linkage_verified_source_timing_self_reported',
  }
}
