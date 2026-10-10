// Prospective NOW-origin scrvUSD exit research receipt. No user alert or calibrated forecast.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT as DURATION_OUT,
  STUDY_V2 as DURATION_STUDY,
  MAX_ISSUE_LAG_SECONDS,
  readSources,
  verify as verifyDuration,
} from './scrvusd-holder-duration.mjs'
import { OUT as FLOW_OUT, verify as verifyFlow } from './scrvusd-holder-flow-context.mjs'
import { RESERVE_BYTES } from './scrvusd-fixed-holder-exit.mjs'
import {
  OUT as ATTESTATION_OUT,
  readVerifiedAtCheckpoint,
  validateAttestation,
} from './scrvusd-target-code-attestation.mjs'
import { sourceIdentity } from './curve-prospective-quote.mjs'
import {
  HOLDER as SCHEDULE_HOLDER,
  HORIZONS_SECONDS as SCHEDULE_HORIZONS,
  Q_ASSETS_RAW as SCHEDULE_Q,
  ROUTE as SCHEDULE_ROUTE,
  verifyNowSchedule,
} from './scrvusd-now-schedule.mjs'

export const STUDY = 'scrvusd-now-origin-exit-forecast-issue-v1'
export const BOUND_STUDY_V2 = 'scrvusd-now-origin-exit-forecast-issue-v2'
export const ATTEMPT_START_STUDY = 'scrvusd-now-origin-attempt-start-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-exit-forecast-issues')
export const MAX_HORIZON_SECONDS = 31_536_000
export const MAX_BLOCK_TO_ISSUE_SECONDS = 3600
export const OUTCOME_PROTOCOL_VERSION = 'scrvusd-now-origin-exit-outcome-v2'
export const OUTCOME_TARGET_WINDOW_SECONDS = 1800
export const OUTCOME_MAX_ADJACENT_GAP_SECONDS = 7200
export const OUTCOME_CAPTURE_GRACE_SECONDS = 3600
export const OUTCOME_MIN_RESOLVABLE_HORIZON_SECONDS = 3600
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _sha256, ...payload }) => payload
const nameFor = (block, horizonSeconds) =>
  `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}-${horizonSeconds}s.json`
const ref = (filename, value, physicalSha256) => ({
  filename,
  logicalSha256: value.sha256,
  physicalSha256,
})
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const hash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const canonicalTime = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value

function exactRow(row, expectedRef, label) {
  const value = row?.issue ?? row?.checkpoint
  if (
    !row ||
    typeof row.filename !== 'string' ||
    !value ||
    !hash(value.sha256) ||
    value.sha256 !== sha(JSON.stringify(unsigned(value))) ||
    !hash(row.physicalSha256) ||
    row.physicalSha256 !== sha(`${JSON.stringify(value)}\n`) ||
    (expectedRef &&
      (row.filename !== expectedRef.filename ||
        value.sha256 !== expectedRef.logicalSha256 ||
        row.physicalSha256 !== expectedRef.physicalSha256))
  )
    throw new Error(`${label} exact logical/physical source mismatch`)
  return ref(row.filename, value, row.physicalSha256)
}

