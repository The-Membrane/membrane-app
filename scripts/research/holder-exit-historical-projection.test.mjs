import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { buildHolderExitHistoricalProjection } from './holder-exit-historical-projection.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const address = (value) => `0x${value.toString(16).padStart(40, '0')}`
const at = (hour) => new Date(Date.UTC(2026, 0, 1, hour)).toISOString()

function subjects() {
  return Array.from({ length: 67 }, (_, index) => ({
    routeKey: `route-${index % 25}`,
    destination: address(index + 1),
    asset: address(index + 101),
    stageScope: `stage-${index % 25}`,
    episodes: [],
  }))
}

function panel(episodesByIndex = new Map()) {
  const rows = subjects()
  for (const [index, episodes] of episodesByIndex) rows[index].episodes = episodes
  return {
    scope: 'offline_frozen_25_67_holder_episode_panel',
    sourceVerification: 'offline_sealed_replay',
    manifestSha256: sha('manifest'),
    statisticalIndependenceValidated: false,
    subjects: rows,
  }
}

function episode(subject, id, qRaw, horizonHours, overrides = {}) {
  const issueAtUtc = at(0)
  const targetAtUtc = at(horizonHours)
  return {
    subject: `${subject.routeKey}\0${subject.destination.toLowerCase()}\0${subject.asset.toLowerCase()}`,
    stageScope: subject.stageScope,
    issueClusterSha256: sha(`cluster-${id}`),
    issueSha256: sha(`issue-${id}`),
    scoreSha256: sha(`score-${id}-${qRaw}-${horizonHours}`),
    holderCommitment: sha(`holder-${id}`),
    qRaw,
    qUnit: 'asset_raw',
    qCaseLabel: `tier-${qRaw}`,
    plannedHorizonHours: horizonHours,
    analysisPrimaryForCell: true,
    issueAtUtc,
    baselineAtUtc: at(-1),
    targetAtUtc,
    deadlineAtUtc: at(horizonHours + 1),
    observedAtUtc: targetAtUtc,
    labelAvailableAtUtc: targetAtUtc,
    baseline: 'simulated_callable',
    outcome: { status: 'simulated_callable', reason: null },
    ...overrides,
  }
}

test('preserves all 25 route groups and 67 exact subjects with empty status', () => {
  const result = buildHolderExitHistoricalProjection(panel())
  assert.equal(result.summary.routeGroups, 25)
  assert.equal(result.summary.exactSubjects, 67)
  assert.equal(result.summary.noEpisodeSubjects, 67)
  assert.equal(result.summary.historicalTestedBoundsRouteGroups, 0)
  assert.equal(result.summary.recordedUnitBoundsSubjects, 0)
  assert.equal(result.summary.displayComparableAssetAmountSubjects, 0)
  assert.equal(result.summary.missingUnitBoundsSubjects, 0)
  assert.equal(result.subjects.length, 67)
  assert.equal(result.version, 3)
  assert.equal(result.scope, 'historical_tested_amount_bounds')
  assert.equal(result.claimClass, 'historical_tested_callable_lower_bounds')
  assert.equal(result.historicalDataThroughUtc, null)
  assert.equal(result.forecastValidated, false)
  assert.equal(result.prospectiveValidated, false)
  assert.equal(result.statisticalIndependenceValidated, false)
  assert.equal(result.populationQuantile, false)
  assert.equal(result.holderExecutableCapacity, false)
  assert.equal(result.routeLevelProbability, null)
  assert.equal(result.amountProjection, null)
  assert.equal(result.durationProjection, null)
  assert.equal(result.sourceVerification, 'untrusted_input')
})

