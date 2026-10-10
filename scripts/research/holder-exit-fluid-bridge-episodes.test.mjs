import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  FLUID_BRIDGE_SUBJECTS,
  buildFluidBridgeEpisodes,
  fluidBridgeBoardSubjects,
} from './holder-exit-fluid-bridge-episodes.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const hash = (letter) => `0x${letter.repeat(64)}`
const HOLDER = `0x${'1'.repeat(40)}`
const USDC = FLUID_BRIDGE_SUBJECTS[0].asset
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const VAULT = FLUID_BRIDGE_SUBJECTS[0].destination
const BASELINE_AT = '2026-10-04T00:00:00.000Z'
const ISSUE_AT = '2026-10-04T00:10:00.000Z'
const HORIZONS = [1, 4, 24, 48, 168]
const study = (lane) => `carry_fluid_bridge_${lane}_holder_v1`
const route = (lane) => FLUID_BRIDGE_SUBJECTS[lane === 'usdc' ? 0 : 1]
const subjectKey = (subject) => `${subject.route_key}\0${subject.destination}\0${subject.asset}`
const seal = (row) => ({ ...row, sha256: sha(JSON.stringify(row)) })
const reseal = (row) => {
  const { sha256: _old, ...body } = row
  return seal(body)
}
const qLadder = (max) =>
  [...new Set([1n, 10n, 25n, 50n, 100n].map((pct) => (BigInt(max) * pct) / 100n))]
    .filter((q) => q > 0n)
    .map(String)

function measurement(lane, qRaw, status = 'success', options = {}) {
  return {
    blockNumber: options.blockNumber ?? 100,
    blockHash: options.blockHash ?? hash('a'),
    assayOwner: HOLDER,
    routeKey: route(lane).route_key,
    vault: {
      address: VAULT,
      assetAddress: USDC,
      assetDecimals: 6,
      kind: lane === 'usdt' ? 'fluid_bridge_usdc_first_leg' : 'fluid_bridge_usdc',
    },
    position: {
      holderSharesRaw: status === 'position_insufficient' ? '0' : '100000',
      maxWithdrawAssetsRaw: '10000',
    },
    request: { assetsRaw: qRaw, assetUnit: 'USDC' },
    ...(lane === 'usdt'
      ? {
          routeLeg: {
            checked: 'same_holder_usdc_vault_withdrawal_simulation',
            usdcToUsdtConversion: 'unassessed',
            usdtReceipt: 'unassessed',
          },
        }
      : {}),
    simulation:
      status === 'success'
        ? { status, sharesBurnedRaw: '1000' }
        : status === 'evm_revert'
          ? {
              status,
              reason: 'unknown_execution_constraint',
              holderCoverage: 'preview_covered_not_proven',
            }
          : { status, reason: 'holder_has_no_shares' },
  }
}

function issue(lane, options = {}) {
  const qRaw = qLadder(options.maxWithdrawRaw ?? '10000')
  const issueMs = Date.parse(ISSUE_AT)
  return seal({
    study: study(lane),
    kind: 'issues',
    sequence: 1,
    previousSha256: null,
    routeKey: route(lane).route_key,
    destination: VAULT,
    asset: USDC,
    ...(lane === 'usdt' ? { finalAsset: USDT } : {}),
    holder: HOLDER,
    candidate: { holder: HOLDER, maxWithdrawRaw: options.maxWithdrawRaw ?? '10000' },
    qRaw,
    issuedAtUtc: ISSUE_AT,
    baseline: {
      blockNumber: 100,
      blockHash: hash('a'),
      blockTimestamp: Date.parse(BASELINE_AT) / 1000,
      cases: qRaw.map((q, index) => ({
        qRaw: q,
        measurement: measurement(lane, q, options.baselineStatuses?.[index] ?? 'success'),
      })),
    },
    targets: HORIZONS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(issueMs + horizonHours * 3_600_000).toISOString(),
      deadlineAtUtc: new Date(issueMs + (horizonHours + 2) * 3_600_000).toISOString(),
    })),
    payoutAssessment:
      lane === 'usdt' ? 'usdc_first_leg_only_usdt_unassessed' : 'first_leg_simulation_only',
  })
}

