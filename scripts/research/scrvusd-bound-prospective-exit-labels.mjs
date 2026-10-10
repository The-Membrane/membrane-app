// Read-only v2 scheduled-arm labels. No calibrated probability or duration.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BOUND_STUDY_V2, boundIssueNameV2, readRow } from './scrvusd-exit-forecast-issue.mjs'
import { verifyBoundIssueWithPgV2 } from './scrvusd-bound-issue-verifier.mjs'
import {
  STUDY_V2 as SCORE_STUDY_V2,
  verifyBoundScoresWithPgV2,
} from './scrvusd-bound-exit-forecast-score.mjs'
import { ATTEMPT_START_OUT, BOUND_ISSUE_OUT, BOUND_SCORE_OUT } from './scrvusd-bound-paths.mjs'
import { createPgNowAsOfStore } from './scrvusd-now-schedule-db.mjs'

export const SCHEMA_V2 = 'scrvusd-bound-prospective-exit-labels-v2'
export const WITNESSED_SCHEMA_V2 = 'scrvusd-bound-prospective-exit-labels-witnessed-v1'
const SHA = /^[0-9a-f]{64}$/
const canonicalUtc = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
const ref = (row) => ({
  filename: row.filename,
  logicalSha256: row.issue.sha256,
  physicalSha256: row.physicalSha256,
})

function rowsIn(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((filename) => filename.endsWith('.json'))
    .sort()
    .map((filename) => readRow(dir, filename))
}

function identity(rows) {
  return rows.map((row) => [row.filename, row.issue.sha256, row.physicalSha256])
}

// The async DB verifier and score replay can take time. Admit only the exact
// filename and byte set seen before and after both verification passes.
export async function verifiedStableBoundRowsV2({ issueOut, scoreOut, verifyLedger }) {
  const before = { issues: rowsIn(issueOut), scores: rowsIn(scoreOut) }
  const verification = await verifyLedger(before)
  const after = { issues: rowsIn(issueOut), scores: rowsIn(scoreOut) }
  if (
    JSON.stringify(identity(before.issues)) !== JSON.stringify(identity(after.issues)) ||
    JSON.stringify(identity(before.scores)) !== JSON.stringify(identity(after.scores))
  )
    throw new Error('Bound exit label file set changed during verification')
  return { ...before, verification }
}

function armOf(row) {
  return {
    manifestSha256: row.issue.scheduleBinding.manifestSha256,
    slotId: row.issue.scheduleBinding.slotId,
    horizonSeconds: row.issue.horizonSeconds,
  }
}

