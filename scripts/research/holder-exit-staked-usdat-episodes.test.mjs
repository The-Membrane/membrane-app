import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  STAKED_USDAT_SUBJECT,
  buildStakedUsdatEpisodes,
  stakedUsdatBoardSubjects,
} from './holder-exit-staked-usdat-episodes.mjs'

const STUDY = 'carry_local_staked_usdat_holder_v2'
const SHARES_RAW = '10000000000000000000'
const HORIZONS_HOURS = [1, 4, 24, 48, 168]
const BASELINE_MS = Date.parse('2026-10-04T00:00:00.000Z')
const NOW = BASELINE_MS + 171 * 3_600_000
const HASH = `0x${'a'.repeat(64)}`
const VAULT_HASH = '0xec3b77f722a89eec23e7dfb2ddfe63e4d82f37adbc5f75a269ed2c82c3ad0300'
const QUEUE_HASH = '0x537d27c7b1574e4ab94867b9f5719414169c5941387346bca88b84643612256d'
const REGIME = {
  vaultImpl: '0x2b7074cf6681382b70e239063931ebe83c0f4e0a',
  vaultCodeHash: VAULT_HASH,
  queueImpl: '0xdaf6f8523d7a707d173a12041e1523fdf1373f23',
  queueCodeHash: QUEUE_HASH,
}
const subjectKey = `${STAKED_USDAT_SUBJECT.route_key}\0${STAKED_USDAT_SUBJECT.destination}\0${STAKED_USDAT_SUBJECT.asset}`
const manifest = { subjects: [STAKED_USDAT_SUBJECT] }
const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (row) => {
  const { sha256: _old, ...payload } = row
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}
const at = (ms) => new Date(ms).toISOString()

function issue(sequence = 1, outcome = 'success') {
  return seal({
    sequence,
    previousSha256: null,
    study: STUDY,
    kind: 'issue',
    routeKey: STAKED_USDAT_SUBJECT.route_key,
    destination: STAKED_USDAT_SUBJECT.destination,
    holder: `0x${String(sequence).padStart(40, '0')}`,
    sharesRaw: SHARES_RAW,
    issuedAtUtc: at(BASELINE_MS + 10 * 60_000),
    baseline: {
      number: 100,
      hash: HASH,
      parentHash: `0x${'b'.repeat(64)}`,
      timestamp: BASELINE_MS / 1_000,
    },
    selection: {
      samplingRule: 'first_reverting_eoa_else_first_callable',
      candidatesChecked: 1,
      eligibleTested: 1,
      discoverySource: 'example.org',
    },
    measurement: {
      sources: ['one.example', 'two.example'],
      regime: REGIME,
      outcome,
      ticketId: outcome === 'success' ? '42' : null,
      holderEoa: true,
      holderSharesRaw: SHARES_RAW,
      maxRedeemSharesRaw: SHARES_RAW,
      previewUsdatRaw: '9999999',
      vaultPaused: false,
      queuePaused: false,
      minSharePriceRaw: '0',
    },
    targets: HORIZONS_HOURS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: at(BASELINE_MS + horizonHours * 3_600_000),
      deadlineUtc: at(BASELINE_MS + (horizonHours + 2) * 3_600_000),
    })),
  })
}

