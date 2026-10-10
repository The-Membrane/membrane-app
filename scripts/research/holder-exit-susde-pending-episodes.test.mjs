import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  SUSDE_PENDING_SUBJECT,
  buildSusdePendingEpisodes,
  susdePendingBoardSubjects,
} from './holder-exit-susde-pending-episodes.mjs'

const { route_key: ROUTE, destination: VAULT, asset: USDE } = SUSDE_PENDING_SUBJECT
const SILO = '0x7fc7c91d556b400afa565013e3f32055a0713425'
const ISSUE_STUDY = 'susde_public_pending_exit_issue_v1'
const SCORE_STUDY = 'susde_public_pending_exit_score_v1'
const HOLDER = `0x${'1'.repeat(40)}`
const OTHER_HOLDER = `0x${'2'.repeat(40)}`
const Q_RAW = '10000000000000000000'
const ISSUED = '2026-10-01T12:00:00.000Z'
const HORIZONS = [1, 4, 24, 48, 168]
const HOUR_MS = 3_600_000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hash = (number) => `0x${number.toString(16).padStart(64, '0')}`
const clock = (hours) => new Date(Date.parse(ISSUED) + hours * HOUR_MS).toISOString()
const subjectKey = `${ROUTE}\0${VAULT}\0${USDE}`
const manifest = () => ({ subjects: [{ ...SUSDE_PENDING_SUBJECT }] })
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const chain = (study, bodies) => {
  let previous = null
  return bodies.map((body, index) => {
    const row = seal({ ...body, study, sequence: index + 1, previousSha256: previous })
    previous = row.sha256
    return row
  })
}
const measurement = (holder, blockNumber, blockHash, pendingAssetsRaw, cooldownEndUtc, claim) => ({
  holder,
  blockNumber,
  blockHash,
  pendingAssetsRaw,
  cooldownEndUtc,
  claim,
  readOnly: true,
  minedDeliveryProven: false,
})
const issueBody = ({
  holder = HOLDER,
  pendingAssetsRaw = Q_RAW,
  cooldownEndUtc = clock(12),
  claim = 'not_yet_eligible',
  issuedAtUtc = ISSUED,
  anchorNumber = 100,
  discoveryTx = hash(71),
  discoveryBlockHash = hash(72),
  discoveryLogIndex = '3',
} = {}) => {
  const issueMs = Date.parse(issuedAtUtc)
  const anchor = {
    blockNumber: String(anchorNumber),
    blockHash: hash(anchorNumber),
    blockAtUtc: new Date(issueMs - 60_000).toISOString(),
    observedAtUtc: new Date(issueMs - 10_000).toISOString(),
  }
  return {
    chainId: 1,
    routeKey: ROUTE,
    vault: VAULT,
    originalAsset: USDE,
    silo: SILO,
    issuedAtUtc,
    anchor,
    holder,
    pendingAssetsRaw,
    cooldownEndUtc,
    measurement: measurement(
      holder,
      anchor.blockNumber,
      anchor.blockHash,
      pendingAssetsRaw,
      cooldownEndUtc,
      claim,
    ),
    screened: [
      {
        status: 'selected',
        holderCommitment: sha(`${VAULT}:${holder}`),
        discoveryTransactionHash: discoveryTx,
        discoveryBlock: '90',
        discoveryLogIndex,
        receiptProof: { transactionHash: discoveryTx, blockHash: discoveryBlockHash },
      },
    ],
    targets: HORIZONS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(issueMs + horizonHours * HOUR_MS).toISOString(),
      captureDeadlineUtc: new Date(issueMs + (horizonHours + 2) * HOUR_MS).toISOString(),
    })),
    estimand: 'existing_pending_whole_queue_unstake_simulation',
    minedDeliveryProven: false,
    representativeCohort: false,
  }
}
const scoreBody = (issue, horizonHours, outcome) => {
  const plan = issue.targets.find((target) => target.horizonHours === horizonHours)
  const onTime = outcome !== 'capture_window_missed'
  const scoreAt = onTime
    ? plan.targetAtUtc
    : new Date(Date.parse(plan.captureDeadlineUtc) + 60_000).toISOString()
  let pendingAssetsRaw = issue.pendingAssetsRaw
  let cooldownEndUtc = issue.cooldownEndUtc
  let claim = 'simulated_unstake_success'
  if (outcome === 'not_yet_eligible') claim = 'not_yet_eligible'
  if (outcome === 'unstake_revert_cause_unknown') claim = 'unstake_revert_cause_unknown'
  if (outcome === 'queue_absent_cause_unknown') {
    pendingAssetsRaw = '0'
    cooldownEndUtc = null
    claim = 'no_pending'
  }
  if (outcome === 'queue_amount_changed_cause_unknown') pendingAssetsRaw = '1'
  if (outcome === 'queue_reset_or_replaced') cooldownEndUtc = clock(200)
  const target = onTime
    ? {
        targetBlock: String(100 + horizonHours),
        targetHash: hash(100 + horizonHours),
        targetBlockAt: plan.targetAtUtc,
        targetObservedAt: plan.targetAtUtc,
      }
    : null
  return {
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    routeKey: ROUTE,
    vault: VAULT,
    originalAsset: USDE,
    silo: SILO,
    holder: issue.holder,
    pendingAssetsRaw: issue.pendingAssetsRaw,
    cooldownEndUtc: issue.cooldownEndUtc,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc: scoreAt,
    onTime,
    target,
    measurement: onTime
      ? measurement(
          issue.holder,
          target.targetBlock,
          target.targetHash,
          pendingAssetsRaw,
          cooldownEndUtc,
          claim,
        )
      : null,
    outcome,
    minedDeliveryProven: false,
  }
}
const build = (issues, scores, nowMs = Date.parse(clock(172)), other = {}) =>
  buildSusdePendingEpisodes({
    manifest: manifest(),
    issues,
    scores,
    featuresBySubject: new Map(),
    selectAsOfFeatures: () => ({ featureRefs: [], featureAbstentions: {} }),
    nowMs,
    ...other,
  })

