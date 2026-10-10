import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boundIssueNameV2 } from './scrvusd-exit-forecast-issue.mjs'
import {
  labelsFromVerifiedBoundRowsV2,
  labelsFromWitnessedBoundRowsV2,
  readBoundLabelsWithPgV2,
  readWitnessedBoundLabelsWithPgV2,
  verifiedStableBoundRowsV2,
} from './scrvusd-bound-prospective-exit-labels.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const at = (seconds) =>
  new Date(Date.parse('2026-09-28T00:00:00.000Z') + seconds * 1000).toISOString()
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const row = (filename, issue) => ({
  filename,
  issue,
  physicalSha256: sha(`${JSON.stringify(issue)}\n`),
})
const ref = (value) => ({
  filename: value.filename,
  logicalSha256: value.issue.sha256,
  physicalSha256: value.physicalSha256,
})

function fixture({ slotId = 'a'.repeat(64), horizonSeconds = 3600, outcome = 'success' } = {}) {
  const anchorBlock = { number: 100, hash: `0x${'b'.repeat(64)}`, timestamp: 1 }
  const issue = seal({
    study: 'scrvusd-now-origin-exit-forecast-issue-v2',
    scheduledCoverageStatus: 'unconfirmed',
    scheduleBinding: {
      manifestSha256: 'c'.repeat(64),
      slotId,
      horizonSeconds,
      attemptStart: { logicalSha256: 'd'.repeat(64) },
    },
    issuedAtUtc: at(100),
    targetUtc: at(100 + horizonSeconds),
    outcomeProtocol: { checkpointSelection: { captureDeadlineUtc: at(200 + horizonSeconds) } },
    horizonOrigin: 'issue_time',
    horizonSeconds,
    anchorBlock,
    holder: `0x${'1'.repeat(40)}`,
    qAssetsRaw: '1000',
    route: 'direct_erc4626_withdraw_crvusd_from_scrvusd',
    currentExecutableAbility: { status: 'sampled_success', capturedAtUtc: at(90) },
    historicalContext: { flowStatus: 'unavailable', flow: null },
  })
  const issueRow = row(boundIssueNameV2(issue), issue)
  const score = seal({
    study: 'scrvusd-now-origin-exit-forecast-score-v2',
    issue: ref(issueRow),
    scoredAtUtc: at(5000),
    targetUtc: issue.targetUtc,
    horizonSeconds,
    pointOutcome: {
      status: outcome,
      holder: issue.holder,
      qAssetsRaw: issue.qAssetsRaw,
      route: issue.route,
    },
    trajectory: { status: 'unavailable' },
    sampledCodeIdentity: { status: 'unknown' },
  })
  return { issueRow, scoreRow: row(issueRow.filename, score) }
}

function witnesses({ issueRow, scoreRow }, { runAt = 150, scoreAt = 5100 } = {}) {
  const binding = issueRow.issue.scheduleBinding
  return {
    runWitnesses: [
      {
        manifestSha256: binding.manifestSha256,
        slotId: binding.slotId,
        runVisibleAtUtc: at(runAt),
        witnessXid: '2',
        historicalAvailabilityCertifiedForRun: true,
      },
    ],
    scoreWitnesses: scoreRow
      ? [
          {
            manifestSha256: binding.manifestSha256,
            slotId: binding.slotId,
            horizonSeconds: issueRow.issue.horizonSeconds,
            issueLogicalSha256: issueRow.issue.sha256,
            issuePhysicalSha256: issueRow.physicalSha256,
            scoreFilename: scoreRow.filename,
            scoreLogicalSha256: scoreRow.issue.sha256,
            scorePhysicalSha256: scoreRow.physicalSha256,
            scorePayload: JSON.stringify(scoreRow.issue),
            scoreVisibleAtUtc: at(scoreAt),
            witnessXid: '4',
            historicalAvailabilityCertifiedForScore: true,
          },
        ]
      : [],
  }
}

