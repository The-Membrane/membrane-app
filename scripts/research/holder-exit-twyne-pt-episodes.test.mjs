import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  TWYNE_PT_SUBJECT,
  buildTwynePtEpisodes,
  twynePtBoardSubjects,
} from './holder-exit-twyne-pt-episodes.mjs'

const { route_key: ROUTE, destination: WRAPPER, asset: PT } = TWYNE_PT_SUBJECT
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const STUDY = 'carry_twyne_borrower_pt_first_leg_v1'
const SEED_SHA256 = 'c3e85a98ff3b634c8e6c4bdd4cc64e94f3bdcc417c071125cd40cdff09a21243'
const CV = '0x3f937b0a560ebf4621d736fe32b1525940bbfdb0'
const OTHER_CV = '0x259b9f78382febfb76d02d6243ee4f12af7f0c37'
const BORROWER = `0x${'1'.repeat(40)}`
const OTHER_BORROWER = `0x${'2'.repeat(40)}`
const Q_RAW = '1000000000000000000'
const ISSUED = '2026-10-01T12:00:00.000Z'
const HORIZONS = [1, 4, 24, 168]
const HOUR_MS = 3_600_000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hash = (number) => `0x${number.toString(16).padStart(64, '0')}`
const clock = (hours) => new Date(Date.parse(ISSUED) + hours * HOUR_MS).toISOString()
const subjectKey = `${ROUTE}\0${WRAPPER}\0${PT}`
const manifest = () => ({ subjects: [{ ...TWYNE_PT_SUBJECT }] })
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const chain = (kind, bodies) => {
  let previous = null
  return bodies.map((body, index) => {
    const row = seal({
      ...body,
      study: STUDY,
      kind,
      sequence: index + 1,
      previousSha256: previous,
    })
    previous = row.sha256
    return row
  })
}
const block = (number, timestamp) => ({ number, hash: hash(number), timestamp })
const measurement = (atBlock, collateralVault, borrower, status = 'observed', reason = null) => ({
  status,
  reason,
  routeKey: ROUTE,
  collateralVault,
  borrower,
  requestedPtRaw: Q_RAW,
  evidence: {
    chainId: 1,
    blockNumber: atBlock.number,
    blockHash: atBlock.hash,
    blockTimestamp: atBlock.timestamp,
    asset: status === 'unsupported' ? null : WRAPPER,
    targetAsset: status === 'unsupported' ? null : USDE,
    returnedPtRaw: status === 'observed' ? Q_RAW : null,
    source: 'ethereum_finalized_eip1898_eth_call',
    firstLeg: 'twyne_cv_redeem_underlying_pt',
    receiver: 'borrower',
    borrowerKeyControl: 'unassessed',
    finalUsdePayout: 'unassessed',
    deploymentSourceEquivalence: 'unassessed',
  },
})
const issueBody = ({
  collateralVault = CV,
  borrower = BORROWER,
  status = 'observed',
  reason = null,
  issuedAtUtc = ISSUED,
  baselineNumber = 100,
} = {}) => {
  const issueMs = Date.parse(issuedAtUtc)
  const baseline = block(baselineNumber, issueMs / 1_000 - 60)
  return {
    issuedAtUtc,
    slot: Math.floor(issueMs / 1_800_000),
    seedSha256: SEED_SHA256,
    issueKey: sha(
      JSON.stringify([STUDY, SEED_SHA256, ROUTE, collateralVault, borrower, Q_RAW, baseline.hash]),
    ),
    routeKey: ROUTE,
    collateralVault,
    borrower,
    asset: PT,
    qRaw: Q_RAW,
    baseline,
    measurement: measurement(baseline, collateralVault, borrower, status, reason),
    targets: HORIZONS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(issueMs + horizonHours * HOUR_MS).toISOString(),
      deadlineAtUtc: new Date(issueMs + (horizonHours + 2) * HOUR_MS).toISOString(),
    })),
    scope: 'borrower_pt_first_leg_simulation_only',
  }
}
const scoreBody = (issue, horizonHours, outcome, reason = null) => {
  const plan = issue.targets.find((target) => target.horizonHours === horizonHours)
  const targetMs = Date.parse(plan.targetAtUtc)
  const isCensored = outcome === 'censored'
  const atBlock = block(
    issue.baseline.number + horizonHours,
    isCensored
      ? Math.floor(Date.parse(plan.deadlineAtUtc) / 1_000) + 60
      : Math.floor(targetMs / 1_000),
  )
  let status = 'observed'
  let borrower = issue.borrower
  if (outcome === 'restricted') status = 'restricted'
  if (outcome === 'controller_changed') borrower = OTHER_BORROWER
  if (outcome === 'unavailable') {
    borrower = null
    status = 'unsupported'
  }
  return {
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    issueKey: issue.issueKey,
    seedSha256: SEED_SHA256,
    routeKey: ROUTE,
    collateralVault: issue.collateralVault,
    borrower: issue.borrower,
    qRaw: Q_RAW,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    deadlineAtUtc: plan.deadlineAtUtc,
    scope: issue.scope,
    scoredAtUtc: isCensored
      ? new Date(Date.parse(plan.deadlineAtUtc) + 60_000).toISOString()
      : plan.targetAtUtc,
    status: isCensored ? 'censored' : 'measured',
    ...(isCensored ? { reason: 'missed_physical_window' } : { outcome }),
    block: atBlock,
    measurement: isCensored
      ? null
      : measurement(atBlock, issue.collateralVault, borrower, status, reason),
  }
}
const build = (ledger, nowMs = Date.parse(clock(172)), other = {}) =>
  buildTwynePtEpisodes({
    manifest: manifest(),
    ledger,
    featuresBySubject: new Map(),
    selectAsOfFeatures: () => ({ featureRefs: [], featureAbstentions: {} }),
    nowMs,
    ...other,
  })