export function outcomeProtocol(issuedAtUtc, horizonSeconds) {
  const targetMs = Date.parse(issuedAtUtc) + horizonSeconds * 1000
  return {
    version: OUTCOME_PROTOCOL_VERSION,
    origin: 'issue_time',
    targetUtc: new Date(targetMs).toISOString(),
    checkpointSelection: {
      source: 'verified_quote_checkpoint',
      distance: 'absolute_block_timestamp_to_target',
      windowSeconds: OUTCOME_TARGET_WINDOW_SECONDS,
      tieBreak: ['earlier_block_number', 'lexicographically_smaller_block_hash'],
      requireBlockTimestampStrictlyAfterIssueUtc: true,
      requireCaptureEndUtcByDeadline: true,
      captureDeadlineUtc: new Date(
        targetMs + (OUTCOME_TARGET_WINDOW_SECONDS + OUTCOME_CAPTURE_GRACE_SECONDS) * 1000,
      ).toISOString(),
    },
    holderProbe: {
      source: 'verified_fixed_holder_issue_at_selected_checkpoint',
      requireExactBlockNumberAndHash: true,
      requireSameHolderQAssetsAndDirectWithdrawRoute: true,
      requireCaptureEndUtcByDeadline: true,
      inspectStatuses: ['success', 'revert', 'provider_error', 'missing'],
      missingIsNotSuccess: true,
    },
    comparability: {
      status: 'unverified',
      maxAdjacentVerifiedQuoteGapSeconds: OUTCOME_MAX_ADJACENT_GAP_SECONDS,
      captureCodeAndImplementationIdentity: 'optional_separate_same_block_attestation',
      codeAndImplementationIdentityVerified: false,
      codeIdentityRule: {
        version: 'scrvusd-eip1167-sampled-code-comparability-v1',
        anchor: 'issue_bound_same_block_attestation_if_available_by_issue_time',
        sampleSet: 'selected_target_and_intervening_sampled_quote_checkpoints',
        source: 'verified_attestation_at_each_exact_sampled_block_and_hash',
        requireCaptureEndUtcByScoreDeadline: true,
        captureDeadlineUtc: new Date(
          targetMs + (OUTCOME_TARGET_WINDOW_SECONDS + OUTCOME_CAPTURE_GRACE_SECONDS) * 1000,
        ).toISOString(),
        compareFields: ['vaultCodeHash', 'target', 'targetCodeHash'],
        absentAnchor: 'unknown',
        missingOrLateSample: 'unknown',
        anyFieldMismatch: 'changed',
        allSampledFieldsMatch: 'sampled_match_only',
        pointOutcomeUnaffectedByCodeStatus: true,
        causalAttribution: 'unavailable',
        continuousExitAvailability: 'unavailable',
      },
      causalAttribution: 'unavailable',
      continuousExitAvailability: 'unavailable',
    },
    horizonResolution:
      horizonSeconds < OUTCOME_MIN_RESOLVABLE_HORIZON_SECONDS
        ? 'below_one_hour_sampling_resolution'
        : 'eligible_for_discrete_sample_only',
    scoringRule:
      'Classify the selected exact-block probe and intervening comparable samples separately; an absent or late sample is missing, and success at a later block cannot prove uninterrupted availability.',
  }
}

function cleanCurrent(holder, duration) {
  const result = holder.issue.result
  return (
    holder.issue.checkpoint.block.number === duration.block.number &&
    holder.issue.checkpoint.block.hash === duration.block.hash &&
    holder.issue.holder === duration.holder &&
    holder.issue.rawCrvUsd === duration.rawCrvUsd &&
    result.status === 'success' &&
    result.maxWithdrawAssetsRaw !== null &&
    result.balanceSharesRaw !== null &&
    result.previewSharesRaw !== null &&
    BigInt(result.maxWithdrawAssetsRaw) >= BigInt(duration.rawCrvUsd) &&
    BigInt(result.balanceSharesRaw) >= BigInt(result.previewSharesRaw)
  )
}

