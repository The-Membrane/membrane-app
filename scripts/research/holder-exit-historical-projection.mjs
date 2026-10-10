// Descriptive exact-subject tested bounds from holder assays. The panel has no
// bound expected-Q roster, so measured-present cells cannot prove issued-ladder completeness.
import { pathToFileURL } from 'node:url'

export const HOLDER_EXIT_HISTORICAL_PROJECTION_VERSION = 3

const SCOPE = 'offline_frozen_25_67_holder_episode_panel'
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/i
const RAW = /^(0|[1-9]\d*)$/
const MEASURED = new Set(['simulated_callable', 'simulated_impaired'])
const MAX_ROWS = 20_000
const MAX_UINT256 = (1n << 256n) - 1n

const fail = (reason) => {
  throw Error(`holder_exit_historical_projection_${reason}`)
}
const requireValid = (condition, reason) => {
  if (!condition) fail(reason)
}
const identity = (subject) =>
  `${subject.routeKey}\0${subject.destination.toLowerCase()}\0${subject.asset.toLowerCase()}`
const clock = (value) => {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value ? ms : null
}
const bump = (object, key) => {
  object[key] = (object[key] ?? 0) + 1
}
const compareRaw = (a, b) => {
  const left = BigInt(a)
  const right = BigInt(b)
  return left < right ? -1 : left > right ? 1 : 0
}
const sortedRaw = (values) => [...values].sort(compareRaw)
const taggedUnit = (value) => (value == null ? 'missing\0' : `present\0${value}`)

function validatePanel(panel) {
  requireValid(panel?.scope === SCOPE, 'scope_invalid')
  requireValid(
    ['offline_sealed_replay', 'caller_supplied'].includes(panel.sourceVerification),
    'source_invalid',
  )
  requireValid(SHA.test(panel.manifestSha256 ?? ''), 'manifest_invalid')
  requireValid(panel.statisticalIndependenceValidated === false, 'independence_invalid')
  requireValid(Array.isArray(panel.subjects) && panel.subjects.length === 67, 'subjects_invalid')
  requireValid(
    new Set(panel.subjects.map((subject) => subject.routeKey)).size === 25,
    'groups_invalid',
  )
  const seen = new Set()
  let rowCount = 0
  for (const subject of panel.subjects) {
    requireValid(
      typeof subject?.routeKey === 'string' &&
        subject.routeKey.length > 0 &&
        ADDRESS.test(subject.destination ?? '') &&
        ADDRESS.test(subject.asset ?? '') &&
        typeof subject.stageScope === 'string' &&
        subject.stageScope.length > 0 &&
        Array.isArray(subject.episodes),
      'subject_invalid',
    )
    const key = identity(subject)
    requireValid(!seen.has(key), 'subject_duplicate')
    seen.add(key)
    rowCount += subject.episodes.length
    requireValid(rowCount <= MAX_ROWS, 'row_limit')
    for (const row of subject.episodes) validateRow(row, subject, key)
  }
  return rowCount
}

function validateRow(row, subject, key) {
  requireValid(
    row?.subject === key &&
      row.stageScope === subject.stageScope &&
      SHA.test(row.issueClusterSha256 ?? '') &&
      SHA.test(row.issueSha256 ?? '') &&
      (row.holderCommitment == null || SHA.test(row.holderCommitment)) &&
      typeof row.qRaw === 'string' &&
      RAW.test(row.qRaw) &&
      row.qRaw.length <= 78 &&
      BigInt(row.qRaw) > 0n &&
      BigInt(row.qRaw) <= MAX_UINT256 &&
      (row.qCaseLabel == null ||
        (typeof row.qCaseLabel === 'string' && row.qCaseLabel.length <= 80)) &&
      (row.qUnit == null ||
        (typeof row.qUnit === 'string' && row.qUnit.length > 0 && row.qUnit.length <= 80)) &&
      Number.isSafeInteger(row.plannedHorizonHours) &&
      row.plannedHorizonHours > 0 &&
      typeof row.analysisPrimaryForCell === 'boolean' &&
      typeof row.outcome?.status === 'string',
    'row_invalid',
  )
  const issue = clock(row.issueAtUtc)
  const target = clock(row.targetAtUtc)
  const deadline = clock(row.deadlineAtUtc)
  requireValid(issue != null && target > issue && deadline > target, 'clock_invalid')
  if (row.baselineAtUtc != null)
    requireValid(
      clock(row.baselineAtUtc) != null && clock(row.baselineAtUtc) <= issue,
      'clock_invalid',
    )
  if (MEASURED.has(row.outcome.status)) {
    const observed = clock(row.observedAtUtc)
    const available = clock(row.labelAvailableAtUtc)
    requireValid(
      SHA.test(row.scoreSha256 ?? '') &&
        observed != null &&
        observed >= target &&
        observed <= deadline &&
        available != null &&
        available >= observed,
      'measured_proof_invalid',
    )
  } else {
    if (row.observedAtUtc != null) requireValid(clock(row.observedAtUtc) != null, 'clock_invalid')
    if (row.labelAvailableAtUtc != null)
      requireValid(clock(row.labelAvailableAtUtc) != null, 'clock_invalid')
  }
  if (row.baseline != null) requireValid(typeof row.baseline === 'string', 'baseline_invalid')
}

