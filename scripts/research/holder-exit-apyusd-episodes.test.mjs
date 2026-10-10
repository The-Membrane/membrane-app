import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  APYUSD_SUBJECT,
  apyUsdBoardSubjects,
  buildApyUsdEpisodes,
} from './holder-exit-apyusd-episodes.mjs'

const SHA = (value) => createHash('sha256').update(value).digest('hex')
const seal = (row) => {
  const { sha256: _old, ...payload } = row
  return { ...payload, sha256: SHA(JSON.stringify(payload)) }
}
const route = APYUSD_SUBJECT.route_key
const vault = APYUSD_SUBJECT.destination
const asset = APYUSD_SUBJECT.asset
const receipt = '0x9bf51f33955ec70f87c4b5c49441815589043237'
const subjectKey = `${route}\0${vault}\0${asset}`
const holder = `0x${'1'.repeat(40)}`
const HORIZONS = [1, 4, 24, 48, 168]
const HOUR_MS = 3_600_000
const BASELINE_MS = Date.parse('2026-10-04T00:00:00.000Z')
const ISSUE_MS = BASELINE_MS + 10 * 60_000
const Q = [
  '1000000000000000000',
  '10000000000000000000',
  '100000000000000000000',
  null,
  '2000000000000000000',
  '4000000000000000000',
]
const identity = {
  vaultImpl: '0xfd616567ecc1607f61073951a1e822f7315bb112',
  receiptImpl: '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982',
  codeHashes: [
    '0x748fde5d195af5984cc16c81df36137e6599c6f50f9f5113d05994c1b90ebad7',
    '0x76f9f10f52a301cd5472850a4ac1f5421c8bb57f126e7bd171bd9d3ae70dc30b',
    '0x7427a665f82e79f9e1e3a5592339de70bffab25517bbad2f7127549874fbf670',
    '0xae89d4b99f8590a5045c314350c7e1a0a7fdd69fd1adeb11aa554d6e2edeb1eb',
  ],
}
const at = (ms) => new Date(ms).toISOString()
const assay = (status) =>
  status === 'evm_revert'
    ? { status, sharesRaw: null, simulatedReceiptId: null }
    : { status, sharesRaw: '123', simulatedReceiptId: '456' }

function issue() {
  return seal({
    study: 'carry_public_apyusd_exit_issue_v1',
    sequence: 1,
    previousSha256: null,
    routeKey: route,
    destination: vault,
    originalAsset: asset,
    receipt,
    holder,
    holderSharesRaw: '5000000000000000000',
    maxWithdrawRaw: Q[5],
    issuedAtUtc: at(ISSUE_MS),
    slot: Math.floor(ISSUE_MS / (15 * 60_000)),
    baseline: {
      number: '100',
      hash: `0x${'a'.repeat(64)}`,
      parentHash: `0x${'b'.repeat(64)}`,
      timestamp: BASELINE_MS / 1_000,
      identity,
      originA: 'one.example',
      originB: 'two.example',
    },
    horizonsHours: HORIZONS,
    targets: HORIZONS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: at(ISSUE_MS + horizonHours * HOUR_MS),
      captureDeadlineUtc: at(ISSUE_MS + (horizonHours + 2) * HOUR_MS),
    })),
    cases: Q.map((assetsRaw, index) => {
      if (assetsRaw === null)
        return { label: `q${index + 1}`, assetsRaw, status: 'omitted', baseline: null }
      const status = index === 1 ? 'evm_revert' : 'initiation_success'
      return {
        label: `q${index + 1}`,
        assetsRaw,
        status: 'measured',
        baseline: {
          status,
          primary: assay(status),
          secondary: assay(status),
          payout: 'not_delivered_by_initiation',
        },
      }
    }),
    finalPayout: 'unmeasured_no_onchain_owned_receipt',
  })
}