function cohort(sample, { asOfUtc = at(5200), includeScore = true } = {}) {
  const binding = sample.issueRow.issue.scheduleBinding
  const issue = {
    filename: sample.issueRow.filename,
    logicalSha256: sample.issueRow.issue.sha256,
    physicalSha256: sample.issueRow.physicalSha256,
    payload: JSON.stringify(sample.issueRow.issue),
  }
  const score = includeScore
    ? {
        filename: sample.scoreRow.filename,
        logicalSha256: sample.scoreRow.issue.sha256,
        physicalSha256: sample.scoreRow.physicalSha256,
        payload: JSON.stringify(sample.scoreRow.issue),
      }
    : null
  return {
    asOfUtc,
    runs: [
      {
        manifestSha256: binding.manifestSha256,
        slotId: binding.slotId,
        arms: [
          { horizonSeconds: 3600, status: 'issued', issue, score },
          { horizonSeconds: 7200, status: 'abstained', issue: null, score: null },
          { horizonSeconds: 86400, status: 'failed', issue: null, score: null },
          { horizonSeconds: 604800, status: 'unknown', issue: null, score: null },
        ],
      },
    ],
    runCount: 1,
    armCount: 4,
    issuedArmCount: 1,
    witnessedScoreCount: includeScore ? 1 : 0,
  }
}

test('DB witnessed four-arm census reconciles exact local issue and visible score bytes', () => {
  const sample = fixture()
  const proof = witnesses(sample)
  const asOfUtc = at(5200)
  const inputs = {
    issues: [sample.issueRow],
    scores: [sample.scoreRow],
    ...proof,
    dbCohort: cohort(sample, { asOfUtc }),
    asOfUtc,
  }
  const result = labelsFromWitnessedBoundRowsV2(inputs)
  assert.deepEqual(result.armDenominators, {
    runs: 1,
    total: 4,
    issued: 1,
    abstained: 1,
    failed: 1,
    unknown: 1,
  })
  assert.equal(result.denominators.issued, 1)
  assert.equal(result.witnessedRunCohortComplete, true)
  assert.equal(result.scheduledSlotCohortComplete, false)
  assert.equal(result.fullCohortComplete, false)
  assert.equal(result.chronologicalBacktestEligible, false)
  assert.throws(
    () =>
      labelsFromWitnessedBoundRowsV2({
        ...inputs,
        issues: [],
        scores: [],
        runWitnesses: [],
        scoreWitnesses: [],
      }),
    /differs from retained local file set/,
  )
  assert.throws(
    () =>
      labelsFromWitnessedBoundRowsV2({
        ...inputs,
        dbCohort: cohort(sample, { asOfUtc, includeScore: false }),
      }),
    /differs from retained local file set/,
  )
  assert.throws(
    () =>
      labelsFromWitnessedBoundRowsV2({
        ...inputs,
        dbCohort: {
          asOfUtc,
          runs: [],
          runCount: 0,
          armCount: 0,
          issuedArmCount: 0,
          witnessedScoreCount: 0,
        },
      }),
    /differs from retained local file set/,
  )
  assert.throws(
    () =>
      labelsFromWitnessedBoundRowsV2({
        ...inputs,
        dbCohort: {
          ...inputs.dbCohort,
          runs: [
            {
              ...inputs.dbCohort.runs[0],
              arms: [
                {
                  ...inputs.dbCohort.runs[0].arms[0],
                  issue: {
                    ...inputs.dbCohort.runs[0].arms[0].issue,
                    physicalSha256: 'f'.repeat(64),
                  },
                },
                ...inputs.dbCohort.runs[0].arms.slice(1),
              ],
            },
          ],
        },
      }),
    /differs from exact local issue/,
  )
})

test('future local score is invisible in the DB census and historical output', () => {
  const sample = fixture()
  const asOfUtc = at(5050)
  const dbCohort = cohort(sample, { asOfUtc, includeScore: false })
  const withFutureScore = labelsFromWitnessedBoundRowsV2({
    issues: [sample.issueRow],
    scores: [sample.scoreRow],
    ...witnesses(sample),
    dbCohort,
    asOfUtc,
  })
  const withoutScore = labelsFromWitnessedBoundRowsV2({
    issues: [sample.issueRow],
    scores: [],
    ...witnesses({ issueRow: sample.issueRow }),
    dbCohort,
    asOfUtc,
  })
  assert.deepEqual(withFutureScore, withoutScore)
})