// Source rows must first pass the existing ledger verifiers. Rebuild on every read;
// the physical hashes bind the exact bytes that were available at issue time.
export function buildIssue({
  durationRow,
  holderRow,
  flowRow = null,
  attestationRow = null,
  horizonSeconds,
  issuedAtUtc,
  latestCheckpoint = null,
}) {
  const duration = durationRow?.issue
  const holder = holderRow?.issue
  const flow = flowRow?.issue
  const issuedMs = Date.parse(issuedAtUtc)
  const captureMs = Date.parse(holder?.captureEndUtc)
  const durationMs = Date.parse(duration?.issuedAtUtc)
  const blockMs = duration?.block?.timestamp * 1000
  if (
    duration?.study !== DURATION_STUDY ||
    duration?.kind !== 'prospective-holder-first-loss-baseline' ||
    !Number.isSafeInteger(horizonSeconds) ||
    horizonSeconds < 1 ||
    horizonSeconds > MAX_HORIZON_SECONDS ||
    !validTime(issuedAtUtc) ||
    !validTime(holder?.captureEndUtc) ||
    !validTime(duration?.issuedAtUtc) ||
    !Number.isSafeInteger(blockMs) ||
    captureMs < blockMs ||
    issuedMs < captureMs ||
    issuedMs < durationMs ||
    issuedMs - captureMs > MAX_ISSUE_LAG_SECONDS * 1000 ||
    issuedMs - blockMs > MAX_BLOCK_TO_ISSUE_SECONDS * 1000 ||
    holder?.sha256 !== duration.holderIssue?.logicalSha256 ||
    holderRow.filename !== duration.holderIssue.filename ||
    holderRow.physicalSha256 !== duration.holderIssue.physicalSha256 ||
    !cleanCurrent(holderRow, duration) ||
    !hash(durationRow.physicalSha256) ||
    !hash(holderRow.physicalSha256) ||
    duration.baseline?.status !== 'uncalibrated' ||
    duration.baseline?.holderCount !== 1 ||
    duration.baseline?.vaultCount !== 1 ||
    !latestCheckpoint ||
    latestCheckpoint.checkpoint.block.number !== duration.block.number ||
    latestCheckpoint.checkpoint.block.hash !== duration.block.hash ||
    Date.parse(latestCheckpoint.checkpoint.captureEndUtc) > issuedMs
  )
    throw new Error('Ineligible or stale NOW-origin holder exit anchor')

  if (
    flowRow !== null &&
    (flow?.study !== 'scrvusd-holder-duration-flow-context-v2' ||
      flow.block?.number !== duration.block.number ||
      flow.block?.hash !== duration.block.hash ||
      flow.durationIssue?.logicalSha256 !== duration.sha256 ||
      flow.durationIssue?.physicalSha256 !== durationRow.physicalSha256 ||
      flow.durationIssue?.filename !== durationRow.filename ||
      !validTime(flow.issuedAtUtc) ||
      Date.parse(flow.issuedAtUtc) > issuedMs ||
      flow.historicalSuffix?.evidenceCutoffUtc !== duration.issuedAtUtc ||
      !hash(flowRow.physicalSha256))
  )
    throw new Error('Flow context is not same-anchor or available as of issue')

  const attestation = attestationRow?.issue
  if (attestationRow !== null) {
    if (
      !hash(attestationRow.physicalSha256) ||
      attestationRow.physicalSha256 !== sha(`${JSON.stringify(attestation)}\n`) ||
      attestationRow.filename !==
        `${String(duration.block.number).padStart(12, '0')}-${duration.block.hash.slice(2)}.json` ||
      Date.parse(attestation?.captureEndUtc) > issuedMs
    )
      throw new Error('Attestation is not canonical or available as of issue')
    validateAttestation(attestation, {
      identity: sourceIdentity(),
      checkpoints: [latestCheckpoint],
      nowUtc: issuedAtUtc,
    })
  }

  return seal({
    study: STUDY,
    kind: 'prospective-now-origin-holder-exit-forecast-issue',
    issuedAtUtc,
    targetUtc: new Date(issuedMs + horizonSeconds * 1000).toISOString(),
    horizonSeconds,
    horizonOrigin: 'issue_time',
    outcomeProtocol: outcomeProtocol(issuedAtUtc, horizonSeconds),
    route: 'direct_erc4626_withdraw_crvusd_from_scrvusd',
    holder: duration.holder,
    qAssetsRaw: duration.rawCrvUsd,
    anchorBlock: duration.block,
    source: {
      durationIssue: ref(durationRow.filename, duration, durationRow.physicalSha256),
      holderProbe: ref(holderRow.filename, holder, holderRow.physicalSha256),
      quoteCheckpoint: duration.quote,
      flowContext: flowRow ? ref(flowRow.filename, flow, flowRow.physicalSha256) : null,
      targetCodeAttestation: attestationRow
        ? ref(attestationRow.filename, attestation, attestationRow.physicalSha256)
        : null,
    },
    currentExecutableAbility: {
      status: 'sampled_success',
      block: duration.block,
      capturedAtUtc: holder.captureEndUtc,
      blockAgeSecondsAtIssue: (issuedMs - blockMs) / 1000,
      captureAgeSecondsAtIssue: (issuedMs - captureMs) / 1000,
      maxWithdrawAssetsRaw: holder.result.maxWithdrawAssetsRaw,
      previewSharesRaw: holder.result.previewSharesRaw,
      balanceSharesRaw: holder.result.balanceSharesRaw,
      caveat: 'Read-only same-block eth_call success; no transaction or continuity guarantee.',
    },
    currentMechanismContext: attestationRow
      ? {
          status: 'same_block_target_code_attested',
          vaultCodeHash: attestation.vaultCodeHash,
          embeddedTarget: attestation.target,
          embeddedTargetCodeHash: attestation.targetCodeHash,
          crossTimeComparability: 'unverified',
          caveat:
            'One same-block code identity does not attest future code, strategy state, or uninterrupted exit ability.',
        }
      : {
          status: 'unverified',
          vaultCodeHash: null,
          embeddedTarget: null,
          embeddedTargetCodeHash: null,
          crossTimeComparability: 'unverified',
          caveat: 'No same-block target-code attestation was available by issue time.',
        },
    historicalContext: {
      sampledRiskSet: duration.baseline,
      flow: flowRow ? flow.historicalSuffix : null,
      flowStatus: flowRow ? 'as_of_context' : 'unavailable',
      caveat:
        'Gross and net vault events are descriptive stress context, not executable capacity, runway, or a protocol maximum.',
    },
    futureForecast: {
      status: 'unavailable',
      reason: 'insufficient_independent_same_holder_size_route_outcomes_and_calibration',
      horizonSeconds,
      probability: null,
      likelyDurationSeconds: null,
      caveat:
        'The sampled risk set is one dependent holder/vault series. No future exit ability or remaining-life estimate is inferred.',
    },
  })
}