function score(lane, parent, options = {}) {
  const target = parent.targets[0]
  const missed = options.status === 'missed_window'
  return seal({
    study: study(lane),
    kind: 'scores',
    sequence: 1,
    previousSha256: null,
    issueSequence: parent.sequence,
    issueSha256: parent.sha256,
    horizonHours: 1,
    targetAtUtc: target.targetAtUtc,
    deadlineAtUtc: target.deadlineAtUtc,
    holder: HOLDER,
    qRaw: parent.qRaw,
    scoredAtUtc: missed ? '2026-10-04T03:11:00.000Z' : '2026-10-04T01:11:00.000Z',
    payoutAssessment: parent.payoutAssessment,
    status: missed ? 'missed_window' : 'measured',
    block: {
      number: 101,
      hash: hash('b'),
      timestamp:
        Date.parse(missed ? '2026-10-04T03:11:00.000Z' : '2026-10-04T01:10:00.000Z') / 1000,
    },
    cases: missed
      ? null
      : parent.qRaw.map((q, index) => {
          const status = options.statuses?.[index] ?? 'success'
          return {
            qRaw: q,
            outcome:
              status === 'unavailable'
                ? 'unavailable'
                : status === 'success'
                  ? 'simulated_success'
                  : 'simulated_revert',
            measurement:
              status === 'unavailable'
                ? null
                : measurement(lane, q, status, { blockNumber: 101, blockHash: hash('b') }),
          }
        }),
  })
}

function attempt(lane, reason = 'no_holder') {
  return seal({
    study: study(lane),
    kind: 'attempts',
    sequence: 1,
    previousSha256: null,
    phase: 'issue',
    reason,
    atUtc: ISSUE_AT,
  })
}

const manifest = { subjects: [...FLUID_BRIDGE_SUBJECTS] }
function run({
  usdc = {},
  usdt = {},
  nowMs = Date.parse('2026-10-04T01:30:00.000Z'),
  select,
} = {}) {
  return buildFluidBridgeEpisodes({
    manifest,
    routeLedgers: [
      { lane: 'usdc', ledger: { issues: [], scores: [], attempts: [], ...usdc } },
      { lane: 'usdt', ledger: { issues: [], scores: [], attempts: [], ...usdt } },
    ],
    featuresBySubject: new Map(),
    selectAsOfFeatures: select ?? (() => ({ featureRefs: [], featureAbstentions: {} })),
    nowMs,
  })
}

test('two frozen exact subjects; no-holder attempts and omitted Q are diagnostics only', () => {
  const tiny = issue('usdc', { maxWithdrawRaw: '3' })
  const panel = run({ usdc: { issues: [tiny], attempts: [attempt('usdc')] } })
  assert.equal(Object.isFrozen(FLUID_BRIDGE_SUBJECTS), true)
  assert.equal(FLUID_BRIDGE_SUBJECTS.every(Object.isFrozen), true)
  assert.equal(panel.board.size, 2)
  assert.equal(panel.episodes.length, tiny.qRaw.length * 5)
  assert.equal(panel.diagnostics.get(subjectKey(route('usdc'))).noHolderAttempts, 1)
  assert.equal(panel.diagnostics.get(subjectKey(route('usdc'))).omittedQCases, 3)
  assert.equal(panel.diagnostics.get(subjectKey(route('usdt'))).issues, 0)
  assert.throws(
    () => fluidBridgeBoardSubjects({ subjects: [route('usdc')] }),
    /frozen_subject_invalid/,
  )
  assert.throws(
    () => fluidBridgeBoardSubjects({ subjects: [...manifest.subjects, route('usdt')] }),
    /frozen_subject_invalid/,
  )
})