test('keeps two destinations of the same route isolated', () => {
  const seeds = subjects()
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [0, [episode(seeds[0], 'first', '100', 1)]],
        [25, [episode(seeds[25], 'second', '900', 1)]],
      ]),
    ),
  )
  assert.equal(
    result.subjects[0].historicalTestedAmountBoundsByHorizon[0].testedCallableLowerBoundMinRaw,
    '100',
  )
  assert.equal(
    result.subjects[25].historicalTestedAmountBoundsByHorizon[0].testedCallableLowerBoundMinRaw,
    '900',
  )
  assert.equal(result.subjects[1].status, 'no_episodes')
  assert.equal(result.subjects[0].routeKey, result.subjects[25].routeKey)
  assert.equal(result.summary.historicalTestedBoundsRouteGroups, 1)
  assert.equal(result.summary.recordedUnitBoundsSubjects, 2)
  assert.equal(result.summary.displayComparableAssetAmountSubjects, 2)
  assert.equal(result.summary.missingUnitBoundsSubjects, 0)
})

test('variable Q ladders use the highest callable tier and expose tested ceiling censoring', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'a', '10', 2),
            episode(seed, 'a', '20', 2, {
              outcome: { status: 'simulated_impaired', reason: null },
            }),
            episode(seed, 'b', '5', 2),
            episode(seed, 'b', '15', 2),
            episode(seed, 'b', '30', 2, {
              outcome: { status: 'simulated_impaired', reason: null },
            }),
          ],
        ],
      ]),
    ),
  )
  const projection = result.subjects[0]
  const envelope = projection.historicalTestedAmountBoundsByHorizon[0]
  assert.equal(projection.status, 'historical_tested_bounds')
  assert.equal(envelope.boundEligibleCohorts, 2)
  assert.deepEqual(
    [
      envelope.testedCallableLowerBoundMinRaw,
      envelope.testedCallableLowerBoundMedianRaw,
      envelope.testedCallableLowerBoundMaxRaw,
    ],
    ['10', '10', '15'],
  )
  assert.equal(envelope.aboveTestCeilingUnknownCohorts, 0)
  assert.equal(envelope.orderStatisticBasis, 'descriptive_sample')
  assert.equal(envelope.populationQuantile, false)
  assert.deepEqual(
    envelope.cohorts.map((cohort) => [
      cohort.testedCallableLowerBoundRaw,
      cohort.testedCallableTierRank,
    ]),
    [
      ['10', 1],
      ['15', 2],
    ],
  )
  assert.equal(envelope.cohorts[1].testedCallableTierLabel, 'tier-15')
  assert.deepEqual(
    envelope.cohorts[0].testedTiers.map((tier) => [
      tier.qRaw,
      tier.baselineState,
      tier.outcomeState,
    ]),
    [
      ['10', 'simulated_callable', 'simulated_callable'],
      ['20', 'simulated_callable', 'simulated_impaired'],
    ],
  )
  assert.deepEqual(
    projection.primaryAssays
      .filter((row) => row.qRaw === '20')
      .map((row) => [row.horizonHours, row.baselineState, row.outcomeState, row.censorReason]),
    [[2, 'simulated_callable', 'simulated_impaired', null]],
  )
})

test('retains exact-Q primary censors outside complete ladder cohorts', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'censor', '100', 24, {
              outcome: { status: 'censored', reason: 'capture_window_missed' },
              scoreSha256: null,
              observedAtUtc: null,
              labelAvailableAtUtc: null,
            }),
          ],
        ],
      ]),
    ),
  )
  assert.equal(result.subjects[0].historicalTestedAmountBoundsByHorizon, null)
  assert.deepEqual(
    result.subjects[0].primaryAssays.map((row) => [row.qRaw, row.horizonHours, row.censorReason]),
    [['100', 24, 'capture_window_missed']],
  )
})

test('sampled-state evidence reports the last same-state sample without a duration bound', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(new Map([[0, [episode(seed, 'a', '10', 1), episode(seed, 'a', '10', 4)]]])),
  )
  const sampled = result.subjects[0].sampledStateEvidence
  assert.equal(sampled.sameStateAtLastSampleTrajectories, 1)
  assert.equal(sampled.durationProjection, null)
  assert.equal(sampled.observations[0].lastSameStateSampleHours, 4)
  assert.equal(sampled.observations[0].observedDifferentStateWindow, null)
})