export function verifyIssue(saved, inputs) {
  if (!saved || saved.sha256 !== sha(JSON.stringify(unsigned(saved))))
    throw new Error('Forecast issue logical seal mismatch')
  const expected = buildIssue({
    ...inputs,
    horizonSeconds: saved.horizonSeconds,
    issuedAtUtc: saved.issuedAtUtc,
  })
  if (JSON.stringify(saved) !== JSON.stringify(expected))
    throw new Error('Forecast issue as-of replay mismatch')
  return saved
}

// A local start receipt is useful for replay, but its timestamp is not a DB
// clock or proof that an hourly invocation occurred. The future DB adapter must
// bind both hashes to a server-timed start/result pair before cohort admission.
export function buildAttemptStartV1({ manifest, slotId, horizonSeconds, recordedAtUtc }) {
  const schedule = verifyNowSchedule(manifest)
  const slot = schedule.slots.find((candidate) => candidate.slotId === slotId)
  if (
    !slot ||
    !SCHEDULE_HORIZONS.includes(horizonSeconds) ||
    !canonicalTime(recordedAtUtc) ||
    Date.parse(recordedAtUtc) < Date.parse(slot.scheduledAtUtc) ||
    Date.parse(recordedAtUtc) >= Date.parse(slot.closesAtUtc)
  )
    throw new Error('Attempt start lacks an exact arm or is outside its half-open slot')
  return seal({
    study: ATTEMPT_START_STUDY,
    kind: 'scheduled-arm-start',
    manifestSha256: schedule.sha256,
    slotId,
    horizonSeconds,
    holder: SCHEDULE_HOLDER,
    qAssetsRaw: SCHEDULE_Q,
    route: SCHEDULE_ROUTE,
    recordedAtUtc,
    evidenceClass: 'local_research_only',
  })
}