function score(parent, horizonHours, outcome, options = {}) {
  const targetMs = BASELINE_MS + horizonHours * 3_600_000
  if (options.missed)
    return seal({
      sequence: options.sequence ?? 1,
      previousSha256: null,
      study: STUDY,
      kind: 'score',
      issueSequence: parent.sequence,
      issueSha256: parent.sha256,
      horizonHours,
      scoredAtUtc: at(targetMs + 2 * 3_600_000 + 1_000),
      status: 'missed_deadline',
      targetBlock: null,
      parentBlock: null,
      measurement: null,
      transition: 'missing',
    })
  const measurement =
    outcome === 'regime_changed'
      ? {
          sources: ['one.example', 'two.example'],
          regime: { ...REGIME, vaultImpl: `0x${'9'.repeat(40)}` },
          outcome,
        }
      : {
          sources: ['one.example', 'two.example'],
          regime: REGIME,
          outcome,
          holderEoa: options.holderEoa ?? true,
          holderSharesRaw: options.holderSharesRaw ?? SHARES_RAW,
          maxRedeemSharesRaw: options.maxRedeemSharesRaw ?? SHARES_RAW,
          previewUsdatRaw: '9999999',
          vaultPaused: false,
          queuePaused: false,
        }
  let transition
  if (outcome === 'regime_changed') transition = 'regime_change_censored'
  else if (!measurement.holderEoa || BigInt(measurement.holderSharesRaw) < BigInt(SHARES_RAW))
    transition = 'holder_attrition'
  else if (
    BigInt(measurement.maxRedeemSharesRaw) < BigInt(SHARES_RAW) ||
    outcome === 'not_attempted'
  )
    transition = 'request_unavailable'
  else if (parent.measurement.outcome === 'evm_revert')
    transition = outcome === 'success' ? 'simulated_call_recovery' : 'still_reverting'
  else transition = outcome === 'success' ? 'still_callable' : 'became_reverting'
  return seal({
    sequence: options.sequence ?? 1,
    previousSha256: null,
    study: STUDY,
    kind: 'score',
    issueSequence: parent.sequence,
    issueSha256: parent.sha256,
    horizonHours,
    scoredAtUtc: at(targetMs + 5 * 60_000),
    status: 'measured',
    targetBlock: {
      number: 110 + horizonHours,
      hash: `0x${'c'.repeat(64)}`,
      parentHash: `0x${'d'.repeat(64)}`,
      timestamp: targetMs / 1_000 + 12,
    },
    parentBlock: {
      number: 109 + horizonHours,
      hash: `0x${'d'.repeat(64)}`,
      parentHash: `0x${'e'.repeat(64)}`,
      timestamp: targetMs / 1_000 - 1,
    },
    measurement,
    transition,
  })
}

function run(issues = [], scores = [], options = {}) {
  return buildStakedUsdatEpisodes({
    manifest: options.manifest ?? manifest,
    ledger: options.ledger ?? { issues, scores, attempts: [] },
    featuresBySubject: options.featuresBySubject ?? new Map(),
    selectAsOfFeatures:
      options.selectAsOfFeatures ?? (() => ({ featureRefs: [], featureAbstentions: {} })),
    nowMs: options.nowMs ?? NOW,
  })
}

test('exact subject and five frozen share-Q horizons retain source hashes and plan clocks', () => {
  const parent = issue()
  const observed = score(parent, 1, 'success')
  const result = run([parent], [observed], { nowMs: BASELINE_MS + 90 * 60_000 })
  assert.equal(stakedUsdatBoardSubjects(manifest).get(subjectKey), STAKED_USDAT_SUBJECT)
  assert.equal(result.episodes.length, 5)
  assert.deepEqual(
    result.episodes.map((row) => row.plannedHorizonHours),
    HORIZONS_HOURS,
  )
  const first = result.episodes[0]
  assert.equal(first.stageScope, 'staked_usdat_redeem_eth_call')
  assert.equal(first.fullRoutePaidProofSha256, null)
  assert.equal(first.issueSha256, parent.sha256)
  assert.equal(first.scoreSha256, observed.sha256)
  assert.equal(first.holderCommitment, sha(`${STAKED_USDAT_SUBJECT.destination}:${parent.holder}`))
  assert.equal(first.qRaw, SHARES_RAW)
  assert.equal(first.qUnit, 'stUSDat_shares')
  assert.equal(first.targetAtUtc, parent.targets[0].targetAtUtc)
  assert.equal(first.deadlineAtUtc, parent.targets[0].deadlineUtc)
  assert.equal(first.targetClockBasis, 'baseline_block_timestamp_plan')
  assert.equal(first.rawTransition, 'still_callable')
  assert.deepEqual(first.outcome, { status: 'simulated_callable', reason: null })
  assert.equal(first.analysisPrimaryForCell, false)
  assert.equal(first.forecastEligible, false)
  assert.deepEqual(
    result.episodes.slice(1).map((row) => row.outcome.status),
    ['pending', 'pending', 'pending', 'pending'],
  )
})