test('exact frozen subject is wrapper/PT rather than original USDe', () => {
  assert.equal(Object.isFrozen(TWYNE_PT_SUBJECT), true)
  assert.equal(twynePtBoardSubjects(manifest()).get(subjectKey).asset, PT)
  assert.throws(
    () => twynePtBoardSubjects({ subjects: [{ ...TWYNE_PT_SUBJECT, asset: USDE }] }),
    /frozen_subject_invalid/,
  )
})

test('borrower plus collateral vault identity and fixed 1 PT survive all four score outcomes', () => {
  const [issue] = chain('issues', [issueBody()])
  const scores = chain('scores', [
    scoreBody(issue, 1, 'pt_first_leg_simulated'),
    scoreBody(issue, 4, 'restricted', 'credit_reserved'),
    scoreBody(issue, 24, 'controller_changed'),
    scoreBody(issue, 168, 'unavailable', 'deployment_unattested'),
  ])
  const { episodes, diagnostics } = build({ issues: [issue], scores, attempts: [] })
  assert.deepEqual(
    episodes.map((row) => row.plannedHorizonHours),
    HORIZONS,
  )
  assert.deepEqual(
    episodes.map((row) => [row.outcome.status, row.outcome.reason]),
    [
      ['simulated_callable', null],
      ['inconclusive', 'borrower_first_leg_credit_reserved'],
      ['censored', 'borrower_controller_changed'],
      ['inconclusive', 'assay_unavailable'],
    ],
  )
  assert.deepEqual(
    episodes.map((row) => row.rawScoreOutcome),
    ['pt_first_leg_simulated', 'restricted', 'controller_changed', 'unavailable'],
  )
  assert.ok(episodes.every((row) => row.stageScope === 'twyne_pt_borrower_first_leg_eth_call'))
  assert.ok(
    episodes.every((row) => row.qRaw === Q_RAW && row.qUnit === 'PT_srusde_first_leg_assets'),
  )
  assert.ok(episodes.every((row) => row.collateralVault === CV))
  assert.ok(episodes.every((row) => row.holderCommitment === sha(`${CV}:${BORROWER}`)))
  assert.ok(episodes.every((row) => row.borrowerCommitment === sha(BORROWER)))
  assert.ok(episodes.every((row) => row.fullRoutePaidProofSha256 === null))
  assert.ok(episodes.every((row) => row.finalPayoutStatus === 'unassessed'))
  assert.ok(episodes.every((row) => row.borrowerKeyControl === 'unassessed'))
  assert.ok(episodes.every((row) => row.forecastEligible === false))
  assert.equal(diagnostics.get(subjectKey).controllerChangeCensors, 1)
  assert.equal(diagnostics.get(subjectKey).restrictedTargets, 1)
})

test('missed physical window is censored and unscored cells become pending or missing', () => {
  const [issue] = chain('issues', [issueBody()])
  const [score] = chain('scores', [scoreBody(issue, 1, 'censored')])
  const ledger = { issues: [issue], scores: [score], attempts: [] }
  const pending = build(ledger, Date.parse(clock(26))).episodes
  assert.deepEqual(pending[0].outcome, { status: 'censored', reason: 'capture_window_missed' })
  assert.equal(pending[1].outcome.status, 'missing')
  assert.equal(pending[3].outcome.status, 'pending')
  assert.equal(pending[0].rawScoreStatus, 'censored')
  assert.equal(pending[0].rawScoreOutcome, null)
  assert.equal(pending[0].rawScoreReason, 'missed_physical_window')
  assert.equal(build(ledger).episodes[3].outcome.status, 'missing')
})