test('frozen pending subject binds the deployed sUSDe vault and USDe asset', () => {
  assert.equal(Object.isFrozen(SUSDE_PENDING_SUBJECT), true)
  assert.equal(susdePendingBoardSubjects(manifest()).get(subjectKey).asset, USDE)
  assert.throws(
    () => susdePendingBoardSubjects({ subjects: [{ ...SUSDE_PENDING_SUBJECT, asset: SILO }] }),
    /frozen_subject_invalid/,
  )
})

test('existing whole-queue observations keep eligibility, executable claim and queue changes distinct', () => {
  const [issue] = chain(ISSUE_STUDY, [issueBody()])
  const scores = chain(SCORE_STUDY, [
    scoreBody(issue, 1, 'not_yet_eligible'),
    scoreBody(issue, 4, 'queue_absent_cause_unknown'),
    scoreBody(issue, 24, 'simulated_whole_queue_unstake_success'),
    scoreBody(issue, 48, 'queue_amount_changed_cause_unknown'),
    scoreBody(issue, 168, 'queue_reset_or_replaced'),
  ])
  const { episodes, diagnostics } = build([issue], scores)
  assert.equal(episodes.length, 5)
  assert.deepEqual(
    episodes.map((row) => row.plannedHorizonHours),
    HORIZONS,
  )
  assert.deepEqual(
    episodes.map((row) => [row.outcome.status, row.outcome.reason]),
    [
      ['not_at_risk', 'cooldown_not_yet_eligible'],
      ['censored', 'queue_absent_cause_unknown'],
      ['simulated_callable', null],
      ['censored', 'queue_amount_changed_cause_unknown'],
      ['censored', 'queue_reset_or_replaced'],
    ],
  )
  assert.equal(episodes[0].baseline, 'time_gated')
  assert.ok(episodes.every((row) => row.stageScope === 'susde_pending_unstake_eth_call'))
  assert.ok(episodes.every((row) => row.qRaw === Q_RAW && row.cooldownEndUtc === clock(12)))
  assert.ok(episodes.every((row) => row.holderCommitment === sha(`${VAULT}:${HOLDER}`)))
  assert.ok(episodes.every((row) => row.fullRoutePaidProofSha256 === null))
  assert.ok(episodes.every((row) => row.minedDeliveryProven === false))
  assert.ok(episodes.every((row) => row.forecastEligible === false))
  assert.equal(diagnostics.get(subjectKey).queueAttritionCensors, 3)
})