function score(parent, horizonHours = 1, status = 'measured', outcomes = {}) {
  const plan = parent.targets.find((target) => target.horizonHours === horizonHours)
  const targetMs = Date.parse(plan.targetAtUtc)
  const deadlineMs = Date.parse(plan.captureDeadlineUtc)
  const prior = {
    number: '109',
    hash: `0x${'c'.repeat(64)}`,
    parentHash: `0x${'d'.repeat(64)}`,
    timestamp: (targetMs - 1_000) / 1_000,
  }
  const target =
    status === 'measured'
      ? {
          number: '110',
          hash: `0x${'e'.repeat(64)}`,
          parentHash: prior.hash,
          timestamp: (targetMs + 5_000) / 1_000,
          parent: prior,
          identity,
          originA: 'one.example',
          originB: 'two.example',
        }
      : null
  return seal({
    study: 'carry_public_apyusd_exit_score_v1',
    sequence: 1,
    previousSha256: null,
    issueSequence: parent.sequence,
    issueSha256: parent.sha256,
    routeKey: route,
    destination: vault,
    originalAsset: asset,
    holder: parent.holder,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc: at(status === 'measured' ? targetMs + 60_000 : deadlineMs + 60_000),
    status,
    target,
    deadlineWitness:
      status === 'measured'
        ? null
        : {
            primary: { ...prior, timestamp: (deadlineMs + 60_000) / 1_000 },
            secondary: { ...prior, timestamp: (deadlineMs + 60_000) / 1_000 },
          },
    cases: parent.cases.map((entry) => {
      if (entry.assetsRaw === null)
        return { label: entry.label, assetsRaw: null, status: 'omitted', outcome: null }
      if (status !== 'measured')
        return {
          label: entry.label,
          assetsRaw: entry.assetsRaw,
          status: 'unavailable',
          outcome: 'censored_capture_window_missed',
        }
      const outcome = outcomes[entry.label] ?? 'initiation_success'
      return {
        label: entry.label,
        assetsRaw: entry.assetsRaw,
        status: 'measured',
        outcome,
        primary: assay(outcome),
        secondary: assay(outcome),
        payout: 'not_delivered_by_initiation',
      }
    }),
    finalPayout: 'unmeasured_no_onchain_owned_receipt',
  })
}

const manifest = { subjects: [APYUSD_SUBJECT] }
function run(issues = [], scores = [], options = {}) {
  return buildApyUsdEpisodes({
    manifest: options.manifest ?? manifest,
    issues,
    scores,
    featuresBySubject: options.featuresBySubject ?? new Map(),
    selectAsOfFeatures:
      options.selectAsOfFeatures ?? (() => ({ featureRefs: [], featureAbstentions: {} })),
    nowMs: options.nowMs ?? ISSUE_MS + 2 * HOUR_MS,
  })
}

test('exact frozen subject and six-Q/H1/4/24/48/168 projection', () => {
  assert.equal(apyUsdBoardSubjects(manifest).get(subjectKey), APYUSD_SUBJECT)
  assert.throws(
    () => apyUsdBoardSubjects({ subjects: [{ ...APYUSD_SUBJECT, asset: vault }] }),
    /frozen_subject_invalid/,
  )
  const parent = issue()
  const result = run([parent], [score(parent, 1, 'measured', { q1: 'evm_revert' })])
  assert.equal(result.episodes.length, 25)
  assert.deepEqual(
    result.episodes.slice(0, 5).map((row) => row.plannedHorizonHours),
    HORIZONS,
  )
  assert.equal(
    result.episodes.some((row) => row.qCaseLabel === 'q4'),
    false,
  )
  assert.deepEqual(result.diagnostics.get(subjectKey), {
    issues: 1,
    noHolderIssues: 0,
    omittedQCases: 1,
    measuredQCases: 5,
    baselineInitiationSuccessCases: 4,
    baselineCoveredRevertCases: 1,
    scoredTargets: 1,
    measuredTargets: 1,
    missedDeadlineTargets: 0,
  })
  const q1 = result.episodes[0]
  assert.equal(q1.stageScope, 'apyusd_withdraw_initiation_eth_call')
  assert.equal(q1.qRaw, Q[0])
  assert.equal(q1.holderCommitment, SHA(`${vault}:${holder}`))
  assert.equal(q1.issueClusterSha256, parent.sha256)
  assert.equal(q1.scoreSha256?.length, 64)
  assert.equal(q1.baseline, 'simulated_callable')
  assert.deepEqual(q1.outcome, { status: 'inconclusive', reason: 'revert_cause_unknown' })
  assert.equal(q1.rawScoreOutcome, 'evm_revert')
  assert.equal(q1.fullRoutePaidProofSha256, null)
  assert.equal(q1.initiationPayout, 'not_delivered_by_initiation')
  assert.equal(q1.finalPayout, 'unmeasured_no_onchain_owned_receipt')
  assert.equal(q1.forecastEligible, false)
  assert.equal(q1.analysisPrimaryForCell, false)
  assert.deepEqual(result.episodes[1].outcome, {
    status: 'pending',
    reason: null,
  })
  assert.equal(result.episodes[1].leadAtIssueMinutes, 4 * 60)
  assert.equal(result.episodes[1].observedAtUtc, null)
})