test('witnessed as-of hides a pre-visibility issue and reports certified lead for visible issue', () => {
  const sample = fixture()
  const inputs = { issues: [sample.issueRow], scores: [sample.scoreRow], ...witnesses(sample) }
  const early = labelsFromWitnessedBoundRowsV2({ ...inputs, asOfUtc: at(120) })
  assert.equal(early.denominators.issued, 0)
  assert.deepEqual(
    early,
    labelsFromWitnessedBoundRowsV2({
      issues: [],
      scores: [],
      runWitnesses: [],
      scoreWitnesses: [],
      asOfUtc: at(120),
    }),
  )
  assert.equal(JSON.stringify(early).includes(at(150)), false)
  const visible = labelsFromWitnessedBoundRowsV2({ ...inputs, asOfUtc: at(200) })
  assert.equal(visible.denominators.issued, 1)
  assert.equal(visible.rows[0].certifiedMinimumPublicationLeadSeconds, 3550)
  assert.equal(visible.rows[0].baselineSampleAgeSecondsAtWitness, 60)
  assert.equal(visible.rows[0].currentAtDecision, 'unverified')
  assert.equal(visible.rows[0].score.status, 'pending')
  assert.equal(visible.rows[0].score.pointOutcome, null)
  assert.equal(visible.chronologicalBacktestEligible, false)
  assert.equal(visible.historicalAvailabilityCertified, false)
  assert.equal(visible.retainedReceiptVisibilityCertified, true)
  assert.equal(visible.fullCohortComplete, false)
  assert.equal(visible.forecast.probability, null)
})

test('witnessed score appears only at its committed visibility time, independent of local scoredAt', () => {
  const sample = fixture()
  const inputs = { issues: [sample.issueRow], scores: [sample.scoreRow], ...witnesses(sample) }
  const delayed = labelsFromWitnessedBoundRowsV2({ ...inputs, asOfUtc: at(5050) })
  assert.equal(delayed.denominators.observed, 0)
  assert.equal(delayed.rows[0].score.ref, null)
  assert.equal(delayed.rows[0].score.status, 'matured_unscored')
  const noCertifiedScore = labelsFromWitnessedBoundRowsV2({
    issues: [sample.issueRow],
    scores: [],
    ...witnesses({ issueRow: sample.issueRow }),
    asOfUtc: at(5050),
  })
  assert.deepEqual(delayed, noCertifiedScore)
  assert.equal(JSON.stringify(delayed).includes(at(5100)), false)
  const available = labelsFromWitnessedBoundRowsV2({ ...inputs, asOfUtc: at(5100) })
  assert.equal(available.denominators.observed, 1)
  assert.deepEqual(available.rows[0].score.ref, ref(sample.scoreRow))
  const noScore = labelsFromWitnessedBoundRowsV2({
    issues: [sample.issueRow],
    scores: [],
    ...witnesses({ issueRow: sample.issueRow }),
    asOfUtc: at(3900),
  })
  assert.equal(noScore.rows[0].score.status, 'matured_unscored')
})

test('witnessed reduction rejects absent, pending, or mismatched receipts and duplicate arms', () => {
  const sample = fixture()
  const proof = witnesses(sample)
  const inputs = {
    issues: [sample.issueRow],
    scores: [sample.scoreRow],
    ...proof,
    asOfUtc: at(5200),
  }
  for (const invalid of [
    { ...inputs, runWitnesses: [null] },
    { ...inputs, scoreWitnesses: [null] },
    { ...inputs, scoreWitnesses: [{ ...proof.scoreWitnesses[0], scoreVisibleAtUtc: null }] },
    {
      ...inputs,
      scoreWitnesses: [{ ...proof.scoreWitnesses[0], scorePhysicalSha256: 'f'.repeat(64) }],
    },
  ])
    assert.throws(() => labelsFromWitnessedBoundRowsV2(invalid), /visibility witness unavailable/)
  assert.throws(
    () =>
      labelsFromWitnessedBoundRowsV2({
        ...inputs,
        issues: [sample.issueRow, sample.issueRow],
        runWitnesses: [proof.runWitnesses[0], proof.runWitnesses[0]],
      }),
    /Duplicate bound schedule arm/,
  )
})