test('different observed state has an observation window, not a continuous-duration estimate', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'a', '10', 1),
            episode(seed, 'a', '10', 4, {
              outcome: { status: 'simulated_impaired', reason: null },
            }),
          ],
        ],
      ]),
    ),
  )
  const sampled = result.subjects[0].sampledStateEvidence
  assert.equal(sampled.observedDifferentStateWindows, 1)
  assert.equal(sampled.observations[0].lastSameStateSampleHours, 1)
  assert.deepEqual(sampled.observations[0].observedDifferentStateWindow, {
    afterObservedAtUtc: at(1),
    byObservedAtUtc: at(4),
    lastSameStatePlannedHorizonHours: 1,
    differentStatePlannedHorizonHours: 4,
  })
})

test('out-of-order observation clocks abstain from sampled-state windows', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'clock-order', '10', 1, {
              targetAtUtc: at(2),
              observedAtUtc: at(2),
              deadlineAtUtc: at(3),
              labelAvailableAtUtc: at(2),
            }),
            episode(seed, 'clock-order', '10', 4, {
              targetAtUtc: at(1),
              observedAtUtc: at(1),
              deadlineAtUtc: at(2),
              labelAvailableAtUtc: at(1),
              outcome: { status: 'simulated_impaired', reason: null },
            }),
          ],
        ],
      ]),
    ),
  )
  assert.equal(result.subjects[0].sampledStateEvidence.measuredTrajectories, 0)
  assert.deepEqual(result.subjects[0].sampledStateEvidence.abstentions, {
    nonmonotone_observation_clocks: 1,
  })
})

test('first observed different-state sample has no invented prior same-state sample', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'first-change', '10', 1, {
              outcome: { status: 'simulated_impaired', reason: null },
            }),
          ],
        ],
      ]),
    ),
  )
  const observation = result.subjects[0].sampledStateEvidence.observations[0]
  assert.equal(observation.lastSameStateSampleHours, null)
  assert.equal(observation.lastSameStateObservedAtUtc, null)
  assert.deepEqual(observation.observedDifferentStateWindow, {
    afterObservedAtUtc: at(-1),
    byObservedAtUtc: at(1),
    lastSameStatePlannedHorizonHours: null,
    differentStatePlannedHorizonHours: 1,
  })
})

test('conflicting baseline states abstain the sampled-state trajectory', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'conflict', '10', 1),
            episode(seed, 'conflict', '10', 4, {
              baseline: 'simulated_impaired',
              outcome: { status: 'simulated_impaired', reason: null },
            }),
          ],
        ],
      ]),
    ),
  )
  assert.equal(result.subjects[0].sampledStateEvidence.measuredTrajectories, 0)
  assert.deepEqual(result.subjects[0].sampledStateEvidence.abstentions, {
    baseline_state_conflict: 1,
  })
})

test('duplicate measured horizon abstains the sampled-state trajectory', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([[0, [episode(seed, 'duplicate', '10', 1), episode(seed, 'duplicate', '10', 1)]]]),
    ),
  )
  assert.equal(result.subjects[0].sampledStateEvidence.measuredTrajectories, 0)
  assert.deepEqual(result.subjects[0].sampledStateEvidence.abstentions, {
    duplicate_horizon: 1,
  })
})

test('historical data-through clock comes from saved source clocks', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(new Map([[0, [episode(seed, 'late-label', '10', 1, { labelAvailableAtUtc: at(3) })]]])),
  )
  assert.equal(result.historicalDataThroughUtc, at(3))
})

test('one pending Q cell abstains the full horizon cohort', () => {
  const seed = subjects()[0]
  const pending = episode(seed, 'a', '20', 2, {
    scoreSha256: null,
    observedAtUtc: null,
    labelAvailableAtUtc: null,
    outcome: { status: 'pending', reason: null },
  })
  const result = buildHolderExitHistoricalProjection(
    panel(new Map([[0, [episode(seed, 'a', '10', 2), pending]]])),
  )
  const subject = result.subjects[0]
  assert.equal(subject.status, 'no_fully_measured_present_cohorts')
  assert.equal(subject.fullyMeasuredPresentCohorts, 0)
  assert.deepEqual(subject.cohortAbstentions, { incomplete_present_cells: 1 })
  assert.equal(subject.sampledStateEvidence.sameStateAtLastSampleTrajectories, 1)
})

