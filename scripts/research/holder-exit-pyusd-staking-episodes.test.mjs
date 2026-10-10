import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  PYUSD_STAKING_SUBJECT,
  buildPyUsdStakingEpisodes,
  pyUsdStakingBoardSubjects,
} from './holder-exit-pyusd-staking-episodes.mjs'

const ROUTE = PYUSD_STAKING_SUBJECT.route_key
const PRIME = PYUSD_STAKING_SUBJECT.destination
const WYLDS = PYUSD_STAKING_SUBJECT.asset
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const STUDY = 'pyusd_staking_prime_prospective_v1'
const ASSESSMENT = 'first_stage_only_usdc_pyusd_unassessed'
const HOLDER = `0x${'a'.repeat(40)}`
const HORIZONS = [1, 4, 24, 48, 168]
const ISSUED = '2026-10-01T06:00:00.000Z'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const blockHash = (number) => `0x${number.toString(16).padStart(64, '0')}`
const clock = (hours) => new Date(Date.parse(ISSUED) + hours * 3_600_000).toISOString()
const seal = (body) => ({ ...body, sha256: hash(JSON.stringify(body)) })
const chain = (kind, rows) => {
  let prior = null
  return rows.map((row, index) => {
    const result = seal({ ...row, study: STUDY, kind, sequence: index + 1, previousSha256: prior })
    prior = result.sha256
    return result
  })
}
const assay = (stage = 'prime_to_wylds_callable', shares = '20') => ({
  holder: HOLDER,
  qRaw: '10',
  primeSharesRaw: shares,
  maxRedeemRaw: '20',
  previewWyldsRaw: '11',
  simulatedWyldsRaw:
    stage === 'prime_to_wylds_callable'
      ? '11'
      : stage === 'redeem_reverted' || stage === 'insufficient_prime_shares'
        ? null
        : '0',
  stakingPaused: false,
  stakingFrozen: false,
  stage,
  yieldStage: {
    requestAssessed: false,
    completion: 'admin_gated_unassessed',
    usdcPayout: 'not_attested',
  },
  pyusdPayout: 'not_attested',
})
const snapshot = (number, assayValue) => ({
  chainId: 1,
  routeKey: ROUTE,
  destination: PRIME,
  blockNumber: String(number),
  blockHash: blockHash(number),
  blockTimestamp: Math.floor(Date.parse(ISSUED) / 1_000) + (number - 100) * 3_600,
  identity: {
    primeAsset: WYLDS,
    yieldAsset: USDC,
    primeDecimals: 6,
    yieldDecimals: 6,
    usdcDecimals: 6,
    pyusdDecimals: 6,
  },
  assay: assayValue,
  finalPayout: 'unassessed',
  pyusdConversion: 'not_attested',
})
const manifest = () => ({ subjects: [{ ...PYUSD_STAKING_SUBJECT }] })
const subjectKey = `${ROUTE}\0${PRIME}\0${WYLDS}`
const issueBody = () => ({
  routeKey: ROUTE,
  destination: PRIME,
  holder: HOLDER,
  qRaw: '10',
  issuedAtUtc: ISSUED,
  baseline: {
    ...snapshot(100, assay()),
    blockTimestamp: Math.floor(Date.parse(ISSUED) / 1_000) - 60,
  },
  targets: HORIZONS.map((horizonHours) => ({
    horizonHours,
    targetAtUtc: clock(horizonHours),
    deadlineAtUtc: clock(horizonHours + 2),
  })),
  payoutAssessment: ASSESSMENT,
})
const scoreBody = (issue, horizonHours, stage, status = 'measured') => {
  const plan = issue.targets.find((target) => target.horizonHours === horizonHours)
  const target =
    status === 'measured'
      ? {
          number: String(100 + horizonHours),
          hash: blockHash(100 + horizonHours),
          timestamp: Math.floor(Date.parse(plan.targetAtUtc) / 1_000),
        }
      : null
  const assayValue = stage === 'insufficient_prime_shares' ? assay(stage, '9') : assay(stage)
  return {
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    horizonHours,
    targetAtUtc: plan.targetAtUtc,
    deadlineAtUtc: plan.deadlineAtUtc,
    scoredAtUtc: status === 'measured' ? plan.targetAtUtc : clock(horizonHours + 3),
    status,
    target,
    measurement:
      status === 'measured'
        ? {
            ...snapshot(100 + horizonHours, assayValue),
            blockTimestamp: target.timestamp,
          }
        : null,
    deadlineWitness:
      status === 'measured'
        ? null
        : {
            origins: ['https://one.example', 'https://two.example'],
            heads: [
              {
                number: '200',
                hash: blockHash(200),
                parentHash: blockHash(199),
                timestamp: Date.parse(clock(horizonHours + 3)) / 1_000,
              },
              {
                number: '200',
                hash: blockHash(200),
                parentHash: blockHash(199),
                timestamp: Date.parse(clock(horizonHours + 3)) / 1_000,
              },
            ],
            commonHeaders: [
              {
                number: '200',
                hash: blockHash(200),
                parentHash: blockHash(199),
                timestamp: Date.parse(clock(horizonHours + 3)) / 1_000,
              },
              {
                number: '200',
                hash: blockHash(200),
                parentHash: blockHash(199),
                timestamp: Date.parse(clock(horizonHours + 3)) / 1_000,
              },
            ],
          },
    payoutAssessment: ASSESSMENT,
  }
}
const build = (ledger, nowMs = Date.parse(clock(49)), other = {}) =>
  buildPyUsdStakingEpisodes({
    manifest: manifest(),
    ledger,
    featuresBySubject: new Map(),
    selectAsOfFeatures: () => ({ featureRefs: [], featureAbstentions: {} }),
    nowMs,
    ...other,
  })