test('v2 scheduled arms retain pending, missing, ambiguous, and observed separately', () => {
  const { issueRow, scoreRow } = fixture()
  const early = labelsFromVerifiedBoundRowsV2({ issues: [issueRow], scores: [], asOfUtc: at(300) })
  assert.deepEqual(early.denominators, {
    issued: 1,
    observed: 0,
    pending: 1,
    missing: 0,
    maturedUnscored: 0,
    ambiguous: 0,
  })
  const missing = labelsFromVerifiedBoundRowsV2({
    issues: [issueRow],
    scores: [],
    asOfUtc: at(3800),
  })
  assert.equal(missing.rows[0].score.status, 'matured_unscored')
  const missingSample = fixture({ outcome: 'missing_quote_checkpoint' })
  const missingEvidence = labelsFromVerifiedBoundRowsV2({
    issues: [missingSample.issueRow],
    scores: [missingSample.scoreRow],
    asOfUtc: at(5000),
  })
  assert.equal(missingEvidence.rows[0].score.status, 'missing')
  assert.equal(missingEvidence.denominators.missing, 1)
  const ambiguous = fixture({ outcome: 'provider_ambiguity' })
  const unclear = labelsFromVerifiedBoundRowsV2({
    issues: [ambiguous.issueRow],
    scores: [ambiguous.scoreRow],
    asOfUtc: at(5000),
  })
  assert.equal(unclear.denominators.ambiguous, 1)
  const observed = labelsFromVerifiedBoundRowsV2({
    issues: [issueRow],
    scores: [scoreRow],
    asOfUtc: at(5000),
  })
  assert.equal(observed.denominators.observed, 1)
  assert.equal(observed.forecast.probability, null)
  assert.equal(observed.forecast.likelyDurationSeconds, null)
  assert.equal(observed.cohort, 'scheduled_bound_v2_only')
  assert.equal(observed.historicalAvailabilityCertified, false)
  assert.equal(observed.chronologicalBacktestEligible, false)
  assert.equal(observed.asOfSemantics, 'retrospective_reconstruction_from_current_verified_ledger')
})

test('same anchor and horizon in distinct slots is valid; duplicate manifest/slot/arm fails', () => {
  const first = fixture()
  const second = fixture({ slotId: 'e'.repeat(64) })
  const labels = labelsFromVerifiedBoundRowsV2({
    issues: [first.issueRow, second.issueRow],
    scores: [],
    asOfUtc: at(5000),
  })
  assert.equal(labels.denominators.issued, 2)
  assert.throws(
    () =>
      labelsFromVerifiedBoundRowsV2({
        issues: [first.issueRow, first.issueRow],
        scores: [],
        asOfUtc: at(5000),
      }),
    /Duplicate bound schedule arm/,
  )
})