test('raw amounts beyond Number precision retain exact BigInt order statistics', () => {
  const seed = subjects()[0]
  const a = '900719925474099300000000000000001'
  const b = '900719925474099300000000000000002'
  const c = '900719925474099300000000000000003'
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [0, [episode(seed, 'a', c, 1), episode(seed, 'b', a, 1), episode(seed, 'c', b, 1)]],
      ]),
    ),
  )
  const envelope = result.subjects[0].historicalTestedAmountBoundsByHorizon[0]
  assert.deepEqual(
    [
      envelope.testedCallableLowerBoundMinRaw,
      envelope.testedCallableLowerBoundMedianRaw,
      envelope.testedCallableLowerBoundMaxRaw,
    ],
    [a, b, c],
  )
  assert.equal(envelope.aboveTestCeilingUnknownCohorts, 3)
})

test('no callable tested tier uses an explicit zero lower-bound sentinel', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'a', '10', 1, {
              outcome: { status: 'simulated_impaired', reason: null },
            }),
            episode(seed, 'a', '20', 1, {
              outcome: { status: 'simulated_impaired', reason: null },
            }),
          ],
        ],
      ]),
    ),
  )
  const envelope = result.subjects[0].historicalTestedAmountBoundsByHorizon[0]
  assert.equal(envelope.testedCallableLowerBoundMinRaw, '0')
  assert.equal(envelope.noCallableTestedTierCohorts, 1)
  assert.equal(envelope.cohorts[0].testedCallableLowerBoundRaw, '0')
  assert.equal(envelope.cohorts[0].aboveTestCeilingUnknown, false)
})

test('different raw units never enter the same amount order statistics', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'assets', '10', 1),
            episode(seed, 'shares', '1000', 1, { qUnit: 'share_raw' }),
          ],
        ],
      ]),
    ),
  )
  const horizons = result.subjects[0].historicalTestedAmountBoundsByHorizon
  assert.equal(horizons.length, 2)
  assert.deepEqual(
    horizons.map((horizon) => [
      horizon.qUnit,
      horizon.testedCallableLowerBoundMinRaw,
      horizon.boundEligibleCohorts,
    ]),
    [
      ['asset_raw', '10', 1],
      ['share_raw', '1000', 1],
    ],
  )
})

test('same Q and holder with different units remain separate sampled-state trajectories', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'same', '10', 1, { qUnit: 'asset_raw' }),
            episode(seed, 'same', '10', 1, { qUnit: 'share_raw' }),
          ],
        ],
      ]),
    ),
  )
  assert.equal(result.subjects[0].sampledStateEvidence.measuredTrajectories, 2)
  assert.deepEqual(
    result.subjects[0].sampledStateEvidence.observations.map((row) => row.qUnit),
    ['asset_raw', 'share_raw'],
  )
})

test('missing unit and literal raw unit have different identities and display eligibility', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'same', '10', 1, { qUnit: null }),
            episode(seed, 'same', '10', 1, { qUnit: 'raw' }),
          ],
        ],
      ]),
    ),
  )
  const subject = result.subjects[0]
  assert.equal(subject.sampledStateEvidence.measuredTrajectories, 2)
  assert.equal(subject.historicalTestedAmountBoundsByHorizon.length, 2)
  assert.deepEqual(
    subject.historicalTestedAmountBoundsByHorizon.map((row) => [
      row.qUnit,
      row.unitStatus,
      row.displayComparableAssetAmount,
    ]),
    [
      [null, 'missing', false],
      ['raw', 'recorded', false],
    ],
  )
  assert.equal(result.summary.recordedUnitBoundsSubjects, 1)
  assert.equal(result.summary.missingUnitBoundsSubjects, 1)
  assert.equal(result.summary.displayComparableAssetAmountSubjects, 0)
})