test('covered baseline revert is unknown-cause and never a paid-exit impairment', () => {
  const parent = issue()
  const result = run([parent], [score(parent)], { nowMs: ISSUE_MS + 200 * HOUR_MS })
  const reverted = result.episodes.find(
    (row) => row.qCaseLabel === 'q2' && row.plannedHorizonHours === 1,
  )
  assert.equal(reverted.baseline, 'inconclusive')
  assert.equal(reverted.baselineReason, 'revert_cause_unknown')
  assert.deepEqual(reverted.observedSimulation, { status: 'simulated_callable', reason: null })
  assert.deepEqual(reverted.outcome, {
    status: 'not_at_risk',
    reason: 'baseline_revert_cause_unknown',
  })
  const missing = result.episodes.find(
    (row) => row.qCaseLabel === 'q1' && row.plannedHorizonHours === 168,
  )
  assert.deepEqual(missing.outcome, {
    status: 'missing',
    reason: 'no_verified_score_after_deadline',
  })
})

test('capture miss censors measured Q cells and keeps omitted Q out of rows', () => {
  const parent = issue()
  const result = run([parent], [score(parent, 4, 'capture_window_missed')], {
    nowMs: ISSUE_MS + 7 * HOUR_MS,
  })
  const row = result.episodes.find(
    (entry) => entry.qCaseLabel === 'q1' && entry.plannedHorizonHours === 4,
  )
  assert.deepEqual(row.outcome, { status: 'censored', reason: 'capture_window_missed' })
  assert.equal(row.observedSimulation, null)
  assert.equal(row.scoreSha256?.length, 64)
  assert.equal(result.diagnostics.get(subjectKey).missedDeadlineTargets, 1)
  assert.equal(result.episodes.length, 25)
})

test('retrospective cutoff hides future ApyUSD issues, scores and diagnostics', () => {
  const parent = issue()
  const observed = score(parent)
  let featureJoins = 0
  const selectAsOfFeatures = () => {
    featureJoins++
    return { featureRefs: [], featureAbstentions: {} }
  }
  const beforeIssue = run([parent], [observed], {
    nowMs: ISSUE_MS - 1,
    selectAsOfFeatures,
  })
  assert.equal(beforeIssue.episodes.length, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).issues, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).measuredQCases, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.equal(featureJoins, 0)
  const atIssue = run([parent], [observed], { nowMs: ISSUE_MS })
  assert.equal(atIssue.episodes.length, 25)
  assert.equal(atIssue.diagnostics.get(subjectKey).issues, 1)
  assert.equal(atIssue.diagnostics.get(subjectKey).scoredTargets, 0)

  const beforeScore = run([parent], [observed], {
    nowMs: Date.parse(observed.scoredAtUtc) - 1,
    selectAsOfFeatures,
  })
  assert.equal(featureJoins, 1)
  assert.equal(beforeScore.episodes.length, 25)
  const hidden = beforeScore.episodes[0]
  assert.equal(hidden.scoreSha256, null)
  assert.equal(hidden.observedAtUtc, null)
  assert.equal(hidden.observedSimulation, null)
  assert.equal(hidden.rawScoreStatus, null)
  assert.equal(hidden.rawScoreOutcome, null)
  assert.deepEqual(hidden.outcome, { status: 'pending', reason: null })
  assert.equal(beforeScore.diagnostics.get(subjectKey).issues, 1)
  assert.equal(beforeScore.diagnostics.get(subjectKey).scoredTargets, 0)

  const atScore = run([parent], [observed], { nowMs: Date.parse(observed.scoredAtUtc) })
  assert.equal(atScore.episodes[0].scoreSha256, observed.sha256)
  assert.equal(atScore.episodes[0].rawScoreOutcome, 'initiation_success')
  assert.equal(atScore.diagnostics.get(subjectKey).scoredTargets, 1)
  assert.equal(atScore.diagnostics.get(subjectKey).measuredTargets, 1)

  assert.throws(
    () =>
      run([parent], [seal({ ...observed, holder: `0x${'2'.repeat(40)}` })], {
        nowMs: Date.parse(observed.scoredAtUtc) - 1,
      }),
    /score_binding_invalid/,
  )
  assert.throws(
    () =>
      run([parent], [seal({ ...observed, scoredAtUtc: 'invalid' })], {
        nowMs: Date.parse(observed.scoredAtUtc) - 1,
      }),
    /clock_invalid/,
  )
  assert.throws(
    () => run([seal({ ...parent, holder: null })], [], { nowMs: ISSUE_MS - 1 }),
    /issue_identity_invalid/,
  )
})

