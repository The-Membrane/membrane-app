// Separate research-only v2 score lane. Every issue linkage is re-read through
// the audited PostgreSQL adapters before scoring and on every verification.
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { BOUND_STUDY_V2, readRow } from './scrvusd-exit-forecast-issue.mjs'
import { verifyBoundIssueWithPgV2 } from './scrvusd-bound-issue-verifier.mjs'
import { readSources } from './scrvusd-holder-duration.mjs'
import { RESERVE_BYTES } from './scrvusd-fixed-holder-exit.mjs'
import { readScoreAttestations, buildScore, replayScore } from './scrvusd-exit-forecast-score.mjs'
import { ATTEMPT_START_OUT, BOUND_ISSUE_OUT, BOUND_SCORE_OUT } from './scrvusd-bound-paths.mjs'
import { createPgNowAsOfStore } from './scrvusd-now-schedule-db.mjs'

export const STUDY_V2 = 'scrvusd-now-origin-exit-forecast-score-v2'
export const ISSUE_OUT_V2 = BOUND_ISSUE_OUT
export const ATTEMPT_START_OUT_V1 = ATTEMPT_START_OUT
export const OUT_V2 = BOUND_SCORE_OUT

function names(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
}

function readScore(dir, filename) {
  const row = readRow(dir, filename)
  if (row.issue.study !== STUDY_V2) throw new Error('Alien v2 score study')
  return row
}

function scoreArm(issue) {
  const { manifestSha256, slotId } = issue.scheduleBinding ?? {}
  const horizonSeconds = issue.horizonSeconds
  if (!manifestSha256 || !slotId || !Number.isInteger(horizonSeconds))
    throw new Error('Exact v2 score arm unavailable')
  return { manifestSha256, slotId, horizonSeconds }
}

function requireExactReceipt(receipt, issueRow, scoreRow) {
  if (
    receipt.issueLogicalSha256 !== issueRow.issue.sha256 ||
    receipt.issuePhysicalSha256 !== issueRow.physicalSha256 ||
    receipt.scoreFilename !== scoreRow.filename ||
    receipt.scoreLogicalSha256 !== scoreRow.issue.sha256 ||
    receipt.scorePhysicalSha256 !== scoreRow.physicalSha256 ||
    receipt.scorePayload !== JSON.stringify(scoreRow.issue)
  )
    throw new Error('Existing v2 score receipt differs from exact local score')
  return receipt
}

export async function requireBoundScoreVisibilityWithPgV2({
  asOfStore,
  issueRow,
  scoreRow,
  allowUnwitnessed = false,
}) {
  const receipt = await asOfStore.readScoreWitness(scoreArm(issueRow.issue))
  if (receipt) requireExactReceipt(receipt, issueRow, scoreRow)
  if (!allowUnwitnessed && (!receipt?.scoreVisibleAtUtc || !receipt?.witnessXid))
    throw new Error('Exact committed v2 score visibility witness unavailable')
  return receipt
}

// The caller supplies the audited store and the full sealed-evidence verifier.
// This seam permits crash/retry tests; its return remains research-only.
export async function finalizeBoundScoreWithPgV2({
  pool,
  issueFilename,
  out = OUT_V2,
  issueOut = ISSUE_OUT_V2,
  attemptStartOut = ATTEMPT_START_OUT_V1,
  roots = {},
  now = () => new Date(),
  asOfStore = createPgNowAsOfStore(pool),
  verifyScores = verifyBoundScoresInternal,
}) {
  if (!pool) throw new Error('PostgreSQL pool required for v2 score finalization')
  await verifyScores({
    pool,
    out,
    issueOut,
    attemptStartOut,
    roots,
    now,
    allowUnwitnessedFilename: issueFilename,
  })
  const issueRow = readRow(issueOut, issueFilename)
  const scoreRow = readRow(out, issueFilename)
  if (issueRow.issue.study !== BOUND_STUDY_V2 || scoreRow.issue.study !== STUDY_V2)
    throw new Error('Exact v2 issue and score required')
  const arm = scoreArm(issueRow.issue)
  const receipt = await asOfStore.readScoreWitness(arm)
  if (receipt) requireExactReceipt(receipt, issueRow, scoreRow)
  const recorded =
    receipt ??
    (await asOfStore.recordScore({
      ...arm,
      issueFilename,
      issueOut,
      scoreOut: out,
    }))
  requireExactReceipt(recorded, issueRow, scoreRow)
  const witnessed = recorded.scoreVisibleAtUtc ? recorded : await asOfStore.witnessScore(arm)
  requireExactReceipt(witnessed, issueRow, scoreRow)
  if (!witnessed.scoreVisibleAtUtc || !witnessed.witnessXid)
    throw new Error('V2 score visibility witness unavailable')
  return {
    status: receipt?.scoreVisibleAtUtc ? 'already_scored' : 'scored',
    filename: issueFilename,
    scoreSha256: scoreRow.issue.sha256,
    scoreVisibleAtUtc: witnessed.scoreVisibleAtUtc,
    forecastEligible: false,
  }
}

function reserve(path, bytes, stat) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - bytes < RESERVE_BYTES)
    throw new Error('Bound exit score disk reserve reached')
}

async function verifiedIssue({ pool, issueOut, attemptStartOut, issueFilename, roots, now }) {
  const proof = await verifyBoundIssueWithPgV2({
    pool,
    issueOut,
    issueFilename,
    attemptStartOut,
    roots,
    now,
  })
  if (proof.scheduledCoverageStatus !== 'db_linkage_verified_source_timing_self_reported')
    throw new Error('Fresh v2 database linkage unavailable')
  const row = readRow(issueOut, issueFilename)
  if (row.issue.study !== BOUND_STUDY_V2 || proof.issueSha256 !== row.issue.sha256)
    throw new Error('Verified issue changed after database readback')
  return row
}