test('both routes bind holder, Q, feature as-of, and distinct original assets', () => {
  const usdcIssue = issue('usdc')
  const usdtIssue = issue('usdt')
  const selected = []
  const panel = run({
    usdc: { issues: [usdcIssue], scores: [score('usdc', usdcIssue)] },
    usdt: { issues: [usdtIssue], scores: [score('usdt', usdtIssue)] },
    select: (features, subject, parent, baseline) => {
      selected.push({ features, subject, parent, baseline })
      return { featureRefs: [], featureAbstentions: {} }
    },
  })
  assert.equal(panel.episodes.length, 50)
  assert.equal(selected.length, 2)
  assert.deepEqual(
    selected.map((row) => row.subject.asset),
    [USDC, USDC],
  )
  assert.deepEqual(
    selected.map((row) => row.baseline.baseline.targetBlock),
    ['100', '100'],
  )
  assert.deepEqual(
    selected.map((row) => row.baseline.baseline.targetBlockAt),
    [BASELINE_AT, BASELINE_AT],
  )
  for (const lane of ['usdc', 'usdt']) {
    const first = panel.episodes.find((row) => row.lane === `fluid_bridge_${lane}`)
    assert.equal(first.stageScope, `fluid_bridge_${lane}_first_leg_eth_call`)
    assert.equal(first.firstLegAsset, USDC)
    assert.equal(first.originalAsset, lane === 'usdt' ? USDT : USDC)
    assert.equal(first.qUnit, 'USDC_first_leg_assets')
    assert.equal(first.baseline, 'simulated_callable')
    assert.deepEqual(first.outcome, { status: 'simulated_callable', reason: null })
    assert.equal(first.fullRoutePaidProofSha256, null)
    assert.equal(first.finalPayoutStatus, 'unassessed')
    assert.equal(first.forecastEligible, false)
    assert.equal(first.holderCommitment, sha(`${VAULT}:${HOLDER}`))
    assert.equal(panel.diagnostics.get(subjectKey(route(lane))).scoredTargets, 1)
  }
  assert.equal(
    panel.episodes.find((row) => row.lane === 'fluid_bridge_usdt').conversionStatus,
    'unassessed',
  )
})

test('generic covered reverts remain unknown-cause, not venue impairment or recovery', () => {
  const parent = issue('usdt', { baselineStatuses: ['evm_revert'] })
  const observed = score('usdt', parent, {
    statuses: ['success', 'evm_revert', 'position_insufficient', 'unavailable'],
  })
  const rows = run({ usdt: { issues: [parent], scores: [observed] } }).episodes.filter(
    (row) => row.lane === 'fluid_bridge_usdt' && row.plannedHorizonHours === 1,
  )
  assert.equal(rows[0].baseline, 'inconclusive')
  assert.equal(rows[0].baselineReason, 'revert_cause_unknown')
  assert.deepEqual(rows[0].outcome, {
    status: 'not_at_risk',
    reason: 'baseline_revert_cause_unknown',
  })
  assert.deepEqual(rows[1].outcome, { status: 'inconclusive', reason: 'revert_cause_unknown' })
  assert.deepEqual(rows[2].outcome, { status: 'censored', reason: 'holder_attrition' })
  assert.deepEqual(rows[3].outcome, { status: 'inconclusive', reason: 'assay_unavailable' })
  assert.equal(
    rows.some((row) => row.baseline === 'simulated_impaired'),
    false,
  )
  const holderAbsent = structuredClone(observed)
  holderAbsent.cases[2].outcome = 'holder_absent'
  const absentRows = run({ usdt: { issues: [parent], scores: [reseal(holderAbsent)] } }).episodes
  const absentCell = absentRows.find(
    (row) => row.qRaw === parent.qRaw[2] && row.plannedHorizonHours === 1,
  )
  assert.deepEqual(absentCell.outcome, { status: 'censored', reason: 'holder_attrition' })
})