// Pure reduction for receipts already read inside the stable-file verifier.
// A public reader must still run fresh PG issue and score replay first.
export function labelsFromWitnessedBoundRowsV2({
  issues,
  scores,
  runWitnesses,
  scoreWitnesses,
  dbCohort = null,
  asOfUtc,
}) {
  if (
    !canonicalUtc(asOfUtc) ||
    !Array.isArray(runWitnesses) ||
    !Array.isArray(scoreWitnesses) ||
    runWitnesses.length !== issues?.length ||
    scoreWitnesses.length !== scores?.length
  )
    throw new Error('Invalid witnessed bound label input')
  // Reuse the v2 arm, score-ref, and duplicate validation without admitting
  // its retrospective as-of semantics into this distinct output schema.
  const validated = labelsFromVerifiedBoundRowsV2({
    issues,
    scores,
    asOfUtc: '9999-12-31T23:59:59.999Z',
  })
  const baseByFilename = new Map(validated.rows.map((row) => [row.issue.filename, row]))
  const scoreByFilename = new Map(scores.map((row) => [row.filename, row]))
  const cutoff = Date.parse(asOfUtc)
  const rows = []
  const visibleLocalIssues = new Map()
  const visibleLocalScores = new Map()
  for (const [index, issueRow] of issues.entries()) {
    const issue = issueRow.issue
    const arm = armOf(issueRow)
    const run = runWitnesses[index]
    if (
      run?.manifestSha256 !== arm.manifestSha256 ||
      run?.slotId !== arm.slotId ||
      !canonicalUtc(run?.runVisibleAtUtc) ||
      !run?.witnessXid ||
      run?.historicalAvailabilityCertifiedForRun !== true ||
      Date.parse(run.runVisibleAtUtc) < Date.parse(issue.issuedAtUtc)
    )
      throw new Error('Exact committed v2 run visibility witness unavailable')
    if (Date.parse(run.runVisibleAtUtc) > cutoff) continue
    const armKey = JSON.stringify([arm.manifestSha256, arm.slotId, arm.horizonSeconds])
    visibleLocalIssues.set(armKey, issueRow)
    const certifiedMinimumPublicationLeadSeconds =
      (Date.parse(issue.targetUtc) - Date.parse(run.runVisibleAtUtc)) / 1000
    const scoreRow = scoreByFilename.get(issueRow.filename)
    const scoreReceipt = scoreRow ? scoreWitnesses[scores.indexOf(scoreRow)] : null
    if (
      scoreRow &&
      (scoreReceipt?.manifestSha256 !== arm.manifestSha256 ||
        scoreReceipt?.slotId !== arm.slotId ||
        scoreReceipt?.horizonSeconds !== arm.horizonSeconds ||
        scoreReceipt?.issueLogicalSha256 !== issue.sha256 ||
        scoreReceipt?.issuePhysicalSha256 !== issueRow.physicalSha256 ||
        scoreReceipt?.scoreFilename !== scoreRow.filename ||
        scoreReceipt?.scoreLogicalSha256 !== scoreRow.issue.sha256 ||
        scoreReceipt?.scorePhysicalSha256 !== scoreRow.physicalSha256 ||
        scoreReceipt?.scorePayload !== JSON.stringify(scoreRow.issue) ||
        !canonicalUtc(scoreReceipt?.scoreVisibleAtUtc) ||
        !scoreReceipt?.witnessXid ||
        scoreReceipt?.historicalAvailabilityCertifiedForScore !== true)
    )
      throw new Error('Exact committed v2 score visibility witness unavailable')
    const capturedAtUtc = issue.currentExecutableAbility?.capturedAtUtc
    const baselineSampleAgeSecondsAtWitness = canonicalUtc(capturedAtUtc)
      ? (Date.parse(run.runVisibleAtUtc) - Date.parse(capturedAtUtc)) / 1000
      : null
    if (baselineSampleAgeSecondsAtWitness !== null && baselineSampleAgeSecondsAtWitness < 0)
      throw new Error('Baseline sample follows committed run visibility')
    const scoreAvailable = scoreRow && Date.parse(scoreReceipt.scoreVisibleAtUtc) <= cutoff
    if (scoreAvailable) visibleLocalScores.set(armKey, scoreRow)
    const base = baseByFilename.get(issueRow.filename)
    const score = scoreAvailable
      ? { ...base.score, scoreVisibleAtUtc: scoreReceipt.scoreVisibleAtUtc }
      : {
          status: cutoff < Date.parse(base.captureDeadlineUtc) ? 'pending' : 'matured_unscored',
          ref: null,
          scoredAtUtc: null,
          pointOutcome: null,
          trajectory: null,
          sampledCodeIdentity: null,
          scoreVisibleAtUtc: null,
        }
    rows.push({
      ...base,
      runVisibleAtUtc: run.runVisibleAtUtc,
      certifiedMinimumPublicationLeadSeconds,
      baselineSampleAgeSecondsAtWitness,
      currentAtDecision: 'unverified',
      score,
    })
  }
  let armDenominators = null
  if (dbCohort) {
    if (dbCohort.asOfUtc !== asOfUtc || !Array.isArray(dbCohort.runs))
      throw new Error('Exact witnessed DB cohort cutoff required')
    const dbIssued = new Map()
    const dbScores = new Map()
    const statusCounts = { issued: 0, abstained: 0, failed: 0, unknown: 0 }
    const seenRuns = new Set()
    for (const run of dbCohort.runs) {
      const runKey = JSON.stringify([run.manifestSha256, run.slotId])
      if (seenRuns.has(runKey) || !Array.isArray(run.arms) || run.arms.length !== 4)
        throw new Error('Malformed witnessed DB four-arm run')
      seenRuns.add(runKey)
      const horizons = new Set()
      for (const arm of run.arms) {
        if (horizons.has(arm.horizonSeconds) || !Object.hasOwn(statusCounts, arm.status))
          throw new Error('Malformed witnessed DB arm status')
        horizons.add(arm.horizonSeconds)
        statusCounts[arm.status]++
        const key = JSON.stringify([run.manifestSha256, run.slotId, arm.horizonSeconds])
        if (arm.status === 'issued') {
          if (!arm.issue || dbIssued.has(key)) throw new Error('Malformed witnessed DB issued arm')
          dbIssued.set(key, arm.issue)
        } else if (arm.issue || arm.score)
          throw new Error('Non-issued DB arm carries issue or score')
        if (arm.score) {
          if (dbScores.has(key)) throw new Error('Duplicate witnessed DB score')
          dbScores.set(key, arm.score)
        }
      }
    }
    if (
      dbCohort.runCount !== seenRuns.size ||
      dbCohort.armCount !== seenRuns.size * 4 ||
      dbCohort.issuedArmCount !== dbIssued.size ||
      dbCohort.witnessedScoreCount !== dbScores.size
    )
      throw new Error('Witnessed DB cohort counts differ from four-arm rows')
    if (visibleLocalIssues.size !== dbIssued.size || visibleLocalScores.size !== dbScores.size)
      throw new Error('Witnessed DB cohort differs from retained local file set')
    for (const [key, issue] of dbIssued) {
      const local = visibleLocalIssues.get(key)
      if (
        !local ||
        issue.filename !== local.filename ||
        issue.logicalSha256 !== local.issue.sha256 ||
        issue.physicalSha256 !== local.physicalSha256 ||
        issue.payload !== JSON.stringify(local.issue)
      )
        throw new Error('Witnessed DB issued arm differs from exact local issue')
    }
    for (const [key, score] of dbScores) {
      const local = visibleLocalScores.get(key)
      if (
        !local ||
        score.filename !== local.filename ||
        score.logicalSha256 !== local.issue.sha256 ||
        score.physicalSha256 !== local.physicalSha256 ||
        score.payload !== JSON.stringify(local.issue)
      )
        throw new Error('Witnessed DB score differs from exact local score')
    }
    armDenominators = { runs: seenRuns.size, total: seenRuns.size * 4, ...statusCounts }
  }
  return {
    schema: WITNESSED_SCHEMA_V2,
    cohort: 'scheduled_bound_v2_witnessed_only',
    asOfUtc,
    asOfSemantics: 'retained_receipt_asof_reconstruction',
    historicalAvailabilityCertified: false,
    retainedReceiptVisibilityCertified: true,
    fullCohortComplete: false,
    witnessedRunCohortComplete: Boolean(dbCohort),
    scheduledSlotCohortComplete: false,
    cohortScope: 'db_witnessed_runs_at_asof',
    chronologicalBacktestEligible: false,
    sourceCollectionIndependentlyTimed: false,
    status: rows.length ? 'descriptive_uncalibrated' : 'unavailable',
    denominators: {
      issued: rows.length,
      observed: rows.filter((row) => row.score.status === 'observed').length,
      pending: rows.filter((row) => row.score.status === 'pending').length,
      missing: rows.filter((row) => row.score.status === 'missing').length,
      maturedUnscored: rows.filter((row) => row.score.status === 'matured_unscored').length,
      ambiguous: rows.filter((row) => row.score.status === 'ambiguous').length,
    },
    armDenominators,
    forecast: { status: 'unavailable', probability: null, likelyDurationSeconds: null },
    caveat:
      'When the witnessed DB four-arm cohort is reconciled, completeness covers DB-witnessed runs at this cutoff. Pre-witness attempted runs are outside that scope. Source capture starts remain self-reported, and chronological backtesting is unavailable; discrete samples do not prove continuous exit ability. Missing and ambiguous are not failures. No v1 denominator is merged.',
    rows,
  }
}