export function attemptStartNameV1(start) {
  if (!hash(start?.sha256)) throw new Error('Full attempt-start SHA required')
  return `${start.slotId}-${start.horizonSeconds}s-${start.sha256}.json`
}

export function boundIssueNameV2(issue) {
  const startSha = issue?.scheduleBinding?.attemptStart?.logicalSha256
  if (!hash(startSha) || !hash(issue?.sha256))
    throw new Error('Full attempt-start and issue SHAs required for bound issue')
  return `${String(issue.anchorBlock.number).padStart(12, '0')}-${issue.anchorBlock.hash.slice(2)}-${issue.horizonSeconds}s-${startSha}-${issue.sha256}.json`
}

// This validates the shape and temporal ordering of a claimed DB readback. A
// caller can manufacture this object, so the pure receipt stays UNCONFIRMED.
// Only a restricted DB adapter with a fresh exact readback may authenticate it.
function checkedPublicationProof(schedule, proof) {
  const readbackManifest = proof?.manifest
  if (
    !readbackManifest ||
    JSON.stringify(verifyNowSchedule(readbackManifest)) !== JSON.stringify(schedule)
  )
    throw new Error('Claimed DB manifest readback differs from bound schedule')
  if (
    !proof ||
    (proof.manifestSha256 ?? readbackManifest?.sha256) !== schedule.sha256 ||
    !canonicalTime(proof.persistedAtUtc) ||
    !canonicalTime(proof.confirmedAtUtc) ||
    !/^[1-9][0-9]*$/.test(String(proof.publisherXid)) ||
    !/^[1-9][0-9]*$/.test(String(proof.confirmerXid)) ||
    String(proof.publisherXid) === String(proof.confirmerXid) ||
    Date.parse(proof.persistedAtUtc) < Date.parse(schedule.plannedAtUtc) ||
    Date.parse(proof.confirmedAtUtc) < Date.parse(proof.persistedAtUtc) ||
    Date.parse(proof.confirmedAtUtc) > Date.parse(schedule.startAtUtc) - 2 * 3600_000
  )
    throw new Error('Missing or invalid claimed pre-slot post-commit manifest proof')
  return {
    manifestSha256: schedule.sha256,
    persistedAtUtc: proof.persistedAtUtc,
    confirmedAtUtc: proof.confirmedAtUtc,
    publisherXid: String(proof.publisherXid),
    confirmerXid: String(proof.confirmerXid),
  }
}

