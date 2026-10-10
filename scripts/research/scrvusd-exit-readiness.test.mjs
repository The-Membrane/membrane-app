import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outcomeProtocol } from './scrvusd-exit-forecast-issue.mjs'
import { evaluateLabels } from './scrvusd-exit-duration-evaluation.mjs'
import { SCHEMA as LABEL_SCHEMA } from './scrvusd-prospective-exit-labels.mjs'
import { buildExitReadiness, readExitReadiness } from './scrvusd-exit-readiness.mjs'

const start = Date.parse('2026-09-28T00:00:00.000Z')
const at = (seconds) => new Date(start + seconds * 1000).toISOString()
const route = 'direct_erc4626_withdraw_crvusd_from_scrvusd'
const holder = `0x${'a'.repeat(40)}`
const anchor = (number) => ({
  number,
  hash: `0x${number.toString(16).padStart(64, '0')}`,
  timestamp: start / 1000 + number,
})
const issue = (number, { issuedSecond = 200, qAssetsRaw = '1000', owner = holder } = {}) => ({
  issue: { filename: `${number}.json`, logicalSha256: 'a', physicalSha256: 'b' },
  issuedAtUtc: at(issuedSecond),
  targetUtc: at(issuedSecond + 7200),
  anchorBlock: anchor(number),
  holder: owner,
  qAssetsRaw,
  route,
  horizonOrigin: 'issue_time',
  horizonSeconds: 7200,
  score: { status: 'pending', scoredAtUtc: null, pointOutcome: null, trajectory: null },
})
const scored = (
  row,
  { pointStatus = 'success', trajectory = null, scoredSecond = 10000 } = {},
) => ({
  ...row,
  score: {
    status: 'observed',
    scoredAtUtc: at(scoredSecond),
    pointOutcome: { status: pointStatus },
    trajectory,
  },
})
const report = (asOfSecond, rows, horizons = [7200]) =>
  buildExitReadiness({
    ...evaluateLabels({
      labels: { schema: LABEL_SCHEMA, asOfUtc: at(asOfSecond), rows },
      horizons,
    }),
  })

test('zero cohort remains unavailable without invented episode or promotion counts', () => {
  const result = report(100, [], [7200])
  const horizon = result.byHorizon[0]
  assert.equal(result.allIssued, 0)
  assert.equal(horizon.issued, 0)
  assert.deepEqual(horizon.strata, [])
  assert.equal(horizon.gates.anyProspectiveIssues.status, 'unmet')
  assert.equal(horizon.gates.adequateIndependentEpisodes.status, 'unproven')
  assert.equal(horizon.dependence.independentEpisodeCount, null)
  assert.deepEqual(result.promotion, {
    probability: 'unavailable',
    duration: 'unavailable',
    alert: 'unavailable',
  })
})

test('overlapping issues count as one dependence cluster involving both classes', () => {
  const first = scored(issue(100), {
    pointStatus: 'revert',
    trajectory: {
      status: 'first_loss_interval',
      firstLoss: {
        intervalStartUtc: at(210),
        intervalEndUtc: at(300),
        intervalStartKind: 'post_issue_clean_success_sample',
        secondsFromIssueAtStart: 10,
        secondsFromIssueAtEnd: 100,
      },
    },
  })
  const second = scored(issue(101, { issuedSecond: 300 }))
  const result = report(12000, [first, second]).byHorizon[0]
  assert.equal(result.issued, 2)
  assert.equal(result.dependence.overlappingWindowClusterCount, 1)
  assert.deepEqual(result.dependence.clustersInvolvingEvidenceClass, {
    first_loss_interval: 1,
    point_success_only: 1,
  })
  assert.equal(result.dependence.independentEpisodeCount, null)
  assert.equal(result.firstLossSampledIntervals[0].interval.positiveSampledLowerBoundSeconds, 10)
  assert.equal(result.sampledPointSuccesses, 1)
  assert.equal(result.gates.heterogeneousObservedPointClasses.status, 'met')
  assert.equal(result.gates.continuousDuration.status, 'unproven')
  assert.equal(result.gates.chronologicalHoldout.status, 'unproven')
  assert.equal(result.gates.baselineComparison.status, 'unproven')
})

test('equivalent address case and decimal amount representations share a stratum', () => {
  const rows = [
    issue(100),
    issue(101, { qAssetsRaw: '01000', owner: holder.toUpperCase().replace('0X', '0x') }),
    issue(102, { qAssetsRaw: '1001' }),
    issue(103, { owner: `0x${'2'.repeat(40)}` }),
  ]
  const result = report(300, rows).byHorizon[0]
  assert.equal(result.strata.length, 3)
  assert.deepEqual(
    result.strata.map((stratum) => [stratum.holder, stratum.qAssetsRaw, stratum.route]),
    [
      [`0x${'2'.repeat(40)}`, '1000', route],
      [holder, '1000', route],
      [holder, '1001', route],
    ],
  )
  assert.deepEqual(
    result.strata.map((stratum) => stratum.issued),
    [1, 2, 1],
  )
})

test('missing, ambiguous, matured unscored, and censor remain separate from clean success', () => {
  const deadline = outcomeProtocol(at(200), 7200).checkpointSelection.captureDeadlineUtc
  const asOfSecond = (Date.parse(deadline) - start) / 1000
  const rows = [
    scored(issue(100), { pointStatus: 'missing_quote_checkpoint' }),
    scored(issue(101), { pointStatus: 'provider_ambiguity' }),
    scored(issue(102), {
      trajectory: { status: 'right_censored_at_last_sampled_success' },
    }),
    issue(103),
  ]
  const result = report(asOfSecond, rows).byHorizon[0]
  assert.equal(result.missing, 1)
  assert.equal(result.providerAmbiguous, 1)
  assert.equal(result.maturedUnscored, 1)
  assert.equal(result.rightCensored, 1)
  assert.equal(result.sampledPointSuccesses, 1)
  assert.equal(result.pending, 1)
  assert.equal(result.evidenceClasses.point_success_only, undefined)
  assert.equal(result.gates.heterogeneousObservedPointClasses.status, 'unmet')
})

test('as-of evaluation rejects future issues and scores before readiness aggregation', () => {
  assert.throws(() => report(100, [issue(100)]), /Invalid prospective issue label/)
  assert.throws(
    () => report(9000, [scored(issue(100), { scoredSecond: 10000 })]),
    /Invalid prospective issue label/,
  )
  assert.throws(
    () => readExitReadiness({ asOfUtc: at(100), now: () => new Date(start) }),
    /Future as-of UTC/,
  )
})