// Deterministic reduction of rows already verified by readBoundLabelsWithPgV2.
// This helper alone does not authenticate DB linkage or source evidence.
export function labelsFromVerifiedBoundRowsV2({ issues, scores, asOfUtc }) {
  if (!canonicalUtc(asOfUtc) || !Array.isArray(issues) || !Array.isArray(scores))
    throw new Error('Invalid bound label input')
  const cutoff = Date.parse(asOfUtc)
  const byFilename = new Map()
  const arms = new Set()
  for (const row of issues) {
    const issue = row?.issue
    const binding = issue?.scheduleBinding
    if (
      issue?.study !== BOUND_STUDY_V2 ||
      issue?.scheduledCoverageStatus !== 'unconfirmed' ||
      row.filename !== boundIssueNameV2(issue) ||
      !SHA.test(row.physicalSha256 ?? '') ||
      !SHA.test(binding?.manifestSha256 ?? '') ||
      !SHA.test(binding?.slotId ?? '') ||
      binding.horizonSeconds !== issue.horizonSeconds ||
      issue.horizonOrigin !== 'issue_time' ||
      !canonicalUtc(issue.issuedAtUtc) ||
      !canonicalUtc(issue.targetUtc) ||
      !canonicalUtc(issue.outcomeProtocol?.checkpointSelection?.captureDeadlineUtc) ||
      issue.targetUtc !==
        new Date(Date.parse(issue.issuedAtUtc) + issue.horizonSeconds * 1000).toISOString()
    )
      throw new Error('Invalid verified bound exit issue row')
    const arm = JSON.stringify([binding.manifestSha256, binding.slotId, issue.horizonSeconds])
    if (byFilename.has(row.filename) || arms.has(arm))
      throw new Error('Duplicate bound schedule arm')
    byFilename.set(row.filename, row)
    arms.add(arm)
  }
  const scoreByFilename = new Map()
  for (const row of scores) {
    const score = row?.issue
    const issueRow = byFilename.get(row?.filename)
    if (
      score?.study !== SCORE_STUDY_V2 ||
      !issueRow ||
      !SHA.test(row.physicalSha256 ?? '') ||
      !canonicalUtc(score.scoredAtUtc) ||
      JSON.stringify(score.issue) !== JSON.stringify(ref(issueRow)) ||
      score.targetUtc !== issueRow.issue.targetUtc ||
      score.horizonSeconds !== issueRow.issue.horizonSeconds ||
      score.pointOutcome?.holder !== issueRow.issue.holder ||
      score.pointOutcome?.qAssetsRaw !== issueRow.issue.qAssetsRaw ||
      score.pointOutcome?.route !== issueRow.issue.route ||
      Date.parse(score.scoredAtUtc) < Date.parse(issueRow.issue.issuedAtUtc)
    )
      throw new Error('Bound score does not match exact verified issue bytes')
    if (scoreByFilename.has(row.filename)) throw new Error('Duplicate bound score')
    scoreByFilename.set(row.filename, row)
  }
  const rows = issues
    .filter((row) => Date.parse(row.issue.issuedAtUtc) <= cutoff)
    .map((row) => {
      const issue = row.issue
      const visibleScore = scoreByFilename.get(row.filename)
      const scoreRow =
        visibleScore && Date.parse(visibleScore.issue.scoredAtUtc) <= cutoff ? visibleScore : null
      const pointStatus = scoreRow?.issue.pointOutcome?.status
      const status = scoreRow
        ? pointStatus === 'success' || pointStatus === 'revert'
          ? 'observed'
          : pointStatus === 'missing' || pointStatus === 'missing_quote_checkpoint'
            ? 'missing'
            : 'ambiguous'
        : cutoff < Date.parse(issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc)
          ? 'pending'
          : 'matured_unscored'
      return {
        arm: {
          manifestSha256: issue.scheduleBinding.manifestSha256,
          slotId: issue.scheduleBinding.slotId,
          horizonSeconds: issue.horizonSeconds,
        },
        issue: ref(row),
        issuedAtUtc: issue.issuedAtUtc,
        targetUtc: issue.targetUtc,
        captureDeadlineUtc: issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc,
        anchorBlock: issue.anchorBlock,
        holder: issue.holder,
        qAssetsRaw: issue.qAssetsRaw,
        route: issue.route,
        baseline: issue.currentExecutableAbility,
        historicalFlowStatus: issue.historicalContext?.flowStatus ?? null,
        historicalFlowContext: issue.historicalContext?.flow ?? null,
        score: {
          status,
          ref: scoreRow ? ref(scoreRow) : null,
          scoredAtUtc: scoreRow?.issue.scoredAtUtc ?? null,
          pointOutcome: scoreRow?.issue.pointOutcome ?? null,
          trajectory: scoreRow?.issue.trajectory ?? null,
          sampledCodeIdentity: scoreRow?.issue.sampledCodeIdentity ?? null,
        },
      }
    })
  return {
    schema: SCHEMA_V2,
    cohort: 'scheduled_bound_v2_only',
    asOfUtc,
    asOfSemantics: 'retrospective_reconstruction_from_current_verified_ledger',
    historicalAvailabilityCertified: false,
    chronologicalBacktestEligible: false,
    status: rows.length ? 'descriptive_uncalibrated' : 'unavailable',
    denominators: {
      issued: rows.length,
      observed: rows.filter((row) => row.score.status === 'observed').length,
      pending: rows.filter((row) => row.score.status === 'pending').length,
      missing: rows.filter((row) => row.score.status === 'missing').length,
      maturedUnscored: rows.filter((row) => row.score.status === 'matured_unscored').length,
      ambiguous: rows.filter((row) => row.score.status === 'ambiguous').length,
    },
    forecast: { status: 'unavailable', probability: null, likelyDurationSeconds: null },
    caveat:
      'DB linkage is checked at read time. Run confirmation and score-file persistence are not certified as available at a historical as-of; this is retrospective reconstruction and cannot support a chronological backtest. Local capture starts remain self-reported. Discrete sampled outcomes do not prove continuous exit ability; missing and ambiguous are not failures. No v1 denominator is merged.',
    rows,
  }
}