export function buildBoundIssueV2({
  manifest,
  publicationProof,
  slotId,
  attemptStartRow,
  ...issueInputs
}) {
  const schedule = verifyNowSchedule(manifest)
  const slot = schedule.slots.find((candidate) => candidate.slotId === slotId)
  const proof = checkedPublicationProof(schedule, publicationProof)
  const startRef = exactRow(attemptStartRow, null, 'Attempt start')
  const start = attemptStartRow.issue
  if (
    !slot ||
    attemptStartRow.filename !== attemptStartNameV1(start) ||
    start.study !== ATTEMPT_START_STUDY ||
    JSON.stringify(start) !==
      JSON.stringify(
        buildAttemptStartV1({
          manifest: schedule,
          slotId,
          horizonSeconds: issueInputs.horizonSeconds,
          recordedAtUtc: start.recordedAtUtc,
        }),
      )
  )
    throw new Error('Attempt start is not the exact canonical schedule arm')
  const started = Date.parse(start.recordedAtUtc)
  const issued = Date.parse(issueInputs.issuedAtUtc)
  if (
    !canonicalTime(issueInputs.issuedAtUtc) ||
    started > issued ||
    issued >= Date.parse(slot.closesAtUtc) ||
    Date.parse(proof.confirmedAtUtc) >= Date.parse(slot.scheduledAtUtc)
  )
    throw new Error('Bound issue is outside its scheduled source chronology')

  // Check exact bytes of every supplied source before inheriting the v1 as-of
  // checks. v1 remains byte-for-byte unchanged for its existing receipts.
  const durationRef = exactRow(issueInputs.durationRow, null, 'Duration')
  exactRow(issueInputs.holderRow, issueInputs.durationRow.issue.holderIssue, 'Holder')
  exactRow(issueInputs.latestCheckpoint, issueInputs.durationRow.issue.quote, 'Quote checkpoint')
  if (issueInputs.flowRow) exactRow(issueInputs.flowRow, null, 'Flow context')
  if (issueInputs.attestationRow)
    exactRow(issueInputs.attestationRow, null, 'Target-code attestation')
  if (
    issueInputs.durationRow.issue.holder !== SCHEDULE_HOLDER ||
    issueInputs.durationRow.issue.rawCrvUsd !== SCHEDULE_Q ||
    !canonicalTime(issueInputs.latestCheckpoint.checkpoint.captureStartUtc) ||
    Date.parse(issueInputs.latestCheckpoint.checkpoint.captureStartUtc) < started ||
    Date.parse(issueInputs.latestCheckpoint.checkpoint.captureEndUtc) < started ||
    !canonicalTime(issueInputs.holderRow.issue.captureStartUtc) ||
    Date.parse(issueInputs.holderRow.issue.captureStartUtc) < started ||
    Date.parse(issueInputs.holderRow.issue.captureEndUtc) < started ||
    Date.parse(issueInputs.durationRow.issue.issuedAtUtc) < started ||
    (issueInputs.flowRow && Date.parse(issueInputs.flowRow.issue.issuedAtUtc) < started) ||
    (issueInputs.attestationRow &&
      (!canonicalTime(issueInputs.attestationRow.issue.captureStartUtc) ||
        Date.parse(issueInputs.attestationRow.issue.captureStartUtc) < started ||
        Date.parse(issueInputs.attestationRow.issue.captureEndUtc) < started))
  )
    throw new Error('Bound issue source was not collected in its scheduled attempt')
  const v1 = buildIssue(issueInputs)
  if (v1.holder !== SCHEDULE_HOLDER || v1.qAssetsRaw !== SCHEDULE_Q || v1.route !== SCHEDULE_ROUTE)
    throw new Error('Bound issue scope differs from fixed manifest scope')
  return seal({
    ...unsigned(v1),
    study: BOUND_STUDY_V2,
    evidenceClass: 'local_research_only',
    scheduledCoverageStatus: 'unconfirmed',
    scheduleBinding: {
      manifestSha256: schedule.sha256,
      slotId,
      horizonSeconds: issueInputs.horizonSeconds,
      attemptStart: startRef,
      durationIssue: durationRef,
      claimedPublicationProof: proof,
      confirmationStatus: 'unconfirmed',
      evidenceClass: 'local_research_only',
      caveat:
        'A pure caller-supplied DB-shaped proof and local start receipt do not prove independent pre-slot publication or server-timed attempt coverage.',
    },
  })
}

export function verifyBoundIssueV2(saved, inputs) {
  if (saved?.study !== BOUND_STUDY_V2 || saved.sha256 !== sha(JSON.stringify(unsigned(saved))))
    throw new Error('Bound forecast issue logical seal mismatch')
  const expected = buildBoundIssueV2({
    ...inputs,
    horizonSeconds: saved.horizonSeconds,
    issuedAtUtc: saved.issuedAtUtc,
  })
  if (JSON.stringify(saved) !== JSON.stringify(expected))
    throw new Error('Bound forecast issue exact as-of replay mismatch')
  return saved
}