function measuredPresentCohorts(subject) {
  const cohorts = new Map()
  for (const row of subject.episodes) {
    if (!row.analysisPrimaryForCell) continue
    const key = [
      row.issueClusterSha256,
      row.holderCommitment ?? 'holderless',
      row.issueAtUtc,
      row.targetAtUtc,
      row.plannedHorizonHours,
      taggedUnit(row.qUnit),
    ].join('\0')
    const cohort = cohorts.get(key) ?? {
      issueClusterSha256: row.issueClusterSha256,
      holderCommitment: row.holderCommitment,
      horizonHours: row.plannedHorizonHours,
      qUnit: row.qUnit ?? null,
      rows: [],
    }
    cohort.rows.push(row)
    cohorts.set(key, cohort)
  }
  const fullyMeasuredPresent = []
  const eligibleBounds = []
  const abstentions = {}
  for (const cohort of cohorts.values()) {
    const labels = new Map()
    let duplicate = false
    for (const row of cohort.rows) {
      if (labels.has(row.qRaw)) duplicate = true
      labels.set(row.qRaw, row)
    }
    const reason = duplicate
      ? 'duplicate_q_cell'
      : cohort.holderCommitment == null
        ? 'holder_unavailable'
        : cohort.rows.some((row) => !MEASURED.has(row.baseline))
          ? 'baseline_unmeasured'
          : cohort.rows.some((row) => !MEASURED.has(row.outcome.status))
            ? 'incomplete_present_cells'
            : null
    if (reason) {
      bump(abstentions, reason)
      continue
    }
    const ladder = [...cohort.rows]
      .sort((a, b) => compareRaw(a.qRaw, b.qRaw))
      .map((row, index) => ({
        qRaw: row.qRaw,
        qCaseLabel: row.qCaseLabel ?? null,
        tierRank: index + 1,
        baselineState: row.baseline,
        outcomeState: row.outcome.status,
        callable: row.outcome.status === 'simulated_callable',
      }))
    fullyMeasuredPresent.push(cohort)
    let impairedSeen = false
    const nonmonotone = ladder.some((tier) => {
      if (!tier.callable) impairedSeen = true
      return tier.callable && impairedSeen
    })
    if (nonmonotone) {
      bump(abstentions, 'nonmonotone_present_ladder')
      continue
    }
    const callable = ladder.filter((tier) => tier.callable)
    const highest = callable.at(-1) ?? null
    eligibleBounds.push({
      issueClusterSha256: cohort.issueClusterSha256,
      holderCommitment: cohort.holderCommitment,
      horizonHours: cohort.horizonHours,
      qUnit: cohort.qUnit,
      measuredCells: ladder.length,
      testedTiers: ladder,
      testedCallableLowerBoundRaw: highest?.qRaw ?? '0',
      testedCallableTierRank: highest?.tierRank ?? null,
      testedCallableTierLabel: highest?.qCaseLabel ?? null,
      // Zero means no callable present tier was assayed; it is not a tested amount.
      noCallableTestedTier: highest == null,
      aboveTestCeilingUnknown: Boolean(ladder.at(-1)?.callable),
    })
  }
  return {
    attempted: cohorts.size,
    fullyMeasuredPresentCount: fullyMeasuredPresent.length,
    eligibleBounds,
    abstentions,
  }
}