export async function readBoundLabelsWithPgV2({
  pool,
  asOfUtc,
  issueOut = BOUND_ISSUE_OUT,
  scoreOut = BOUND_SCORE_OUT,
  attemptStartOut = ATTEMPT_START_OUT,
  roots = {},
  now = () => new Date(),
} = {}) {
  if (!pool) throw new Error('PostgreSQL pool required for bound labels')
  if (!canonicalUtc(asOfUtc) || Date.parse(asOfUtc) > now().getTime())
    throw new Error('Invalid or future bound label as-of UTC')
  const rows = await verifiedStableBoundRowsV2({
    issueOut,
    scoreOut,
    verifyLedger: async ({ issues, scores }) => {
      for (const row of issues) {
        const verified = await verifyBoundIssueWithPgV2({
          pool,
          issueOut,
          issueFilename: row.filename,
          attemptStartOut,
          roots,
          now,
        })
        if (
          verified.scheduledCoverageStatus !== 'db_linkage_verified_source_timing_self_reported' ||
          verified.issueSha256 !== row.issue.sha256
        )
          throw new Error('Fresh DB issue linkage differs from retained bound issue')
      }
      if (scores.length)
        await verifyBoundScoresWithPgV2({
          pool,
          out: scoreOut,
          issueOut,
          attemptStartOut,
          roots,
          now,
        })
    },
  })
  return labelsFromVerifiedBoundRowsV2({ ...rows, asOfUtc })
}