test('restricted baseline, including generic revert, never starts an impairment-duration risk set', () => {
  for (const reason of ['position_insufficient', 'evm_revert', 'externally_liquidated']) {
    const [issue] = chain('issues', [issueBody({ status: 'restricted', reason })])
    const [score] = chain('scores', [scoreBody(issue, 1, 'pt_first_leg_simulated')])
    const episodes = build({ issues: [issue], scores: [score], attempts: [] }).episodes
    assert.ok(episodes.every((row) => row.outcome.status === 'not_at_risk'))
    assert.equal(episodes[0].rawScoreOutcome, 'pt_first_leg_simulated')
    assert.equal(
      episodes[0].baseline,
      reason === 'position_insufficient' ? 'unavailable' : 'inconclusive',
    )
  }
})

test('score position loss and external liquidation are censored while generic revert is inconclusive', () => {
  const [issue] = chain('issues', [issueBody()])
  const scores = chain('scores', [
    scoreBody(issue, 1, 'restricted', 'position_insufficient'),
    scoreBody(issue, 4, 'restricted', 'evm_revert'),
    scoreBody(issue, 24, 'restricted', 'externally_liquidated'),
  ])
  const { episodes, diagnostics } = build({ issues: [issue], scores, attempts: [] })
  assert.deepEqual(episodes[0].outcome, {
    status: 'censored',
    reason: 'collateral_vault_position_attrition',
  })
  assert.deepEqual(episodes[1].outcome, { status: 'inconclusive', reason: 'revert_cause_unknown' })
  assert.deepEqual(episodes[2].outcome, {
    status: 'censored',
    reason: 'collateral_vault_external_liquidation',
  })
  assert.equal(episodes[2].rawScoreReason, 'externally_liquidated')
  assert.equal(diagnostics.get(subjectKey).positionAttritionCensors, 2)
})

test('sealed issue and score rebinding or paid-payout spoof fails closed', () => {
  const [issue] = chain('issues', [issueBody()])
  for (const mutate of [
    (body) => (body.collateralVault = OTHER_CV),
    (body) => (body.borrower = OTHER_BORROWER),
    (body) => (body.qRaw = '2'),
    (body) => (body.measurement.evidence.finalUsdePayout = 'paid'),
  ]) {
    const body = structuredClone(issueBody())
    mutate(body)
    const [changed] = chain('issues', [body])
    assert.throws(() => build({ issues: [changed], scores: [], attempts: [] }))
  }
  for (const mutate of [
    (body) => (body.issueSha256 = '0'.repeat(64)),
    (body) => (body.collateralVault = OTHER_CV),
    (body) => (body.borrower = OTHER_BORROWER),
    (body) => (body.outcome = 'pt_first_leg_simulated'),
    (body) => (body.measurement.evidence.finalUsdePayout = 'paid'),
  ]) {
    const body = scoreBody(issue, 1, 'restricted', 'credit_reserved')
    mutate(body)
    const [changed] = chain('scores', [body])
    assert.throws(() => build({ issues: [issue], scores: [changed], attempts: [] }))
  }
})

test('issue sequence and collateral vault remain part of the episode identity', () => {
  const [first, second] = chain('issues', [
    issueBody(),
    issueBody({ collateralVault: OTHER_CV, baselineNumber: 101, issuedAtUtc: clock(1) }),
  ])
  const { episodes } = build({ issues: [first, second], scores: [], attempts: [] })
  assert.equal(episodes.length, 8)
  assert.notEqual(episodes[0].holderCommitment, episodes[4].holderCommitment)
  assert.notEqual(episodes[0].issueClusterSha256, episodes[4].issueClusterSha256)
})