test('exact frozen subject binds wYLDS as asset and rejects PYUSD', () => {
  assert.equal(Object.isFrozen(PYUSD_STAKING_SUBJECT), true)
  assert.equal(pyUsdStakingBoardSubjects(manifest()).get(subjectKey).asset, WYLDS)
  assert.throws(
    () =>
      pyUsdStakingBoardSubjects({
        subjects: [
          { ...PYUSD_STAKING_SUBJECT, asset: '0x6c3ea9036406852006290770bedfcaba0e23a0e8' },
        ],
      }),
    /frozen_subject_invalid/,
  )
})

test('one holder and Q yields five first-stage cells with distinct score states', () => {
  const [issue] = chain('issues', [issueBody()])
  const scores = chain('scores', [
    scoreBody(issue, 1, 'prime_to_wylds_callable'),
    scoreBody(issue, 4, null, 'missed_window'),
    scoreBody(issue, 24, 'insufficient_prime_shares'),
    scoreBody(issue, 48, 'redeem_reverted'),
  ])
  const ledger = { issues: [issue], scores, attempts: [] }
  const { episodes, diagnostics } = build(ledger)
  assert.deepEqual(
    episodes.map(({ outcome }) => [outcome.status, outcome.reason]),
    [
      ['simulated_callable', null],
      ['censored', 'capture_window_missed'],
      ['censored', 'holder_attrition'],
      ['inconclusive', 'revert_cause_unknown'],
      ['pending', null],
    ],
  )
  assert.equal(build(ledger, Date.parse(clock(171))).episodes[4].outcome.status, 'missing')
  assert.equal(episodes[0].issueSha256, issue.sha256)
  assert.equal(episodes[0].scoreSha256, scores[0].sha256)
  assert.equal(episodes[0].qRaw, '10')
  assert.equal(episodes[0].holderCommitment, hash(`${PRIME}:${HOLDER}`))
  assert.equal(episodes[0].targetAtUtc, clock(1))
  assert.equal(episodes[0].deadlineAtUtc, clock(3))
  assert.equal(episodes[0].rawScoreStage, 'prime_to_wylds_callable')
  assert.equal(episodes[3].rawScoreStage, 'redeem_reverted')
  assert.ok(episodes.every((row) => row.stageScope === 'pyusd_staking_first_stage_eth_call'))
  assert.ok(episodes.every((row) => row.payoutAssessment === ASSESSMENT))
  assert.ok(episodes.every((row) => row.fullRoutePaidProofSha256 === null))
  assert.ok(episodes.every((row) => row.finalPayout === 'unassessed'))
  assert.ok(episodes.every((row) => row.forecastEligible === false))
  assert.equal(diagnostics.get(subjectKey).holderAttritionCensors, 1)
  assert.equal(diagnostics.get(subjectKey).missedWindowTargets, 1)
})