export async function readWitnessedBoundLabelsWithPgV2({
  pool,
  asOfUtc,
  issueOut = BOUND_ISSUE_OUT,
  scoreOut = BOUND_SCORE_OUT,
  attemptStartOut = ATTEMPT_START_OUT,
  roots = {},
  now = () => new Date(),
} = {}) {
  if (!pool) throw new Error('PostgreSQL pool required for witnessed bound labels')
  if (!canonicalUtc(asOfUtc) || Date.parse(asOfUtc) > now().getTime())
    throw new Error('Invalid or future witnessed bound label as-of UTC')
  const asOfStore = createPgNowAsOfStore(pool)
  const stable = await verifiedStableBoundRowsV2({
    issueOut,
    scoreOut,
    verifyLedger: async ({ issues, scores }) => {
      for (const row of issues) {
        const verified = await verifyBoundIssueWithPgV2({
          pool,
          issueOut,
          issueFilename: row.filename,
          attemptStartOut,
          roots,
          now,
        })
        if (
          verified.scheduledCoverageStatus !== 'db_linkage_verified_source_timing_self_reported' ||
          verified.issueSha256 !== row.issue.sha256
        )
          throw new Error('Fresh DB issue linkage differs from retained bound issue')
      }
      if (scores.length)
        await verifyBoundScoresWithPgV2({
          pool,
          out: scoreOut,
          issueOut,
          attemptStartOut,
          roots,
          now,
        })
      const runWitnesses = []
      for (const row of issues) {
        const { manifestSha256, slotId } = armOf(row)
        runWitnesses.push(await asOfStore.readRunWitness({ manifestSha256, slotId }))
      }
      const issueByFilename = new Map(issues.map((row) => [row.filename, row]))
      const scoreWitnesses = []
      for (const score of scores) {
        const issueRow = issueByFilename.get(score.filename)
        if (!issueRow) throw new Error('Bound score lacks retained issue')
        scoreWitnesses.push(await asOfStore.readScoreWitness(armOf(issueRow)))
      }
      const dbCohort = await asOfStore.listWitnessedCohort({ asOfUtc })
      return { runWitnesses, scoreWitnesses, dbCohort }
    },
  })
  return labelsFromWitnessedBoundRowsV2({
    ...stable,
    ...stable.verification,
    asOfUtc,
  })
}
