// Pure research adapter over DB-reconciled witnessed v2 labels. Historical
// successful vault events are covariates, never executable exit capacity.
import { evaluateWitnessedBoundLabelsV2 } from './scrvusd-bound-exit-evaluation.mjs'
import {
  readWitnessedBoundLabelsWithPgV2,
  WITNESSED_SCHEMA_V2,
} from './scrvusd-bound-prospective-exit-labels.mjs'

export const SCHEMA = 'scrvusd-v2-flow-evidence-matrix-v1'
const PERIODS = Object.freeze({ '24h': 86_400, '7d': 604_800 })
const GROSS = 'grossWithdrawals'
const NET = 'signedNetDepletion'
const UNSIGNED = /^(0|[1-9][0-9]*)$/
const SIGNED = /^-?(0|[1-9][0-9]*)$/
const utcMs = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
    ? Date.parse(value)
    : null
const issueKey = (ref) => JSON.stringify([ref?.filename, ref?.logicalSha256, ref?.physicalSha256])
const unavailable = (reason) => ({ status: 'unavailable', reason, valueRaw: null, window: null })

function observedWindow({ row, kind, period, seconds, coverageFrom, coverageEnd, cutoff }) {
  const start = utcMs(row.startUtc)
  const end = utcMs(row.endExclusiveUtc)
  const value = kind === GROSS ? row.grossWithdrawalsRaw : row.netDepletionRaw
  if (
    row.horizon !== period ||
    row.seconds !== seconds ||
    start === null ||
    end === null ||
    start < coverageFrom ||
    end > coverageEnd ||
    end > cutoff ||
    end - start !== seconds * 1000 ||
    typeof value !== 'string' ||
    !(kind === GROSS ? UNSIGNED : SIGNED).test(value)
  )
    throw new Error('Historical flow maximum violates as-of complete-window evidence')
  return {
    status: 'observed',
    valueRaw: value,
    window: { startUtc: row.startUtc, endExclusiveUtc: row.endExclusiveUtc },
  }
}

function flowFeatures(label) {
  const context = label.historicalFlowContext
  if (context === null || context === undefined) {
    if (label.historicalFlowStatus !== 'unavailable' && label.historicalFlowStatus !== null)
      throw new Error('Historical flow status differs from absent context')
    return Object.fromEntries(
      Object.keys(PERIODS).map((period) => [
        period,
        {
          [GROSS]: unavailable('no_issue_time_flow_context'),
          [NET]: unavailable('no_issue_time_flow_context'),
        },
      ]),
    )
  }
  if (label.historicalFlowStatus !== 'as_of_context')
    throw new Error('Historical flow status differs from present context')
  const cutoff = utcMs(context.evidenceCutoffUtc)
  const issued = utcMs(label.issuedAtUtc)
  const witnessed = utcMs(label.runVisibleAtUtc)
  if (
    cutoff === null ||
    issued === null ||
    witnessed === null ||
    cutoff > issued ||
    issued > witnessed
  )
    throw new Error('Historical flow evidence was not available by issue and run witness')
  const coverage = context.coverage
  const from = coverage === null ? null : utcMs(coverage?.fromUtc)
  const end = coverage === null ? null : utcMs(coverage?.endExclusiveUtc)
  if (coverage !== null && (from === null || end === null || end <= from || end > cutoff))
    throw new Error('Historical flow coverage extends past evidence cutoff')
  const fields = {
    [GROSS]: context.maximumObservedCompleteWindow,
    [NET]: context.maximumObservedCompleteWindowNetDepletion,
  }
  return Object.fromEntries(
    Object.entries(PERIODS).map(([period, seconds]) => [
      period,
      Object.fromEntries(
        Object.entries(fields).map(([kind, map]) => {
          const row = map?.[period]
          if (!row) return [kind, unavailable('no_complete_window_evidence')]
          if (row.status === 'unavailable') {
            if (
              typeof row.reason !== 'string' ||
              !row.reason ||
              row.horizon !== period ||
              row.seconds !== seconds
            )
              throw new Error('Malformed historical flow unavailable state')
            return [kind, unavailable(row.reason)]
          }
          if (row.status !== 'observed' || from === null || end === null)
            throw new Error('Observed historical flow maximum lacks complete coverage')
          return [
            kind,
            observedWindow({
              row,
              kind,
              period,
              seconds,
              coverageFrom: from,
              coverageEnd: end,
              cutoff,
            }),
          ]
        }),
      ),
    ]),
  )
}

function missingness(rows) {
  const output = {}
  for (const period of Object.keys(PERIODS)) {
    output[period] = {}
    for (const kind of [GROSS, NET]) {
      const unavailableReasons = {}
      let observed = 0
      for (const row of rows) {
        const feature = row.flowFeatures[period][kind]
        if (feature.status === 'observed') observed++
        else unavailableReasons[feature.reason] = (unavailableReasons[feature.reason] ?? 0) + 1
      }
      output[period][kind] = {
        observed,
        unavailable: rows.length - observed,
        unavailableReasons,
      }
    }
  }
  output.completeFourFeatureRows = rows.filter((row) =>
    Object.values(row.flowFeatures).every((period) =>
      Object.values(period).every((feature) => feature.status === 'observed'),
    ),
  ).length
  return output
}