test('singleton is a fully measured present cohort without issued-ladder completeness', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(new Map([[0, [episode(seed, 'singleton', '10', 1)]]])),
  )
  assert.equal(result.subjects[0].fullyMeasuredPresentCohorts, 1)
  assert.equal(result.subjects[0].boundEligibleCohorts, 1)
  assert.equal(result.expectedIssuedQLadderVerified, false)
  assert.equal(result.subjects[0].completeCohorts, undefined)
})

test('nonmonotone present ladder is excluded from tested amount bounds', () => {
  const seed = subjects()[0]
  const result = buildHolderExitHistoricalProjection(
    panel(
      new Map([
        [
          0,
          [
            episode(seed, 'nonmonotone', '10', 1, {
              outcome: { status: 'simulated_impaired', reason: null },
            }),
            episode(seed, 'nonmonotone', '20', 1),
          ],
        ],
      ]),
    ),
  )
  const subject = result.subjects[0]
  assert.equal(subject.fullyMeasuredPresentCohorts, 1)
  assert.equal(subject.boundEligibleCohorts, 0)
  assert.equal(subject.status, 'no_eligible_tested_bounds')
  assert.deepEqual(subject.cohortAbstentions, { nonmonotone_present_ladder: 1 })
  assert.equal(subject.historicalTestedAmountBoundsByHorizon, null)
})

test('pure builder never promotes caller strings to verified provenance', () => {
  const fakeSealed = panel()
  assert.equal(
    buildHolderExitHistoricalProjection(fakeSealed).sourceVerification,
    'untrusted_input',
  )
  fakeSealed.sourceVerification = 'caller_supplied'
  assert.equal(
    buildHolderExitHistoricalProjection(fakeSealed).sourceVerification,
    'untrusted_input',
  )
  fakeSealed.statisticalIndependenceValidated = true
  assert.throws(() => buildHolderExitHistoricalProjection(fakeSealed), /independence_invalid/)
  fakeSealed.statisticalIndependenceValidated = false
  fakeSealed.manifestSha256 = 'bad'
  assert.throws(() => buildHolderExitHistoricalProjection(fakeSealed), /manifest_invalid/)
})

test('uint256 maximum amount is accepted and overflow rejects', () => {
  const seed = subjects()[0]
  const max = ((1n << 256n) - 1n).toString()
  const accepted = buildHolderExitHistoricalProjection(
    panel(new Map([[0, [episode(seed, 'max', max, 1, { qCaseLabel: 'max' })]]])),
  )
  assert.equal(
    accepted.subjects[0].historicalTestedAmountBoundsByHorizon[0].testedCallableLowerBoundMaxRaw,
    max,
  )
  assert.throws(
    () =>
      buildHolderExitHistoricalProjection(
        panel(new Map([[0, [episode(seed, 'overflow', (1n << 256n).toString(), 1)]]])),
      ),
    /row_invalid/,
  )
})

test('invalid subject identity, amount, clock or repeated exact subject rejects', () => {
  const seed = subjects()[0]
  const badAmount = episode(seed, 'a', '1e3', 1)
  assert.throws(
    () => buildHolderExitHistoricalProjection(panel(new Map([[0, [badAmount]]]))),
    /row_invalid/,
  )
  const badClock = episode(seed, 'a', '10', 1, { labelAvailableAtUtc: at(-1) })
  assert.throws(
    () => buildHolderExitHistoricalProjection(panel(new Map([[0, [badClock]]]))),
    /measured_proof_invalid/,
  )
  const badIdentity = episode(seed, 'a', '10', 1, { subject: 'wrong' })
  assert.throws(
    () => buildHolderExitHistoricalProjection(panel(new Map([[0, [badIdentity]]]))),
    /row_invalid/,
  )
  const duplicate = panel()
  duplicate.subjects[25] = { ...duplicate.subjects[0] }
  assert.throws(() => buildHolderExitHistoricalProjection(duplicate), /subject_duplicate/)
})