test('a future ApyUSD capture-miss seal does not censor an earlier missing target', () => {
  const parent = issue()
  const missed = score(parent, 1, 'capture_window_missed')
  const beforeSeal = run([parent], [missed], {
    nowMs: Date.parse(missed.scoredAtUtc) - 1,
  })
  assert.deepEqual(beforeSeal.episodes[0].outcome, {
    status: 'missing',
    reason: 'no_verified_score_after_deadline',
  })
  assert.equal(beforeSeal.episodes[0].scoreSha256, null)
  assert.equal(beforeSeal.diagnostics.get(subjectKey).missedDeadlineTargets, 0)
  const atSeal = run([parent], [missed], { nowMs: Date.parse(missed.scoredAtUtc) })
  assert.equal(atSeal.episodes[0].outcome.status, 'censored')
  assert.equal(atSeal.diagnostics.get(subjectKey).missedDeadlineTargets, 1)
})

test('sealed future ApyUSD target and deadline witnesses cannot postdate the score', () => {
  const parent = issue()
  const measured = score(parent)
  const futureBlockAt = Date.parse(measured.scoredAtUtc) + 1_000
  const malformedTarget = seal({
    ...measured,
    target: { ...measured.target, timestamp: futureBlockAt / 1_000 },
  })
  assert.throws(
    () => run([parent], [malformedTarget], { nowMs: Date.parse(measured.scoredAtUtc) - 1 }),
    /score_target_invalid/,
  )
  const missed = score(parent, 1, 'capture_window_missed')
  const malformedPrimary = seal({
    ...missed,
    deadlineWitness: {
      ...missed.deadlineWitness,
      primary: {
        ...missed.deadlineWitness.primary,
        timestamp: Date.parse(missed.scoredAtUtc) / 1_000 + 1,
      },
    },
  })
  assert.throws(
    () => run([parent], [malformedPrimary], { nowMs: Date.parse(missed.scoredAtUtc) - 1 }),
    /score_censor_invalid/,
  )
  const malformedSecondary = seal({
    ...missed,
    deadlineWitness: {
      ...missed.deadlineWitness,
      secondary: {
        ...missed.deadlineWitness.secondary,
        timestamp: Date.parse(missed.scoredAtUtc) / 1_000 + 1,
      },
    },
  })
  assert.throws(
    () => run([parent], [malformedSecondary], { nowMs: Date.parse(missed.scoredAtUtc) - 1 }),
    /score_censor_invalid/,
  )
})

test('features are selected against the pinned baseline, never a later target', () => {
  const parent = issue()
  const features = [{ receiptSha256: 'fixture' }]
  const result = run([parent], [], {
    featuresBySubject: new Map([[subjectKey, features]]),
    selectAsOfFeatures: (received, subject, selectedIssue, parentView) => {
      assert.equal(received, features)
      assert.equal(subject, APYUSD_SUBJECT)
      assert.equal(selectedIssue, parent)
      assert.deepEqual(parentView.baseline, {
        targetBlock: parent.baseline.number,
        targetHash: parent.baseline.hash,
        targetBlockAt: at(BASELINE_MS),
      })
      return { featureRefs: [{ kind: 'fixture' }], featureAbstentions: {} }
    },
  })
  assert.deepEqual(result.episodes[0].featureRefs, [{ kind: 'fixture' }])
  assert.equal(result.episodes[0].baselineAtUtc, at(BASELINE_MS))
})