async function verifyBoundScoresInternal({
  pool,
  out = OUT_V2,
  issueOut = ISSUE_OUT_V2,
  attemptStartOut = ATTEMPT_START_OUT_V1,
  roots = {},
  now = () => new Date(),
  allowContested = false,
  allowUnwitnessedFilename = null,
}) {
  if (!pool) throw new Error('PostgreSQL pool required for v2 score verification')
  const scoreNames = names(out)
  const sources = readSources({ ...roots, now })
  const asOfStore = createPgNowAsOfStore(pool)
  const contestedScores = []
  for (const filename of scoreNames) {
    const issueRow = await verifiedIssue({
      pool,
      issueOut,
      attemptStartOut,
      issueFilename: filename,
      roots,
      now,
    })
    const scoreRow = readScore(out, filename)
    const saved = scoreRow.issue
    if (Date.parse(saved.scoredAtUtc) > now().getTime()) throw new Error('Future v2 score clock')
    const snapshotQuotes = saved.evidenceSnapshot?.quoteRefs?.map((source) =>
      sources.checkpoints.find((row) => row.filename === source.filename),
    )
    if (!snapshotQuotes || snapshotQuotes.some((row) => !row))
      throw new Error('Sealed v2 quote evidence unavailable')
    const attestationOptions = {
      issue: issueRow.issue,
      out: roots.attestationOut,
      nowUtc: now().toISOString(),
    }
    const snapshotAttestations = readScoreAttestations({
      ...attestationOptions,
      checkpoints: snapshotQuotes,
    })
    const currentAttestations = readScoreAttestations({
      ...attestationOptions,
      checkpoints: sources.checkpoints,
    })
    const attestations = [
      ...new Map(
        [...snapshotAttestations.attestationRows, ...currentAttestations.attestationRows].map(
          (row) => [row.filename, row],
        ),
      ).values(),
    ]
    const replay = replayScore({
      saved,
      issueRow,
      checkpoints: sources.checkpoints,
      holderRows: sources.holderRows,
      attestationRows: attestations,
      invalidAttestationBlocks: currentAttestations.invalidAttestationBlocks,
      invalidAttestationFiles: currentAttestations.invalidAttestationFiles,
      snapshotInvalidAttestationFiles: snapshotAttestations.invalidAttestationFiles,
      allowContested,
      issueStudy: BOUND_STUDY_V2,
      scoreStudy: STUDY_V2,
    })
    await requireBoundScoreVisibilityWithPgV2({
      asOfStore,
      issueRow,
      scoreRow,
      allowUnwitnessed: filename === allowUnwitnessedFilename,
    })
    if (Object.values(replay.additionalEligibleEvidence).some((count) => count > 0))
      contestedScores.push({ filename, ...replay })
  }
  return { scores: scoreNames.length, contestedScores, forecastEligible: false }
}

// Public verification never accepts an unwitnessed local score. The private
// recovery exception is used only while finalizing one exact local file.
export async function verifyBoundScoresWithPgV2(options = {}) {
  return verifyBoundScoresInternal({ ...options, allowUnwitnessedFilename: null })
}

export async function scoreBoundIssueWithPgV2({
  pool,
  issueFilename,
  out = OUT_V2,
  issueOut = ISSUE_OUT_V2,
  attemptStartOut = ATTEMPT_START_OUT_V1,
  roots = {},
  now = () => new Date(),
  stat = statfsSync,
}) {
  if (!pool) throw new Error('PostgreSQL pool required for v2 scoring')
  await verifyBoundScoresInternal({
    pool,
    out,
    issueOut,
    attemptStartOut,
    roots,
    now,
    allowUnwitnessedFilename: issueFilename,
  })
  const issueRow = await verifiedIssue({
    pool,
    issueOut,
    attemptStartOut,
    issueFilename,
    roots,
    now,
  })
  const path = join(out, issueFilename)
  const arm = scoreArm(issueRow.issue)
  const asOfStore = createPgNowAsOfStore(pool)
  if (existsSync(path))
    return finalizeBoundScoreWithPgV2({
      pool,
      issueFilename,
      out,
      issueOut,
      attemptStartOut,
      roots,
      now,
      asOfStore,
    })
  if (await asOfStore.readScoreWitness(arm))
    throw new Error('V2 score receipt exists without exact local score')
  if (
    now().getTime() <
    Date.parse(issueRow.issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc)
  )
    return { status: 'pending', filename: issueFilename }
  const sources = readSources({ ...roots, now })
  const score = buildScore({
    issueRow,
    checkpoints: sources.checkpoints,
    holderRows: sources.holderRows,
    ...readScoreAttestations({
      issue: issueRow.issue,
      checkpoints: sources.checkpoints,
      out: roots.attestationOut,
      nowUtc: now().toISOString(),
    }),
    scoredAtUtc: now().toISOString(),
    issueStudy: BOUND_STUDY_V2,
    scoreStudy: STUDY_V2,
  })
  const bytes = `${JSON.stringify(score)}\n`
  reserve(out, Buffer.byteLength(bytes), stat)
  mkdirSync(out, { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return finalizeBoundScoreWithPgV2({
    pool,
    issueFilename,
    out,
    issueOut,
    attemptStartOut,
    roots,
    now,
    asOfStore,
  })
}