test('pending issue remains invisible until its unwitnessed local issue clock', () => {
  const [issue] = chain(ISSUE_STUDY, [issueBody()])
  const [score] = chain(SCORE_STUDY, [scoreBody(issue, 1, 'not_yet_eligible')])
  const before = build([issue], [score], Date.parse(issue.issuedAtUtc) - 1)
  assert.equal(before.episodes.length, 0)
  assert.deepEqual(
    { ...before.diagnostics.get(subjectKey) },
    {
      issues: 0,
      uniqueQueues: 0,
      scoredTargets: 0,
      measuredTargets: 0,
      missedWindowTargets: 0,
      queueAttritionCensors: 0,
      unknownReverts: 0,
      pendingTargets: 0,
      missingTargets: 0,
      minedDeliveryProven: false,
    },
  )
  const atIssue = build([issue], [score], Date.parse(issue.issuedAtUtc))
  assert.equal(atIssue.episodes.length, 5)
  assert.equal(atIssue.diagnostics.get(subjectKey).issues, 1)
  assert.equal(atIssue.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.ok(atIssue.episodes.every((row) => row.scoreSha256 === null))
  const [invalidFutureScore] = chain(SCORE_STUDY, [
    { ...scoreBody(issue, 1, 'not_yet_eligible'), holder: OTHER_HOLDER },
  ])
  assert.throws(
    () => build([issue], [invalidFutureScore], Date.parse(issue.issuedAtUtc) - 1),
    /score_binding_invalid/,
  )
})

test('pending scores and raw measurement counts wait for the local score clock', () => {
  const [issue] = chain(ISSUE_STUDY, [
    issueBody({ claim: 'simulated_unstake_success', cooldownEndUtc: clock(-1) }),
  ])
  const [score] = chain(SCORE_STUDY, [scoreBody(issue, 1, 'simulated_whole_queue_unstake_success')])
  const before = build([issue], [score], Date.parse(score.scoredAtUtc) - 1)
  const beforeCell = before.episodes[0]
  assert.equal(beforeCell.outcome.status, 'pending')
  assert.equal(beforeCell.scoreSha256, null)
  assert.equal(beforeCell.observedAtUtc, null)
  assert.equal(beforeCell.rawScoreOutcome, null)
  assert.equal(beforeCell.rawScoreClaim, null)
  assert.equal(before.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.equal(before.diagnostics.get(subjectKey).measuredTargets, 0)
  const atScore = build([issue], [score], Date.parse(score.scoredAtUtc))
  assert.equal(atScore.episodes[0].outcome.status, 'simulated_callable')
  assert.equal(atScore.episodes[0].scoreSha256, score.sha256)
  assert.equal(atScore.episodes[0].rawScoreOutcome, score.outcome)
  assert.equal(atScore.diagnostics.get(subjectKey).scoredTargets, 1)
  assert.equal(atScore.diagnostics.get(subjectKey).measuredTargets, 1)
  assert.equal(atScore.episodes[0].issueClock, 'local_operator_clock_unwitnessed')
  assert.equal(atScore.episodes[0].forecastEligible, false)
})

test('future missed-window score stays missing until its sealed score clock', () => {
  const [issue] = chain(ISSUE_STUDY, [issueBody()])
  const [score] = chain(SCORE_STUDY, [scoreBody(issue, 1, 'capture_window_missed')])
  const before = build([issue], [score], Date.parse(score.scoredAtUtc) - 1)
  assert.deepEqual(before.episodes[0].outcome, {
    status: 'missing',
    reason: 'no_verified_score_after_deadline',
  })
  assert.equal(before.diagnostics.get(subjectKey).missedWindowTargets, 0)
  const atScore = build([issue], [score], Date.parse(score.scoredAtUtc))
  assert.deepEqual(atScore.episodes[0].outcome, {
    status: 'censored',
    reason: 'capture_window_missed',
  })
  assert.equal(atScore.diagnostics.get(subjectKey).missedWindowTargets, 1)
})

test('missed capture and absent score remain censor, pending and missing states', () => {
  const [issue] = chain(ISSUE_STUDY, [issueBody()])
  const [score] = chain(SCORE_STUDY, [scoreBody(issue, 1, 'capture_window_missed')])
  const episodes = build([issue], [score], Date.parse(clock(5))).episodes
  assert.deepEqual(episodes[0].outcome, { status: 'censored', reason: 'capture_window_missed' })
  assert.equal(episodes[0].rawScoreOutcome, 'capture_window_missed')
  assert.equal(episodes[1].outcome.status, 'pending')
  assert.equal(build([issue], [score]).episodes[4].outcome.status, 'missing')
})

test('unknown unstake revert never becomes calibrated impairment or recovery', () => {
  const [issue] = chain(ISSUE_STUDY, [issueBody()])
  const [score] = chain(SCORE_STUDY, [scoreBody(issue, 24, 'unstake_revert_cause_unknown')])
  const result = build([issue], [score])
  assert.deepEqual(result.episodes[2].outcome, {
    status: 'inconclusive',
    reason: 'unstake_revert_cause_unknown',
  })
  assert.equal(result.diagnostics.get(subjectKey).unknownReverts, 1)
  const [revertingBaseline] = chain(ISSUE_STUDY, [
    issueBody({ claim: 'unstake_revert_cause_unknown', cooldownEndUtc: clock(-1) }),
  ])
  const [laterSuccess] = chain(SCORE_STUDY, [
    scoreBody(revertingBaseline, 24, 'simulated_whole_queue_unstake_success'),
  ])
  const later = build([revertingBaseline], [laterSuccess]).episodes
  assert.ok(later.every((row) => row.outcome.status === 'not_at_risk'))
  assert.equal(later[2].rawScoreOutcome, 'simulated_whole_queue_unstake_success')
})

test('repeated issue of one receipt-screened queue shares cluster but keeps temporal cells', () => {
  const [first, second] = chain(ISSUE_STUDY, [
    issueBody(),
    issueBody({ issuedAtUtc: clock(0.5), anchorNumber: 101 }),
  ])
  const { episodes, diagnostics } = build([first, second], [])
  assert.equal(episodes.length, 10)
  assert.equal(diagnostics.get(subjectKey).uniqueQueues, 1)
  assert.equal(episodes[0].issueClusterSha256, episodes[5].issueClusterSha256)
  assert.notEqual(episodes[0].analysisCellKey, episodes[5].analysisCellKey)
  assert.notEqual(episodes[0].targetAtUtc, episodes[5].targetAtUtc)

  const [changed] = chain(ISSUE_STUDY, [
    issueBody({ discoveryTx: hash(73), discoveryBlockHash: hash(74) }),
  ])
  assert.notEqual(
    episodes[0].issueClusterSha256,
    build([changed], []).episodes[0].issueClusterSha256,
  )
  const [changedQ] = chain(ISSUE_STUDY, [issueBody({ pendingAssetsRaw: '2' })])
  assert.notEqual(
    episodes[0].issueClusterSha256,
    build([changedQ], []).episodes[0].issueClusterSha256,
  )
})

test('sealed score must bind issue SHA, holder, Q, cooldown and exact target plan', () => {
  const [issue] = chain(ISSUE_STUDY, [issueBody()])
  const mutations = [
    (row) => (row.issueSha256 = '0'.repeat(64)),
    (row) => (row.holder = OTHER_HOLDER),
    (row) => (row.pendingAssetsRaw = '2'),
    (row) => (row.cooldownEndUtc = clock(13)),
    (row) => (row.targetAtUtc = clock(25)),
    (row) => (row.captureDeadlineUtc = clock(27)),
    (row) => (row.measurement.minedDeliveryProven = true),
    (row) => (row.outcome = 'simulated_whole_queue_unstake_success'),
  ]
  for (const mutate of mutations) {
    const body = scoreBody(issue, 24, 'not_yet_eligible')
    mutate(body)
    const [score] = chain(SCORE_STUDY, [body])
    assert.throws(() => build([issue], [score]))
  }
})

test('resealed score cannot claim observation before its target block', () => {
  const [issue] = chain(ISSUE_STUDY, [issueBody()])
  const body = scoreBody(issue, 1, 'simulated_whole_queue_unstake_success')
  body.target.targetObservedAt = new Date(
    Date.parse(body.target.targetBlockAt) - 1_000,
  ).toISOString()
  const [score] = chain(SCORE_STUDY, [body])
  assert.throws(() => build([issue], [score]), /score_target_invalid/)
})

test('hypothetical initiation or mined delivery cannot enter this pending ledger', () => {
  const [wrongStudy] = chain('susde_public_cooldown_initiation_issue_v1', [issueBody()])
  assert.throws(() => build([wrongStudy], []), /chain_invalid/)
  for (const mutate of [
    (row) => (row.estimand = 'hypothetical_cooldown_initiation'),
    (row) => (row.minedDeliveryProven = true),
    (row) => (row.measurement.minedDeliveryProven = true),
    (row) => (row.cooldownEndUtc = clock(13)),
  ]) {
    const body = issueBody()
    mutate(body)
    const [issue] = chain(ISSUE_STUDY, [body])
    assert.throws(() => build([issue], []))
  }
})