function testedAmountBounds(cohorts) {
  if (!cohorts.length) return null
  const byHorizon = new Map()
  for (const cohort of cohorts) {
    const key = `${cohort.horizonHours}\0${taggedUnit(cohort.qUnit)}`
    const entries = byHorizon.get(key) ?? []
    entries.push(cohort)
    byHorizon.set(key, entries)
  }
  return [...byHorizon]
    .sort(([a], [b]) => {
      const hours = Number(a.split('\0')[0]) - Number(b.split('\0')[0])
      return hours || a.localeCompare(b)
    })
    .map(([, entries]) => {
      const horizonHours = entries[0].horizonHours
      const amounts = sortedRaw(entries.map((row) => row.testedCallableLowerBoundRaw))
      return {
        horizonHours,
        boundEligibleCohorts: entries.length,
        uniqueIssueClusters: new Set(entries.map((row) => row.issueClusterSha256)).size,
        measuredCells: entries.reduce((sum, row) => sum + row.measuredCells, 0),
        qUnit: entries[0].qUnit,
        unitStatus: entries[0].qUnit == null ? 'missing' : 'recorded',
        displayComparableAssetAmount: entries[0].qUnit === 'asset_raw',
        testedCallableLowerBoundMinRaw: amounts[0],
        testedCallableLowerBoundMedianRaw: amounts[Math.floor((amounts.length - 1) / 2)],
        testedCallableLowerBoundMaxRaw: amounts.at(-1),
        orderStatistic: 'min_lower_median_max',
        orderStatisticBasis: 'descriptive_sample',
        populationQuantile: false,
        zeroSentinelMeansNoCallableTestedTier: true,
        noCallableTestedTierCohorts: entries.filter((row) => row.noCallableTestedTier).length,
        aboveTestCeilingUnknownCohorts: entries.filter((row) => row.aboveTestCeilingUnknown).length,
        // Per-cohort values retain labels; a label is not transferred across variable Q ladders.
        cohorts: entries,
      }
    })
}

function sampledStateEvidence(subject) {
  const trajectories = new Map()
  for (const row of subject.episodes) {
    if (!row.analysisPrimaryForCell || !row.holderCommitment) continue
    const key = [
      row.issueClusterSha256,
      row.holderCommitment,
      row.issueAtUtc,
      row.qRaw,
      taggedUnit(row.qUnit),
    ].join('\0')
    const trajectory = trajectories.get(key) ?? {
      issueClusterSha256: row.issueClusterSha256,
      holderCommitment: row.holderCommitment,
      qRaw: row.qRaw,
      qUnit: row.qUnit ?? null,
      rows: [],
    }
    trajectory.rows.push(row)
    trajectories.set(key, trajectory)
  }
  const observations = []
  const abstentions = {}
  for (const trajectory of trajectories.values()) {
    const measured = trajectory.rows
      .filter((row) => MEASURED.has(row.baseline) && MEASURED.has(row.outcome.status))
      .sort((a, b) => a.plannedHorizonHours - b.plannedHorizonHours)
    if (!measured.length) {
      bump(abstentions, 'no_measured_horizon')
      continue
    }
    const baselines = new Set(measured.map((row) => row.baseline))
    if (baselines.size !== 1) {
      bump(abstentions, 'baseline_state_conflict')
      continue
    }
    if (new Set(measured.map((row) => row.plannedHorizonHours)).size !== measured.length) {
      bump(abstentions, 'duplicate_horizon')
      continue
    }
    if (
      measured.some(
        (row, index) =>
          index > 0 &&
          (clock(row.targetAtUtc) <= clock(measured[index - 1].targetAtUtc) ||
            clock(row.observedAtUtc) <= clock(measured[index - 1].observedAtUtc)),
      )
    ) {
      bump(abstentions, 'nonmonotone_observation_clocks')
      continue
    }
    const baseline = measured[0].baseline
    const changedAt = measured.findIndex((row) => row.outcome.status !== baseline)
    const common = {
      issueClusterSha256: trajectory.issueClusterSha256,
      holderCommitment: trajectory.holderCommitment,
      qRaw: trajectory.qRaw,
      qUnit: trajectory.qUnit,
      baselineState: baseline,
      measuredHorizons: measured.length,
    }
    if (changedAt >= 0) {
      const lowerClock = changedAt
        ? measured[changedAt - 1].observedAtUtc
        : (measured[0].baselineAtUtc ?? null)
      const upperClock = measured[changedAt].observedAtUtc
      observations.push({
        ...common,
        lastSameStateSampleHours: changedAt ? measured[changedAt - 1].plannedHorizonHours : null,
        lastSameStateObservedAtUtc: changedAt ? lowerClock : null,
        differentStateObservedAtUtc: upperClock,
        observedDifferentStateWindow:
          lowerClock && clock(lowerClock) < clock(upperClock)
            ? {
                afterObservedAtUtc: lowerClock,
                byObservedAtUtc: upperClock,
                lastSameStatePlannedHorizonHours: changedAt
                  ? measured[changedAt - 1].plannedHorizonHours
                  : null,
                differentStatePlannedHorizonHours: measured[changedAt].plannedHorizonHours,
              }
            : null,
      })
    } else {
      observations.push({
        ...common,
        lastSameStateSampleHours: measured.at(-1).plannedHorizonHours,
        lastSameStateObservedAtUtc: measured.at(-1).observedAtUtc,
        differentStateObservedAtUtc: null,
        observedDifferentStateWindow: null,
      })
    }
  }
  return {
    attemptedTrajectories: trajectories.size,
    measuredTrajectories: observations.length,
    observedDifferentStateWindows: observations.filter(
      (row) => row.observedDifferentStateWindow != null,
    ).length,
    sameStateAtLastSampleTrajectories: observations.filter(
      (row) => row.differentStateObservedAtUtc == null,
    ).length,
    abstentions,
    durationProjection: null,
    observations,
  }
}