test('PyUSD issue, score, and attempt facts enter at their local availability clocks', () => {
  const [issue] = chain('issues', [issueBody()])
  const [score] = chain('scores', [scoreBody(issue, 1, 'prime_to_wylds_callable')])
  const [attempt] = chain('attempts', [
    { action: 'issue', status: 'retry', reason: 'pyusd_retry', atUtc: ISSUED },
  ])
  const selected = []
  const at = (nowMs, scoreRows = [score], attemptRows = [attempt]) =>
    build({ issues: [issue], scores: scoreRows, attempts: attemptRows }, nowMs, {
      selectAsOfFeatures: (_features, _subject, row) => {
        selected.push(row.sha256)
        return { featureRefs: [], featureAbstentions: {} }
      },
    })
  const beforeIssue = at(Date.parse(ISSUED) - 1)
  assert.equal(beforeIssue.episodes.length, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).issues, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).attempts, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.deepEqual(selected, [])
  const atIssue = at(Date.parse(ISSUED))
  assert.equal(atIssue.episodes.length, HORIZONS.length)
  assert.equal(atIssue.diagnostics.get(subjectKey).issues, 1)
  assert.equal(atIssue.diagnostics.get(subjectKey).attempts, 1)
  assert.deepEqual(selected, [issue.sha256])
  const beforeScore = at(Date.parse(score.scoredAtUtc) - 1)
  assert.equal(beforeScore.episodes[0].outcome.status, 'pending')
  assert.equal(beforeScore.episodes[0].scoreSha256, null)
  assert.equal(beforeScore.episodes[0].observedAtUtc, null)
  assert.equal(beforeScore.episodes[0].rawScoreStatus, null)
  assert.equal(beforeScore.episodes[0].rawScoreStage, null)
  assert.equal(beforeScore.episodes[0].rawScorePrimeSharesRaw, null)
  assert.equal(beforeScore.diagnostics.get(subjectKey).scoredTargets, 0)
  const atScore = at(Date.parse(score.scoredAtUtc))
  assert.equal(atScore.episodes[0].scoreSha256, score.sha256)
  assert.equal(atScore.episodes[0].rawScoreStage, 'prime_to_wylds_callable')
  assert.equal(atScore.diagnostics.get(subjectKey).scoredTargets, 1)
  const [badClock] = chain('scores', [
    { ...scoreBody(issue, 1, 'prime_to_wylds_callable'), scoredAtUtc: 'invalid' },
  ])
  assert.throws(() => at(Date.parse(ISSUED) - 1, [badClock]), /clock_invalid/)
  const [badBinding] = chain('scores', [
    { ...scoreBody(issue, 1, 'prime_to_wylds_callable'), issueSha256: 'f'.repeat(64) },
  ])
  assert.throws(() => at(Date.parse(ISSUED) - 1, [badBinding]), /score_binding_invalid/)
  const futureMeasuredBlock = scoreBody(issue, 1, 'prime_to_wylds_callable')
  futureMeasuredBlock.target.timestamp++
  futureMeasuredBlock.measurement.blockTimestamp = futureMeasuredBlock.target.timestamp
  const [futureMeasuredScore] = chain('scores', [futureMeasuredBlock])
  assert.throws(() => at(Date.parse(ISSUED) - 1, [futureMeasuredScore]), /measured_target_invalid/)
  const futureHead = scoreBody(issue, 1, null, 'missed_window')
  futureHead.deadlineWitness.heads[1].timestamp++
  const [futureHeadScore] = chain('scores', [futureHead])
  assert.throws(() => at(Date.parse(ISSUED) - 1, [futureHeadScore]), /missed_window_invalid/)
  const futureCommonHeader = scoreBody(issue, 1, null, 'missed_window')
  futureCommonHeader.deadlineWitness.commonHeaders[1].timestamp++
  const [futureCommonScore] = chain('scores', [futureCommonHeader])
  assert.throws(() => at(Date.parse(ISSUED) - 1, [futureCommonScore]), /missed_window_invalid/)
  const [badAttempt] = chain('attempts', [
    { action: 'issue', status: 'invented', reason: null, atUtc: ISSUED },
  ])
  assert.throws(() => at(Date.parse(ISSUED) - 1, [score], [badAttempt]), /attempt_invalid/)
})