// The caller supplies readWitnessedBoundLabelsWithPgV2 output, never the older
// retrospective label schema. This reducer has no filesystem, DB or RPC access.
export function buildV2FlowEvidenceMatrix({ labels, horizons }) {
  if (
    labels?.schema !== WITNESSED_SCHEMA_V2 ||
    labels?.witnessedRunCohortComplete !== true ||
    labels?.retainedReceiptVisibilityCertified !== true ||
    !Array.isArray(labels.rows)
  )
    throw new Error('Flow matrix requires DB-reconciled witnessed v2 labels')
  const evaluation = evaluateWitnessedBoundLabelsV2({ labels, horizons })
  const sources = new Map()
  for (const row of labels.rows) {
    const key = issueKey(row.issue)
    if (sources.has(key)) throw new Error('Duplicate witnessed issue reference')
    sources.set(key, row)
  }
  const byHorizon = evaluation.requestedHorizonsSeconds.map((requestedHorizonSeconds) => {
    // Reuse the evaluator's exact target risk set and per-H dependency groups.
    const selected = evaluateWitnessedBoundLabelsV2({ labels, horizons: [requestedHorizonSeconds] })
    const eligible = selected.rows.map((row) => {
      const source = sources.get(issueKey(row.issue))
      if (
        !source ||
        source.targetUtc !== row.targetUtc ||
        source.runVisibleAtUtc !== row.runVisibleAtUtc ||
        source.anchorBlock?.number !== row.anchorBlock?.number ||
        source.anchorBlock?.hash !== row.anchorBlock?.hash ||
        source.holder !== row.holder ||
        source.qAssetsRaw !== row.qAssetsRaw ||
        source.route !== row.route
      )
        throw new Error('Witnessed flow source differs from exact eligible issue')
      return {
        issue: row.issue,
        arm: row.arm,
        anchorBlock: row.anchorBlock,
        holder: row.holder,
        qAssetsRaw: row.qAssetsRaw,
        route: row.route,
        issuedAtUtc: row.issuedAtUtc,
        runVisibleAtUtc: row.runVisibleAtUtc,
        certifiedMinimumPublicationLeadSeconds: row.certifiedMinimumPublicationLeadSeconds,
        baselineSampleAgeSecondsAtWitness: row.baselineSampleAgeSecondsAtWitness,
        currentAtDecision: row.currentAtDecision,
        targetUtc: row.targetUtc,
        captureDeadlineUtc: row.captureDeadlineUtc,
        scoreStatus: row.scoreStatus,
        score: row.score,
        scoredAtUtc: row.scoredAtUtc,
        pointStatus: row.pointStatus,
        trajectoryStatus: row.trajectoryStatus,
        evidenceClass: row.evidenceClass,
        firstLossInterval: row.firstLossInterval,
        firstLossIntervalFromWitness: row.firstLossIntervalFromWitness,
        historicalFlowEvidenceCutoffUtc: source.historicalFlowContext?.evidenceCutoffUtc ?? null,
        historicalFlowCoverage: source.historicalFlowContext?.coverage ?? null,
        historicalFlowCompleteToFirstLive:
          source.historicalFlowContext?.completeToFirstLive ?? null,
        flowFeatures: flowFeatures(source),
      }
    })
    return {
      requestedHorizonSeconds,
      exactTargetToleranceSeconds: selected.byHorizon[0].exactTargetToleranceSeconds,
      witnessedRunArms: selected.armDenominators.total,
      allIssuedRiskSet: selected.denominators.allIssuedRiskSet,
      eligibleIssued: eligible.length,
      abstainedNoExactTarget: selected.byHorizon[0].abstainedNoExactTarget,
      outcomes: {
        observed: selected.byHorizon[0].observed,
        missing: selected.byHorizon[0].missing,
        ambiguous: selected.byHorizon[0].ambiguous,
        pending: selected.byHorizon[0].pending,
        maturedUnscored: selected.byHorizon[0].maturedUnscored,
      },
      featureMissingness: missingness(eligible),
      dependentClusters: selected.dependentClusters,
      dependencyComponentCount: selected.dependentClusters.length,
      independentEpisodeCount: null,
      rows: eligible,
    }
  })
  return {
    schema: SCHEMA,
    sourceLabelsSchema: WITNESSED_SCHEMA_V2,
    sourceEvaluationSchema: evaluation.schema,
    cohort: evaluation.cohort,
    asOfUtc: evaluation.asOfUtc,
    asOfSemantics: labels.asOfSemantics,
    historicalAvailabilityCertified: false,
    scheduledSlotCohortComplete: false,
    chronologicalBacktestEligible: false,
    requestedHorizonsSeconds: evaluation.requestedHorizonsSeconds,
    armDenominators: evaluation.armDenominators,
    byHorizon,
    forecast: { status: 'unavailable', probability: null, likelyDurationSeconds: null },
    alert: { status: 'unavailable' },
    caveat:
      'Gross withdrawals and signed net depletion are separate maxima of complete historical successful-vault-event windows. Neither measures holder-executable capacity, a protocol maximum, future runway or continuous exit ability. Dependence, missingness, and incomplete scheduled-slot coverage preclude a calibrated forecast or alert.',
  }
}

// Public research entry point: authenticate the retained issue/score receipts
// and their database witnesses before the pure matrix projection.
export async function readV2FlowEvidenceMatrix({ horizons, ...options } = {}) {
  const labels = await readWitnessedBoundLabelsWithPgV2(options)
  return buildV2FlowEvidenceMatrix({ labels, horizons })
}