test('missed capture, pending, and missing are distinct', () => {
  const parent = issue('usdc')
  const missed = run({
    usdc: { issues: [parent], scores: [score('usdc', parent, { status: 'missed_window' })] },
    nowMs: Date.parse('2026-10-04T03:11:00.000Z'),
  })
  assert.deepEqual(missed.episodes[0].outcome, {
    status: 'censored',
    reason: 'capture_window_missed',
  })
  assert.equal(missed.episodes[0].observedAtUtc, null)
  assert.equal(run({ usdc: { issues: [parent] } }).episodes[0].outcome.status, 'pending')
  assert.deepEqual(
    run({ usdc: { issues: [parent] }, nowMs: Date.parse('2026-10-05T00:00:00.000Z') }).episodes[0]
      .outcome,
    { status: 'missing', reason: 'no_verified_score_after_deadline' },
  )
})

test('Fluid issue, score, and attempt facts enter at their local availability clocks', () => {
  const parent = issue('usdc')
  const observed = score('usdc', parent)
  const logged = attempt('usdc')
  const selected = []
  const at = (nowMs, scoreRows = [observed]) =>
    run({
      usdc: { issues: [parent], scores: scoreRows, attempts: [logged] },
      nowMs,
      select: (_features, _subject, row) => {
        selected.push(row.sha256)
        return { featureRefs: [], featureAbstentions: {} }
      },
    })
  const key = subjectKey(route('usdc'))
  const beforeIssue = at(Date.parse(ISSUE_AT) - 1)
  assert.equal(beforeIssue.episodes.length, 0)
  assert.equal(beforeIssue.diagnostics.get(key).issues, 0)
  assert.equal(beforeIssue.diagnostics.get(key).attempts, 0)
  assert.equal(beforeIssue.diagnostics.get(key).noHolderAttempts, 0)
  assert.equal(beforeIssue.diagnostics.get(key).measuredQCases, 0)
  assert.deepEqual(selected, [])
  const atIssue = at(Date.parse(ISSUE_AT))
  assert.equal(atIssue.episodes.length, parent.qRaw.length * HORIZONS.length)
  assert.equal(atIssue.diagnostics.get(key).issues, 1)
  assert.equal(atIssue.diagnostics.get(key).attempts, 1)
  assert.equal(atIssue.diagnostics.get(key).noHolderAttempts, 1)
  assert.deepEqual(selected, [parent.sha256])
  const beforeScore = at(Date.parse(observed.scoredAtUtc) - 1)
  assert.equal(beforeScore.episodes[0].outcome.status, 'pending')
  assert.equal(beforeScore.episodes[0].scoreSha256, null)
  assert.equal(beforeScore.episodes[0].observedAtUtc, null)
  assert.equal(beforeScore.episodes[0].rawScoreStatus, null)
  assert.equal(beforeScore.episodes[0].rawScoreOutcome, null)
  assert.equal(beforeScore.episodes[0].rawScoreSimulationStatus, null)
  assert.equal(beforeScore.diagnostics.get(key).scoredTargets, 0)
  const atScore = at(Date.parse(observed.scoredAtUtc))
  assert.equal(atScore.episodes[0].scoreSha256, observed.sha256)
  assert.equal(atScore.episodes[0].rawScoreStatus, 'measured')
  assert.equal(atScore.diagnostics.get(key).scoredTargets, 1)
  assert.throws(
    () => at(Date.parse(ISSUE_AT) - 1, [reseal({ ...observed, scoredAtUtc: 'invalid' })]),
    /clock_invalid/,
  )
  const futureMeasuredBlock = structuredClone(observed)
  futureMeasuredBlock.block.timestamp = Math.floor(Date.parse(observed.scoredAtUtc) / 1_000) + 1
  assert.throws(
    () => at(Date.parse(ISSUE_AT) - 1, [reseal(futureMeasuredBlock)]),
    /score_case_invalid/,
  )
  const missed = score('usdc', parent, { status: 'missed_window' })
  const futureMissedBlock = structuredClone(missed)
  futureMissedBlock.block.timestamp = Math.floor(Date.parse(missed.scoredAtUtc) / 1_000) + 1
  assert.throws(
    () => at(Date.parse(ISSUE_AT) - 1, [reseal(futureMissedBlock)]),
    /score_censor_invalid/,
  )
  const malformed = structuredClone(parent)
  malformed.baseline.cases[0].qRaw = '0'
  assert.throws(
    () => run({ usdc: { issues: [reseal(malformed)] }, nowMs: Date.parse(ISSUE_AT) - 1 }),
    /baseline_case_invalid/,
  )
  assert.throws(
    () =>
      run({
        usdt: {
          attempts: [reseal({ ...attempt('usdt'), failureStage: 'invented' })],
        },
        nowMs: Date.parse(ISSUE_AT) - 1,
      }),
    /attempt_invalid/,
  )
})