test('unsealed, no-holder, wrong Q, and shifted plan issues fail closed', () => {
  const parent = issue()
  assert.throws(() => run([{ ...parent, holder: null }]), /issue_identity_invalid/)
  assert.throws(() => run([seal({ ...parent, holder: null })]), /issue_identity_invalid/)
  assert.throws(
    () =>
      run([
        seal({
          ...parent,
          cases: parent.cases.map((row, i) => (i === 0 ? { ...row, assetsRaw: Q[5] } : row)),
        }),
      ]),
    /issue_q_invalid/,
  )
  assert.throws(
    () =>
      run([
        seal({
          ...parent,
          targets: parent.targets.map((row, i) =>
            i === 0
              ? { ...row, captureDeadlineUtc: at(Date.parse(row.captureDeadlineUtc) + 1_000) }
              : row,
          ),
        }),
      ]),
    /issue_target_invalid/,
  )
})

test('score seal and SHA, holder, Q, target/deadline bindings fail closed', () => {
  const parent = issue()
  const valid = score(parent)
  const altered = (change) => seal({ ...valid, ...change })
  assert.throws(
    () => run([parent], [{ ...valid, holder: `0x${'2'.repeat(40)}` }]),
    /score_binding_invalid/,
  )
  assert.throws(
    () => run([parent], [altered({ issueSha256: '0'.repeat(64) })]),
    /score_binding_invalid/,
  )
  assert.throws(
    () => run([parent], [altered({ holder: `0x${'2'.repeat(40)}` })]),
    /score_binding_invalid/,
  )
  assert.throws(
    () => run([parent], [altered({ captureDeadlineUtc: at(ISSUE_MS + 3 * HOUR_MS + 1_000) })]),
    /score_binding_invalid/,
  )
  assert.throws(
    () =>
      run(
        [parent],
        [
          altered({
            cases: valid.cases.map((row, i) => (i === 0 ? { ...row, assetsRaw: Q[5] } : row)),
          }),
        ],
      ),
    /score_q_binding_invalid/,
  )
  assert.throws(
    () =>
      run(
        [parent],
        [altered({ target: { ...valid.target, timestamp: valid.target.timestamp + 3 * 3_600 } })],
      ),
    /score_target_invalid/,
  )
})

test('copied route, receipt and plan constants agree with the source modules', () => {
  const commonSource = readFileSync(
    new URL('./carry-public-apyusd-exit-common.mjs', import.meta.url),
    'utf8',
  )
  const sourceHashes = commonSource.match(/const CODE_HASHES = \[([\s\S]*?)\n\]/)?.[1]
  assert.ok(sourceHashes)
  assert.deepEqual(
    [...sourceHashes.matchAll(/0x[0-9a-f]{64}/g)].map((match) => match[0]),
    identity.codeHashes,
  )
  const script = `
    const common = await import('./scripts/research/carry-public-apyusd-exit-common.mjs');
    const issue = await import('./scripts/research/carry-public-apyusd-exit-issue.mjs');
    const score = await import('./scripts/research/carry-public-apyusd-exit-score.mjs');
    console.log(JSON.stringify({subject:{route_key:common.ROUTE,destination:common.VAULT,asset:common.ASSET},receipt:common.RECEIPT,horizons:common.HORIZONS,issueStudy:issue.STUDY,scoreStudy:score.STUDY}));
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../..', import.meta.url).pathname,
    encoding: 'utf8',
    maxBuffer: 32 * 1024,
  })
  assert.equal(child.status, 0, child.stderr)
  const source = JSON.parse(child.stdout)
  assert.deepEqual(source.subject, APYUSD_SUBJECT)
  assert.equal(source.receipt, receipt)
  assert.deepEqual(source.horizons, HORIZONS)
  assert.equal(source.issueStudy, 'carry_public_apyusd_exit_issue_v1')
  assert.equal(source.scoreStudy, 'carry_public_apyusd_exit_score_v1')
})