test('retrospective cutoff hides future Twyne issue and score before joins and diagnostics', () => {
  const [issue] = chain('issues', [issueBody()])
  const [score] = chain('scores', [scoreBody(issue, 1, 'pt_first_leg_simulated')])
  const ledger = { issues: [issue], scores: [score], attempts: [] }
  let featureJoins = 0
  const selectAsOfFeatures = () => {
    featureJoins++
    return { featureRefs: [], featureAbstentions: {} }
  }
  const beforeIssue = build(ledger, Date.parse(ISSUED) - 1, { selectAsOfFeatures })
  assert.equal(beforeIssue.episodes.length, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).issues, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.equal(featureJoins, 0)

  const atIssue = build(ledger, Date.parse(ISSUED), { selectAsOfFeatures })
  assert.equal(atIssue.episodes.length, 4)
  assert.equal(atIssue.diagnostics.get(subjectKey).issues, 1)
  assert.equal(atIssue.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.equal(featureJoins, 1)
  const hidden = build(ledger, Date.parse(score.scoredAtUtc) - 1).episodes[0]
  assert.equal(hidden.scoreSha256, null)
  assert.equal(hidden.observedAtUtc, null)
  assert.equal(hidden.rawScoreStatus, null)
  assert.equal(hidden.rawScoreOutcome, null)
  assert.equal(hidden.rawScoreMeasurementStatus, null)
  assert.equal(hidden.rawScoreReason, null)
  assert.equal(hidden.rawScoreBorrowerCommitment, null)
  assert.equal(hidden.rawScoreReturnedPtRaw, null)
  assert.deepEqual(hidden.outcome, { status: 'pending', reason: null })

  const atScore = build(ledger, Date.parse(score.scoredAtUtc))
  assert.equal(atScore.episodes[0].scoreSha256, score.sha256)
  assert.equal(atScore.episodes[0].observedAtUtc, score.scoredAtUtc)
  assert.equal(atScore.episodes[0].outcome.status, 'simulated_callable')
  assert.equal(atScore.diagnostics.get(subjectKey).scoredTargets, 1)
  assert.equal(atScore.diagnostics.get(subjectKey).measuredTargets, 1)
})

test('Twyne attempts count only when locally available and malformed future attempts fail', () => {
  const attempts = chain('attempts', [
    {
      phase: 'issue',
      reason: 'source_unavailable',
      atUtc: new Date(Date.parse(ISSUED) - 1_000).toISOString(),
    },
    { phase: 'score', reason: 'target_not_finalized', atUtc: clock(1) },
  ])
  const ledger = { issues: [], scores: [], attempts }
  assert.equal(build(ledger, Date.parse(ISSUED)).diagnostics.get(subjectKey).attempts, 1)
  assert.equal(build(ledger).diagnostics.get(subjectKey).attempts, 2)
  const malformed = chain('attempts', [
    { phase: 'score', reason: 'target_not_finalized', atUtc: 'invalid' },
  ])
  assert.throws(
    () => build({ issues: [], scores: [], attempts: malformed }, Date.parse(ISSUED)),
    /clock_invalid/,
  )
})

test('sealed hidden Twyne measured and censor blocks cannot postdate scoredAtUtc', () => {
  const [issue] = chain('issues', [issueBody()])
  const futureMeasured = scoreBody(issue, 1, 'pt_first_leg_simulated')
  futureMeasured.block.timestamp += 1
  futureMeasured.measurement.evidence.blockTimestamp = futureMeasured.block.timestamp
  const [measuredScore] = chain('scores', [futureMeasured])
  assert.throws(
    () =>
      build(
        { issues: [issue], scores: [measuredScore], attempts: [] },
        Date.parse(measuredScore.scoredAtUtc) - 1,
      ),
    /score_block_clock_invalid/,
  )
  const futureCensor = scoreBody(issue, 1, 'censored')
  futureCensor.block.timestamp += 1
  const [censorScore] = chain('scores', [futureCensor])
  assert.throws(
    () =>
      build(
        { issues: [issue], scores: [censorScore], attempts: [] },
        Date.parse(censorScore.scoredAtUtc) - 1,
      ),
    /score_block_clock_invalid/,
  )
})

test('a future Twyne missed-window seal leaves an earlier target missing', () => {
  const [issue] = chain('issues', [issueBody()])
  const [score] = chain('scores', [scoreBody(issue, 1, 'censored')])
  const ledger = { issues: [issue], scores: [score], attempts: [] }
  const beforeSeal = build(ledger, Date.parse(score.scoredAtUtc) - 1)
  assert.deepEqual(beforeSeal.episodes[0].outcome, {
    status: 'missing',
    reason: 'no_verified_score_after_deadline',
  })
  assert.equal(beforeSeal.episodes[0].scoreSha256, null)
  assert.equal(beforeSeal.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.equal(beforeSeal.diagnostics.get(subjectKey).missedWindowTargets, 0)
  const atSeal = build(ledger, Date.parse(score.scoredAtUtc))
  assert.equal(atSeal.episodes[0].outcome.status, 'censored')
  assert.equal(atSeal.diagnostics.get(subjectKey).missedWindowTargets, 1)
})

test('resealed hidden Twyne censor with an outcome is rejected before projection', () => {
  const [issue] = chain('issues', [issueBody()])
  const censored = { ...scoreBody(issue, 1, 'censored'), outcome: 'controller_changed' }
  const [score] = chain('scores', [censored])
  assert.throws(
    () =>
      build({ issues: [issue], scores: [score], attempts: [] }, Date.parse(score.scoredAtUtc) - 1),
    /score_censor_invalid/,
  )
})