test('sealed route, asset, holder, Q, horizon, target, and score binding forgeries fail closed', () => {
  const parent = issue('usdt')
  const observed = score('usdt', parent)
  const forgedIssue = (mutate, pattern) => {
    const copy = structuredClone(parent)
    mutate(copy)
    const changed = reseal(copy)
    assert.throws(() => run({ usdt: { issues: [changed] } }), pattern)
  }
  forgedIssue((row) => (row.routeKey = route('usdc').route_key), /issue_identity_invalid/)
  forgedIssue((row) => (row.finalAsset = USDC), /issue_identity_invalid/)
  forgedIssue((row) => (row.asset = USDT), /issue_identity_invalid/)
  forgedIssue((row) => (row.holder = `0x${'2'.repeat(40)}`), /issue_identity_invalid/)
  forgedIssue((row) => (row.qRaw[0] = '999'), /issue_identity_invalid/)
  forgedIssue((row) => (row.targets[0].horizonHours = 2), /target_invalid/)
  forgedIssue(
    (row) => (row.targets[0].deadlineAtUtc = row.targets[0].targetAtUtc),
    /target_invalid/,
  )
  const unsealed = structuredClone(parent)
  unsealed.qRaw[0] = '999'
  assert.throws(() => run({ usdt: { issues: [unsealed] } }), /issues_unsealed_or_unbound/)
  const changedScore = reseal({ ...observed, qRaw: ['999', ...observed.qRaw.slice(1)] })
  assert.throws(
    () => run({ usdt: { issues: [parent], scores: [changedScore] } }),
    /score_binding_invalid/,
  )
  for (const extra of [
    { routeKey: route('usdc').route_key },
    { destination: `0x${'2'.repeat(40)}` },
    { asset: USDT },
    { finalAsset: USDC },
  ]) {
    assert.throws(
      () => run({ usdt: { issues: [parent], scores: [reseal({ ...observed, ...extra })] } }),
      /score_binding_invalid/,
    )
  }
  const changedMeasurement = structuredClone(observed)
  changedMeasurement.cases[0].measurement.vault.assetAddress = USDT
  assert.throws(
    () => run({ usdt: { issues: [parent], scores: [reseal(changedMeasurement)] } }),
    /score_case_invalid/,
  )
  const falseAbsence = structuredClone(observed)
  falseAbsence.cases[0].outcome = 'holder_absent'
  falseAbsence.cases[0].measurement.simulation = {
    status: 'position_insufficient',
    reason: 'holder_has_no_shares',
  }
  assert.throws(
    () => run({ usdt: { issues: [parent], scores: [reseal(falseAbsence)] } }),
    /score_case_invalid/,
  )
  assert.throws(
    () =>
      run({
        usdt: {
          issues: [parent],
          scores: [reseal({ ...observed, issueSha256: hash('c').slice(2) })],
        },
      }),
    /score_binding_invalid/,
  )
})