test('retrospective cutoff hides future issues, scores, raw fields, and diagnostic counts', () => {
  const parent = issue()
  const scores = [1, 4, 24].map((horizon, index) =>
    score(parent, horizon, 'success', { sequence: index + 1 }),
  )
  let featureJoins = 0
  const selectAsOfFeatures = () => {
    featureJoins++
    return { featureRefs: [], featureAbstentions: {} }
  }
  const beforeIssue = run([parent], scores, {
    nowMs: BASELINE_MS + 10 * 60_000 - 1,
    selectAsOfFeatures,
  })
  assert.equal(beforeIssue.episodes.length, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).issues, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.equal(featureJoins, 0)

  const beforeScores = run([parent], scores, {
    nowMs: BASELINE_MS + 15 * 60_000,
    selectAsOfFeatures,
  })
  assert.equal(featureJoins, 1)
  assert.equal(beforeScores.episodes.length, HORIZONS_HOURS.length)
  assert.ok(beforeScores.episodes.every((row) => row.scoreSha256 === null))
  assert.ok(beforeScores.episodes.every((row) => row.observedAtUtc === null))
  assert.ok(beforeScores.episodes.every((row) => row.rawScoreStatus === null))
  assert.ok(beforeScores.episodes.every((row) => row.rawScoreOutcome === null))
  assert.ok(beforeScores.episodes.every((row) => row.rawTransition === null))
  assert.ok(beforeScores.episodes.every((row) => row.outcome.status === 'pending'))
  assert.equal(beforeScores.diagnostics.get(subjectKey).issues, 1)
  assert.equal(beforeScores.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.equal(beforeScores.diagnostics.get(subjectKey).pendingTargets, 5)

  const firstScoreAt = BASELINE_MS + 65 * 60_000
  const atFirstScore = run([parent], scores, { nowMs: firstScoreAt })
  assert.equal(atFirstScore.episodes[0].scoreSha256, scores[0].sha256)
  assert.equal(atFirstScore.episodes[0].rawTransition, 'still_callable')
  assert.equal(atFirstScore.episodes[1].scoreSha256, null)
  assert.equal(atFirstScore.diagnostics.get(subjectKey).scoredTargets, 1)
  assert.equal(atFirstScore.diagnostics.get(subjectKey).measuredTargets, 1)

  const current = run([parent], scores)
  assert.equal(current.diagnostics.get(subjectKey).scoredTargets, 3)
  assert.equal(current.diagnostics.get(subjectKey).measuredTargets, 3)
  assert.throws(
    () =>
      run([parent], [seal({ ...scores[1], transition: 'became_reverting' })], {
        nowMs: BASELINE_MS + 15 * 60_000,
      }),
    /score_measurement_invalid/,
  )
  assert.throws(
    () =>
      run([seal({ ...parent, sharesRaw: '1' })], [], {
        nowMs: BASELINE_MS + 10 * 60_000 - 1,
      }),
    /issue_identity_invalid/,
  )
})

test('attempt diagnostics count only completed local records available by the cutoff', () => {
  const attempts = [
    seal({ startedAtUtc: at(BASELINE_MS), finishedAtUtc: at(BASELINE_MS + 5_000) }),
    seal({ startedAtUtc: at(BASELINE_MS + 10_000), finishedAtUtc: at(BASELINE_MS + 20_000) }),
  ]
  const ledger = { issues: [], scores: [], attempts }
  assert.equal(
    run([], [], { ledger, nowMs: BASELINE_MS + 15_000 }).diagnostics.get(subjectKey).attempts,
    1,
  )
  assert.equal(run([], [], { ledger }).diagnostics.get(subjectKey).attempts, 2)
  assert.throws(
    () =>
      run([], [], { ledger: { ...ledger, attempts: [{ ...attempts[1], finishedAtUtc: 'bad' }] } }),
    /attempt_unsealed/,
  )
})

test('a future missed-deadline seal does not censor an earlier missing target', () => {
  const parent = issue()
  const missed = score(parent, 1, null, { missed: true })
  const beforeSeal = run([parent], [missed], {
    nowMs: Date.parse(missed.scoredAtUtc) - 1,
  })
  assert.deepEqual(beforeSeal.episodes[0].outcome, {
    status: 'missing',
    reason: 'no_verified_score_after_deadline',
  })
  assert.equal(beforeSeal.episodes[0].scoreSha256, null)
  assert.equal(beforeSeal.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.equal(beforeSeal.diagnostics.get(subjectKey).missedDeadlineTargets, 0)
  const afterSeal = run([parent], [missed], { nowMs: Date.parse(missed.scoredAtUtc) })
  assert.equal(afterSeal.episodes[0].outcome.status, 'censored')
  assert.equal(afterSeal.diagnostics.get(subjectKey).missedDeadlineTargets, 1)
})

test('baseline generic revert stays unknown even after a simulated call recovery', () => {
  const parent = issue(2, 'evm_revert')
  const observed = score(parent, 1, 'success')
  const first = run([parent], [observed]).episodes[0]
  assert.equal(first.baseline, 'inconclusive')
  assert.equal(first.baselineReason, 'revert_cause_unknown')
  assert.equal(first.rawTransition, 'simulated_call_recovery')
  assert.deepEqual(first.outcome, {
    status: 'not_at_risk',
    reason: 'baseline_revert_cause_unknown',
  })
})

test('missing, missed, attrition, request unavailable and regime change stay distinct', () => {
  const parent = issue()
  const scores = [
    score(parent, 1, null, { missed: true, sequence: 1 }),
    score(parent, 4, 'not_attempted', { holderSharesRaw: '0', sequence: 2 }),
    score(parent, 24, 'regime_changed', { sequence: 3 }),
    score(parent, 48, 'not_attempted', { maxRedeemSharesRaw: '0', sequence: 4 }),
  ]
  const result = run([parent], scores)
  assert.deepEqual(
    result.episodes.map((row) => row.outcome),
    [
      { status: 'censored', reason: 'capture_window_missed' },
      { status: 'censored', reason: 'holder_attrition' },
      { status: 'censored', reason: 'regime_changed' },
      { status: 'censored', reason: 'request_unavailable' },
      { status: 'missing', reason: 'no_verified_score_after_deadline' },
    ],
  )
  assert.deepEqual(
    result.episodes.map((row) => row.rawTransition),
    ['missing', 'holder_attrition', 'regime_change_censored', 'request_unavailable', null],
  )
  assert.deepEqual(result.diagnostics.get(subjectKey), {
    issues: 1,
    scoredTargets: 4,
    measuredTargets: 3,
    missedDeadlineTargets: 1,
    pendingTargets: 0,
    missingTargets: 1,
    holderAttritionCensors: 1,
    regimeChangeCensors: 1,
    requestUnavailableCensors: 1,
    attempts: 0,
  })
  const reverted = score(parent, 1, 'evm_revert')
  assert.deepEqual(run([parent], [reverted]).episodes[0].outcome, {
    status: 'inconclusive',
    reason: 'revert_cause_unknown',
  })
})

test('features are selected as of the issue baseline, not a later score', () => {
  const parent = issue()
  const features = [{ kind: 'historical_preissue' }]
  let called = 0
  const first = run([parent], [], {
    featuresBySubject: new Map([[subjectKey, features]]),
    selectAsOfFeatures: (input, subject, selectedIssue, context) => {
      called++
      assert.equal(input, features)
      assert.equal(subject, STAKED_USDAT_SUBJECT)
      assert.equal(selectedIssue, parent)
      assert.equal(context.baseline.targetBlock, '100')
      assert.equal(context.baseline.targetHash, HASH)
      return { featureRefs: features, featureAbstentions: { late_first_local_receipt: 1 } }
    },
  }).episodes[0]
  assert.equal(called, 1)
  assert.equal(first.featureRefs, features)
  assert.equal(first.featureAbstentions.late_first_local_receipt, 1)
})

test('rejects sealed wrong-Q/subject, score rewrite, false transition, duplicate and orphan cells', () => {
  const parent = issue()
  const observed = score(parent, 1, 'success')
  assert.throws(() => run([seal({ ...parent, sharesRaw: '1' })]), /issue_identity_invalid/)
  assert.throws(
    () => run([seal({ ...parent, routeKey: 'another route' })]),
    /issue_identity_invalid/,
  )
  assert.throws(
    () => run([parent], [{ ...observed, transition: 'became_reverting' }]),
    /unsealed_score/,
  )
  assert.throws(
    () => run([parent], [seal({ ...observed, transition: 'became_reverting' })]),
    /score_measurement_invalid/,
  )
  assert.throws(() => run([parent], [observed, observed]), /score_duplicate/)
  assert.throws(() => run([], [observed]), /orphan_or_unsealed_score/)
  assert.throws(
    () =>
      run([parent], [observed], {
        ledger: { issues: [parent], scores: [observed], attempts: [], orphanScores: 1 },
      }),
    /ledger_limit_or_orphans/,
  )
  assert.throws(
    () => stakedUsdatBoardSubjects({ subjects: [STAKED_USDAT_SUBJECT, STAKED_USDAT_SUBJECT] }),
    /frozen_subject_invalid/,
  )
})

test('frozen identity, fixed Q, horizons and transition labels match the source reader', () => {
  const readerUrl = new URL('./carry-local-staked-usdat-holder.mjs', import.meta.url).href
  const contractUrl = new URL('../../lib/carry/stakedUsdatExit.ts', import.meta.url).href
  const script = `
    const reader = await import(${JSON.stringify(readerUrl)});
    const imported = await import(${JSON.stringify(contractUrl)});
    const contract = imported.default ?? imported;
    const q = reader.SHARES_RAW;
    const ok = {outcome:'success', holderEoa:true, holderSharesRaw:q, maxRedeemSharesRaw:q};
    const a = {measurement:{outcome:'success'}};
    const b = {measurement:{outcome:'evm_revert'}};
    const classify = (parent, value={}) => reader.classifyTransition(parent,{...ok,...value});
    console.log(JSON.stringify({
      subject:{route_key:contract.STAKED_USDAT_ROUTE,destination:contract.STAKED_USDAT_VAULT,asset:contract.USDAT_ASSET},
      regime:{vaultImpl:contract.STAKED_USDAT_IMPLEMENTATION,vaultCodeHash:contract.STAKED_USDAT_IMPLEMENTATION_CODE_HASH,queueImpl:contract.STAKED_USDAT_QUEUE_IMPLEMENTATION,queueCodeHash:contract.STAKED_USDAT_QUEUE_IMPLEMENTATION_CODE_HASH},
      study:reader.STUDY, sharesRaw:q, horizons:reader.HORIZONS_HOURS,
      transitions:[
        classify(a), classify(a,{outcome:'evm_revert'}), classify(b),
        classify(b,{outcome:'evm_revert'}), classify(a,{holderSharesRaw:'0'}),
        classify(a,{maxRedeemSharesRaw:'0'}), classify(a,{outcome:'regime_changed'})
      ]
    }));
  `
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 32 * 1024,
    },
  )
  assert.equal(child.status, 0, child.stderr)
  const source = JSON.parse(child.stdout)
  assert.deepEqual(source.subject, STAKED_USDAT_SUBJECT)
  assert.deepEqual(source.regime, REGIME)
  assert.equal(source.study, STUDY)
  assert.equal(source.sharesRaw, SHARES_RAW)
  assert.deepEqual(source.horizons, HORIZONS_HOURS)
  assert.deepEqual(source.transitions, [
    'still_callable',
    'became_reverting',
    'simulated_call_recovery',
    'still_reverting',
    'holder_attrition',
    'request_unavailable',
    'regime_change_censored',
  ])
})

test('small sealed local replay projects only verified episodes with no provider call', async () => {
  const { verifyAll } = await import('./carry-local-staked-usdat-holder.mjs')
  const ledger = await verifyAll(false)
  const result = run([], [], { ledger, nowMs: Date.now() })
  assert.equal(result.episodes.length, ledger.issues.length * HORIZONS_HOURS.length)
  assert.equal(result.diagnostics.get(subjectKey).scoredTargets, ledger.scores.length)
  assert.ok(result.episodes.every((row) => row.fullRoutePaidProofSha256 === null))
  assert.ok(result.episodes.every((row) => row.forecastEligible === false))
})