function buildFromPanel(panel, verifiedReader) {
  const rawRows = validatePanel(panel)
  let latestSourceMs = null
  for (const subject of panel.subjects)
    for (const row of subject.episodes)
      for (const value of [
        row.baselineAtUtc,
        row.issueAtUtc,
        row.observedAtUtc,
        row.labelAvailableAtUtc,
      ])
        if (value != null) latestSourceMs = Math.max(latestSourceMs ?? 0, clock(value))
  const historicalDataThroughUtc =
    latestSourceMs == null ? null : new Date(latestSourceMs).toISOString()
  const subjects = panel.subjects.map((subject) => {
    const cohorts = measuredPresentCohorts(subject)
    const sampledState = sampledStateEvidence(subject)
    return {
      routeKey: subject.routeKey,
      destination: subject.destination.toLowerCase(),
      asset: subject.asset.toLowerCase(),
      subject: identity(subject),
      stageScope: subject.stageScope,
      status: !subject.episodes.length
        ? 'no_episodes'
        : cohorts.eligibleBounds.length
          ? 'historical_tested_bounds'
          : cohorts.fullyMeasuredPresentCount
            ? 'no_eligible_tested_bounds'
            : 'no_fully_measured_present_cohorts',
      rawRows: subject.episodes.length,
      primaryRows: subject.episodes.filter((row) => row.analysisPrimaryForCell).length,
      uniqueIssueClusters: new Set(
        subject.episodes
          .filter((row) => row.analysisPrimaryForCell)
          .map((row) => row.issueClusterSha256),
      ).size,
      attemptedCohorts: cohorts.attempted,
      fullyMeasuredPresentCohorts: cohorts.fullyMeasuredPresentCount,
      boundEligibleCohorts: cohorts.eligibleBounds.length,
      cohortAbstentions: cohorts.abstentions,
      measuredPresentCells: subject.episodes.filter(
        (row) =>
          row.analysisPrimaryForCell &&
          MEASURED.has(row.baseline) &&
          MEASURED.has(row.outcome.status),
      ).length,
      boundEligibleMeasuredCells: cohorts.eligibleBounds.reduce(
        (sum, row) => sum + row.measuredCells,
        0,
      ),
      historicalTestedAmountBoundsByHorizon: testedAmountBounds(cohorts.eligibleBounds),
      primaryAssays: subject.episodes
        .filter((row) => row.analysisPrimaryForCell)
        .map((row) => ({
          issueClusterSha256: row.issueClusterSha256,
          holderCommitment: row.holderCommitment ?? null,
          qRaw: row.qRaw,
          qUnit: row.qUnit ?? null,
          horizonHours: row.plannedHorizonHours,
          baselineState: row.baseline ?? null,
          outcomeState: row.outcome.status,
          censorReason: MEASURED.has(row.outcome.status)
            ? null
            : (row.outcome.reason ?? row.outcome.status),
        })),
      sampledStateEvidence: sampledState,
      amountProjection: null,
      durationProjection: null,
    }
  })
  const boundedSubjects = subjects.filter(
    (subject) => subject.status === 'historical_tested_bounds',
  )
  return {
    version: HOLDER_EXIT_HISTORICAL_PROJECTION_VERSION,
    scope: 'historical_tested_amount_bounds',
    claimClass: 'historical_tested_callable_lower_bounds',
    sourceVerification: verifiedReader ? 'offline_sealed_replay' : 'untrusted_input',
    manifestSha256: panel.manifestSha256,
    historicalDataThroughUtc,
    historicalDataThroughClockBasis: 'saved_local_panel_clocks',
    historicalDataThroughIndependentlyWitnessed: false,
    prospectiveValidated: false,
    forecastValidated: false,
    statisticalIndependenceValidated: false,
    populationQuantile: false,
    holderExecutableCapacity: false,
    routeLevelProbability: null,
    amountProjection: null,
    durationProjection: null,
    expectedIssuedQLadderVerified: false,
    summary: {
      routeGroups: new Set(subjects.map((subject) => subject.routeKey)).size,
      exactSubjects: subjects.length,
      rawRows,
      historicalTestedBoundsSubjects: boundedSubjects.length,
      historicalTestedBoundsRouteGroups: new Set(boundedSubjects.map((subject) => subject.routeKey))
        .size,
      recordedUnitBoundsSubjects: boundedSubjects.filter((subject) =>
        subject.historicalTestedAmountBoundsByHorizon.some((row) => row.unitStatus === 'recorded'),
      ).length,
      displayComparableAssetAmountSubjects: boundedSubjects.filter((subject) =>
        subject.historicalTestedAmountBoundsByHorizon.some(
          (row) => row.displayComparableAssetAmount,
        ),
      ).length,
      missingUnitBoundsSubjects: boundedSubjects.filter((subject) =>
        subject.historicalTestedAmountBoundsByHorizon.some((row) => row.unitStatus === 'missing'),
      ).length,
      noFullyMeasuredPresentCohortSubjects: subjects.filter(
        (subject) => subject.status === 'no_fully_measured_present_cohorts',
      ).length,
      noEligibleTestedBoundsSubjects: subjects.filter(
        (subject) => subject.status === 'no_eligible_tested_bounds',
      ).length,
      noEpisodeSubjects: subjects.filter((subject) => subject.status === 'no_episodes').length,
      fullyMeasuredPresentCohorts: subjects.reduce(
        (sum, subject) => sum + subject.fullyMeasuredPresentCohorts,
        0,
      ),
      boundEligibleCohorts: subjects.reduce(
        (sum, subject) => sum + subject.boundEligibleCohorts,
        0,
      ),
      uniqueIssueClusters: new Set(
        panel.subjects.flatMap((subject) =>
          subject.episodes
            .filter((row) => row.analysisPrimaryForCell)
            .map((row) => `${identity(subject)}\0${row.issueClusterSha256}`),
        ),
      ).size,
      measuredTrajectories: subjects.reduce(
        (sum, subject) => sum + subject.sampledStateEvidence.measuredTrajectories,
        0,
      ),
      measuredPresentCells: subjects.reduce(
        (sum, subject) => sum + subject.measuredPresentCells,
        0,
      ),
      boundEligibleMeasuredCells: subjects.reduce(
        (sum, subject) => sum + subject.boundEligibleMeasuredCells,
        0,
      ),
      aboveTestCeilingUnknownCohorts: subjects.reduce(
        (sum, subject) =>
          sum +
          (subject.historicalTestedAmountBoundsByHorizon ?? []).reduce(
            (subtotal, horizon) => subtotal + horizon.aboveTestCeilingUnknownCohorts,
            0,
          ),
        0,
      ),
      observedDifferentStateWindows: subjects.reduce(
        (sum, subject) => sum + subject.sampledStateEvidence.observedDifferentStateWindows,
        0,
      ),
      sameStateAtLastSampleTrajectories: subjects.reduce(
        (sum, subject) => sum + subject.sampledStateEvidence.sameStateAtLastSampleTrajectories,
        0,
      ),
    },
    subjects,
  }
}

export function buildHolderExitHistoricalProjection(panel) {
  return buildFromPanel(panel, false)
}

export async function readVerifiedHolderExitHistoricalProjection(options = {}) {
  const { readVerifiedHolderExitEpisodePanel } = await import('./holder-exit-episode-panel.mjs')
  const panel = await readVerifiedHolderExitEpisodePanel(options)
  requireValid(panel.sourceVerification === 'offline_sealed_replay', 'source_unverified')
  return buildFromPanel(panel, true)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readVerifiedHolderExitHistoricalProjection()
    .then((projection) => console.log(JSON.stringify(projection)))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