export function readRow(dir, filename) {
  const bytes = readFileSync(join(dir, filename))
  const issue = JSON.parse(bytes)
  if (
    bytes.toString() !== `${JSON.stringify(issue)}\n` ||
    issue.sha256 !== sha(JSON.stringify(unsigned(issue)))
  )
    throw new Error('Source physical or logical seal mismatch')
  return { filename, issue, physicalSha256: sha(bytes) }
}

export function sourceRows({
  durationOut = DURATION_OUT,
  flowOut = FLOW_OUT,
  attestationOut = ATTESTATION_OUT,
  sources = readSources(),
  now = () => new Date(),
  atBlock = null,
  issuedAtUtc = now().toISOString(),
} = {}) {
  verifyDuration({ out: durationOut, sources, now })
  verifyFlow({ out: flowOut })
  const latest = sources.checkpoints
    .filter((row) => Date.parse(row.checkpoint.captureEndUtc) <= Date.parse(issuedAtUtc))
    .at(-1)
  if (!latest) return null
  if (atBlock !== null && latest.checkpoint.block.number !== atBlock)
    throw new Error('Forecast anchor was not the latest available checkpoint at issue time')
  const block = latest.checkpoint.block
  const stem = `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
  const durationPath = join(durationOut, 'issues', stem)
  if (!existsSync(durationPath)) return null
  return {
    durationRow: readRow(join(durationOut, 'issues'), stem),
    holderRow: sources.holderRows.find((row) => row.filename === stem),
    flowRow:
      existsSync(join(flowOut, stem)) &&
      Date.parse(JSON.parse(readFileSync(join(flowOut, stem))).issuedAtUtc) <=
        Date.parse(issuedAtUtc)
        ? readRow(flowOut, stem)
        : null,
    attestationRow: readVerifiedAtCheckpoint({
      out: attestationOut,
      checkpoint: latest,
      asOfUtc: issuedAtUtc,
      nowUtc: now().toISOString(),
    }),
    latestCheckpoint: latest,
  }
}

export function verify({ out = OUT, roots = {}, now = () => new Date() } = {}) {
  const files = existsSync(out)
    ? readdirSync(out)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  if (!files.length) return { issues: 0 }
  for (const filename of files) {
    const saved = readRow(out, filename).issue
    if (
      filename !== nameFor(saved.anchorBlock, saved.horizonSeconds) ||
      Date.parse(saved.issuedAtUtc) > now().getTime()
    )
      throw new Error('Forecast issue filename or future issue time')
    const rows = sourceRows({
      ...roots,
      now,
      atBlock: saved.anchorBlock.number,
      issuedAtUtc: saved.issuedAtUtc,
    })
    if (!rows) throw new Error('Forecast issue sources unavailable')
    verifyIssue(saved, rows)
  }
  return { issues: files.length }
}

function guard(path, extra, stat = statfsSync) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Exit forecast disk reserve reached')
}

export function issueLatest({
  out = OUT,
  roots = {},
  horizonSeconds,
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  verify({ out, roots, now })
  const issuedAtUtc = now().toISOString()
  const rows = sourceRows({ ...roots, now, issuedAtUtc })
  if (!rows) return { status: 'unavailable', reason: 'no_latest_verified_holder_duration_anchor' }
  const path = join(out, nameFor(rows.durationRow.issue.block, horizonSeconds))
  if (existsSync(path)) return { status: 'unchanged', path }
  const issue = buildIssue({ ...rows, horizonSeconds, issuedAtUtc })
  const bytes = `${JSON.stringify(issue)}\n`
  guard(out, Buffer.byteLength(bytes), stat)
  mkdirSync(out, { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return { status: 'issued', path, futureForecast: issue.futureForecast.status }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode = '--verify', horizon] = process.argv.slice(2)
    if (mode === '--verify' && horizon === undefined) console.log(JSON.stringify(verify()))
    else if (mode === '--issue' && /^[1-9][0-9]*$/.test(horizon || ''))
      console.log(JSON.stringify(issueLatest({ horizonSeconds: Number(horizon) })))
    else throw new Error('Usage: --verify | --issue <horizonSeconds>')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
