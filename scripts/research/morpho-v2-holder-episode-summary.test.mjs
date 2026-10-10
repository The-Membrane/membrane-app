import assert from 'node:assert/strict'
import test from 'node:test'

import { scoreTransition } from './carry-local-morpho-holder-v2.mjs'
import { summarizeVerifiedMorphoV2Episodes } from './morpho-v2-holder-episode-summary.mjs'

const BASE = Date.parse('2026-10-01T00:00:00.000Z')
const at = (hours) => new Date(BASE + hours * 3_600_000).toISOString()
const holder = '0x' + 'a'.repeat(40)
const destination = '0x' + 'b'.repeat(40)
const asset = '0x' + 'c'.repeat(40)

function issue(sequence, rows, status = 'issued') {
  return {
    sequence,
    sha256: String(sequence).padStart(64, '0'),
    routeKey: 'USDC → VaultV2 [USDC]',
    destination,
    asset,
    holder: status === 'no_holder' ? null : holder,
    status,
    cases: rows.map(([label, baselineStatus, assetsRaw]) => ({ label, baselineStatus, assetsRaw })),
    targets: [1, 24].map((horizonHours) => ({
      horizonHours,
      targetAtUtc: at(horizonHours),
      captureDeadlineUtc: at(horizonHours + 2),
    })),
  }
}

function score(record, label, horizonHours, outcome) {
  const row = record.cases.find((entry) => entry.label === label)
  const target = record.targets.find((entry) => entry.horizonHours === horizonHours)
  return {
    issueSequence: record.sequence,
    issueSha256: record.sha256,
    caseLabel: label,
    baselineStatus: row.baselineStatus,
    routeKey: record.routeKey,
    destination: record.destination,
    asset: record.asset,
    holder: record.holder,
    assetsRaw: row.assetsRaw,
    horizonHours,
    targetAtUtc: target.targetAtUtc,
    outcome,
    transition: scoreTransition(row.baselineStatus, outcome),
    sha256: String(record.sequence * 100 + horizonHours).padStart(64, '0'),
  }
}

test('correlated Q cells become one issue episode, with same-Q sampled recovery', () => {
  const first = issue(1, [
    ['small', 'simulated_withdraw_success', '10'],
    ['near', 'simulated_withdraw_success', '90'],
  ])
  const second = issue(2, [['small', 'baseline_revert', '10']])
  const third = issue(3, [['small', 'simulated_withdraw_success', '10']])
  const fourth = issue(4, [], 'no_holder')
  const scores = [
    score(first, 'small', 1, 'preview_gap'),
    score(first, 'near', 1, 'preview_gap'),
    score(first, 'small', 24, 'simulated_withdraw_success'),
    score(first, 'near', 24, 'preview_gap'),
    score(second, 'small', 1, 'covered_revert_cause_unknown'),
    score(second, 'small', 24, 'simulated_withdraw_success'),
    score(third, 'small', 1, 'censored_capture_window_missed'),
  ]
  const output = summarizeVerifiedMorphoV2Episodes({
    issues: [first, second, third, fourth],
    scores,
    attempts: [],
    evaluationClockUtc: at(30),
  })
  assert.deepEqual(output.counts, {
    issues: 4,
    exactSubjects: 1,
    issuesWithHolder: 3,
    issuesWithMeasuredBaseline: 3,
    uniqueMeasuredHolders: 1,
    uniqueMeasuredSubjectHolders: 1,
    noHolder: 1,
    baselineUnavailable: 0,
    newSimulationRevertEpisodes: 1,
    laterSimulatedSuccessEpisodes: 2,
    sampledStillRevertingH1: 1,
    sampledStillRevertingH24: 1,
    captureCensoredEpisodes: 1,
    overdueUnscoredEpisodes: 1,
    futureUnscoredEpisodes: 0,
    inconclusiveEpisodes: 0,
    holderAttritionEpisodes: 0,
  })
  assert.deepEqual(output.firstSimulationRevertBrackets, {
    baselineSampleToH1ScoreSample: 1,
    baselineSampleToH24ScoreSample: 0,
    H1ScoreSampleToH24ScoreSample: 0,
  })
  assert.deepEqual(output.laterSimulatedSuccessBrackets, {
    baselineSampleToH1ScoreSample: 0,
    baselineSampleToH24ScoreSample: 0,
    H1ScoreSampleToH24ScoreSample: 2,
  })
  assert.equal(output.episodeUnit, 'issue')
  assert.equal(output.independenceAcrossIssuesUnverified, true)
  assert.equal(output.likelyDurationAvailable, false)
  assert.equal(output.holderExecutableExit, false)
  assert.equal(output.attemptReconciliation.orphanIssues, 4)
  const json = JSON.stringify(output)
  for (const secret of [holder, destination, asset, 'assetsRaw', 'caseLabel'])
    assert.equal(json.includes(secret), false)
})

test('missing H1 broadens an H24 onset interval; future score remains pending', () => {
  const record = issue(1, [['small', 'simulated_withdraw_success', '10']])
  const result = summarizeVerifiedMorphoV2Episodes({
    issues: [record],
    scores: [score(record, 'small', 24, 'preview_gap')],
    attempts: [],
    evaluationClockUtc: at(26),
  })
  assert.deepEqual(result.firstSimulationRevertBrackets, {
    baselineSampleToH1ScoreSample: 0,
    baselineSampleToH24ScoreSample: 1,
    H1ScoreSampleToH24ScoreSample: 0,
  })
  assert.equal(result.counts.overdueUnscoredEpisodes, 1)
  const pending = summarizeVerifiedMorphoV2Episodes({
    issues: [record],
    scores: [],
    attempts: [],
    evaluationClockUtc: at(0),
  })
  assert.equal(pending.counts.futureUnscoredEpisodes, 1)
  assert.equal(pending.counts.overdueUnscoredEpisodes, 0)
})

test('rejects duplicate or cross-identity score links before aggregating', () => {
  const record = issue(1, [['small', 'simulated_withdraw_success', '10']])
  const one = score(record, 'small', 1, 'preview_gap')
  const input = { issues: [record], scores: [one, one], attempts: [], evaluationClockUtc: at(3) }
  assert.throws(() => summarizeVerifiedMorphoV2Episodes(input), /morpho_episode_score_link_invalid/)
  input.scores = [{ ...one, destination: '0x' + 'd'.repeat(40) }]
  assert.throws(() => summarizeVerifiedMorphoV2Episodes(input), /morpho_episode_score_link_invalid/)
})