test('score must bind exact issue filename, logical SHA, physical SHA, and holder/q', () => {
  const { issueRow, scoreRow } = fixture()
  for (const changedRef of [
    { filename: 'other.json' },
    { logicalSha256: 'e'.repeat(64) },
    { physicalSha256: 'f'.repeat(64) },
  ]) {
    const altered = row(scoreRow.filename, {
      ...scoreRow.issue,
      issue: { ...scoreRow.issue.issue, ...changedRef },
    })
    assert.throws(
      () =>
        labelsFromVerifiedBoundRowsV2({
          issues: [issueRow],
          scores: [altered],
          asOfUtc: at(5000),
        }),
      /does not match exact/,
    )
  }
  const changedHolder = row(scoreRow.filename, {
    ...scoreRow.issue,
    pointOutcome: { ...scoreRow.issue.pointOutcome, holder: 'other' },
  })
  assert.throws(
    () =>
      labelsFromVerifiedBoundRowsV2({
        issues: [issueRow],
        scores: [changedHolder],
        asOfUtc: at(5000),
      }),
    /does not match exact/,
  )
  assert.throws(
    () =>
      labelsFromVerifiedBoundRowsV2({
        issues: [issueRow],
        scores: [scoreRow, scoreRow],
        asOfUtc: at(5000),
      }),
    /Duplicate bound score/,
  )
  const alien = row(issueRow.filename, {
    ...issueRow.issue,
    study: 'scrvusd-now-origin-exit-forecast-issue-v1',
  })
  assert.throws(
    () => labelsFromVerifiedBoundRowsV2({ issues: [alien], scores: [], asOfUtc: at(5000) }),
    /Invalid verified bound exit issue/,
  )
})

test('async verifier rejects concurrent addition, deletion, and changed sealed bytes', async () => {
  const { issueRow } = fixture()
  const root = mkdtempSync(join(tmpdir(), 'bound-label-race-'))
  const issueOut = join(root, 'issues')
  const scoreOut = join(root, 'scores')
  mkdirSync(issueOut)
  mkdirSync(scoreOut)
  const path = join(issueOut, issueRow.filename)
  const write = (issue) => writeFileSync(path, `${JSON.stringify(issue)}\n`)
  try {
    await assert.rejects(
      verifiedStableBoundRowsV2({
        issueOut,
        scoreOut,
        verifyLedger: async () => write(issueRow.issue),
      }),
      /changed during verification/,
    )
    await assert.rejects(
      verifiedStableBoundRowsV2({
        issueOut,
        scoreOut,
        verifyLedger: async () => unlinkSync(path),
      }),
      /changed during verification/,
    )
    write(issueRow.issue)
    const changed = seal({ ...issueRow.issue, qAssetsRaw: '999', sha256: undefined })
    await assert.rejects(
      verifiedStableBoundRowsV2({
        issueOut,
        scoreOut,
        verifyLedger: async () => write(changed),
      }),
      /changed during verification/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('async verifier rejects a score arriving while database checks run', async () => {
  const { scoreRow } = fixture()
  const root = mkdtempSync(join(tmpdir(), 'bound-score-race-'))
  const issueOut = join(root, 'issues')
  const scoreOut = join(root, 'scores')
  mkdirSync(issueOut)
  mkdirSync(scoreOut)
  try {
    await assert.rejects(
      verifiedStableBoundRowsV2({
        issueOut,
        scoreOut,
        verifyLedger: async () => {
          await Promise.resolve()
          writeFileSync(join(scoreOut, scoreRow.filename), `${JSON.stringify(scoreRow.issue)}\n`)
        },
      }),
      /changed during verification/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('public witnessed reader requires DB enumeration even for empty local directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bound-label-empty-'))
  try {
    await assert.rejects(readBoundLabelsWithPgV2({ asOfUtc: at(5000) }), /PostgreSQL pool required/)
    const result = await readBoundLabelsWithPgV2({
      pool: {},
      asOfUtc: at(5000),
      issueOut: join(root, 'issues'),
      scoreOut: join(root, 'scores'),
      now: () => new Date(at(6000)),
    })
    assert.equal(result.denominators.issued, 0)
    assert.equal(result.forecast.status, 'unavailable')
    await assert.rejects(
      readWitnessedBoundLabelsWithPgV2({ asOfUtc: at(5000) }),
      /PostgreSQL pool required/,
    )
    await assert.rejects(
      readWitnessedBoundLabelsWithPgV2({
        pool: {
          connect: async () => {
            throw new Error('DB census queried')
          },
        },
        asOfUtc: at(5000),
        issueOut: join(root, 'issues'),
        scoreOut: join(root, 'scores'),
        now: () => new Date(at(6000)),
      }),
      /DB census queried/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