test('baseline covered revert remains inconclusive and not at risk', () => {
  const body = issueBody()
  body.baseline.assay = assay('redeem_reverted')
  const [issue] = chain('issues', [body])
  const [score] = chain('scores', [scoreBody(issue, 1, 'prime_to_wylds_callable')])
  const [episode] = build({ issues: [issue], scores: [score], attempts: [] }).episodes
  assert.equal(episode.baseline, 'inconclusive')
  assert.equal(episode.baselineReason, 'revert_cause_unknown')
  assert.deepEqual(episode.outcome, {
    status: 'not_at_risk',
    reason: 'baseline_revert_cause_unknown',
  })
})

test('a noncallable baseline never enters the pending or missed risk set', () => {
  const body = issueBody()
  body.baseline.assay = assay('redeem_reverted')
  const [issue] = chain('issues', [body])
  const [missed] = chain('scores', [scoreBody(issue, 1, null, 'missed_window')])
  const { episodes } = build(
    { issues: [issue], scores: [missed], attempts: [] },
    Date.parse(clock(171)),
  )
  assert.ok(
    episodes.every(
      (row) =>
        row.outcome.status === 'not_at_risk' &&
        row.outcome.reason === 'baseline_revert_cause_unknown',
    ),
  )
  assert.equal(episodes[0].rawScoreStatus, 'missed_window')
})

test('rebinding a sealed score to a different issue or target is rejected', () => {
  const [issue] = chain('issues', [issueBody()])
  const score = scoreBody(issue, 1, 'prime_to_wylds_callable')
  for (const mutate of [
    (row) => (row.issueSha256 = '0'.repeat(64)),
    (row) => (row.targetAtUtc = clock(2)),
    (row) => (row.measurement.assay.qRaw = '11'),
  ]) {
    const copy = structuredClone(score)
    mutate(copy)
    const [sealedScore] = chain('scores', [copy])
    assert.throws(
      () => build({ issues: [issue], scores: [sealedScore], attempts: [] }),
      /score_binding_invalid|assay_invalid/,
    )
  }
})

test('sealed source rows cannot be projected as paid USDC or PYUSD', () => {
  for (const mutate of [
    (body) => (body.baseline.assay.yieldStage.usdcPayout = 'paid'),
    (body) => (body.baseline.assay.pyusdPayout = 'paid'),
    (body) => (body.baseline.pyusdConversion = 'attested'),
    (body) => (body.baseline.finalPayout = 'paid'),
    (body) => (body.baseline.assay.simulatedWyldsRaw = null),
  ]) {
    const body = issueBody()
    mutate(body)
    const [issue] = chain('issues', [body])
    assert.throws(
      () => build({ issues: [issue], scores: [], attempts: [] }),
      /assay_invalid|snapshot_invalid|stage_inconsistent/,
    )
  }
  const [issue] = chain('issues', [issueBody()])
  for (const mutate of [
    (body) => (body.measurement.assay.yieldStage.usdcPayout = 'paid'),
    (body) => (body.measurement.assay.pyusdPayout = 'paid'),
    (body) => (body.measurement.pyusdConversion = 'attested'),
    (body) => (body.measurement.finalPayout = 'paid'),
  ]) {
    const body = scoreBody(issue, 1, 'prime_to_wylds_callable')
    mutate(body)
    const [score] = chain('scores', [body])
    assert.throws(
      () => build({ issues: [issue], scores: [score], attempts: [] }),
      /assay_invalid|snapshot_invalid/,
    )
  }
})
