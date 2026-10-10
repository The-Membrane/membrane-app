// Read-only qualification inventory for NOW-origin direct exits. Counts describe
// issued observations, not independent trials, calibrated risk, or live alerts.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readEvaluation, SCHEMA as EVALUATION_SCHEMA } from './scrvusd-exit-duration-evaluation.mjs'

export const SCHEMA = 'scrvusd-exit-readiness-v1'

const countBy = (rows, key) =>
  Object.fromEntries(
    [...new Set(rows.map(key))]
      .sort()
      .map((value) => [value, rows.filter((row) => key(row) === value).length]),
  )

const issueKey = (issue) => JSON.stringify(issue)
const stratumKey = (row) =>
  JSON.stringify([row.holder.toLowerCase(), BigInt(row.qAssetsRaw).toString(), row.route])

function summarize(rows, clusters) {
  const selectedIssues = new Set(rows.map((row) => issueKey(row.issue)))
  const involvedClusters = clusters.filter((cluster) =>
    cluster.issues.some((issue) => selectedIssues.has(issueKey(issue))),
  )
  const classClusters = Object.fromEntries(
    [...new Set(rows.map((row) => row.evidenceClass))].sort().map((evidenceClass) => {
      const classIssues = new Set(
        rows.filter((row) => row.evidenceClass === evidenceClass).map((row) => issueKey(row.issue)),
      )
      return [
        evidenceClass,
        involvedClusters.filter((cluster) =>
          cluster.issues.some((issue) => classIssues.has(issueKey(issue))),
        ).length,
      ]
    }),
  )
  const observed = rows.filter((row) => row.scoreStatus === 'observed')
  return {
    issued: rows.length,
    scored: observed.length,
    pending: rows.length - observed.length,
    evidenceClasses: countBy(rows, (row) => row.evidenceClass),
    pointClasses: countBy(observed, (row) => row.pointStatus ?? 'unclassified'),
    firstLossSampledIntervals: rows
      .filter((row) => row.evidenceClass === 'first_loss_interval')
      .map((row) => ({ issue: row.issue, interval: row.firstLossInterval })),
    sampledPointSuccesses: observed.filter((row) => row.pointStatus === 'success').length,
    sampledPointReverts: observed.filter((row) => row.pointStatus === 'revert').length,
    rightCensored: rows.filter((row) => row.evidenceClass === 'right_censored').length,
    rightCensoredAmbiguous: rows.filter((row) => row.evidenceClass === 'right_censored_ambiguous')
      .length,
    missing: rows.filter((row) => row.evidenceClass === 'missing').length,
    providerAmbiguous: rows.filter((row) => row.evidenceClass === 'provider_ambiguous').length,
    maturedUnscored: rows.filter((row) => row.evidenceClass === 'matured_unscored').length,
    dependence: {
      overlappingWindowClusterCount: involvedClusters.length,
      clustersInvolvingEvidenceClass: classClusters,
      independentEpisodeCount: null,
    },
  }
}

// Synthetic evaluations are useful in tests. Production must call readExitReadiness
// so the underlying reader verifies source ledgers and applies the as-of cutoff.
export function buildExitReadiness(evaluation) {
  if (
    evaluation?.schema !== EVALUATION_SCHEMA ||
    !Array.isArray(evaluation.rows) ||
    !Array.isArray(evaluation.dependentClusters) ||
    !Array.isArray(evaluation.requestedHorizonsSeconds)
  )
    throw new Error('Invalid exit duration evaluation')
  const rows = evaluation.rows.filter((row) =>
    evaluation.requestedHorizonsSeconds.includes(row.horizonSeconds),
  )
  const byHorizon = evaluation.requestedHorizonsSeconds.map((horizonSeconds) => {
    const selected = rows.filter((row) => row.horizonSeconds === horizonSeconds)
    const strata = [...new Set(selected.map(stratumKey))].sort().map((key) => {
      const [holder, qAssetsRaw, route] = JSON.parse(key)
      return {
        holder,
        qAssetsRaw,
        route,
        ...summarize(
          selected.filter((row) => stratumKey(row) === key),
          evaluation.dependentClusters,
        ),
      }
    })
    const summary = summarize(selected, evaluation.dependentClusters)
    return {
      horizonSeconds,
      ...summary,
      strata,
      gates: {
        anyProspectiveIssues: {
          status: selected.length ? 'met' : 'unmet',
          issued: selected.length,
        },
        heterogeneousObservedPointClasses: {
          status:
            summary.sampledPointSuccesses > 0 && summary.sampledPointReverts > 0 ? 'met' : 'unmet',
          requiredPointClasses: ['success', 'revert'],
          classes: Object.keys(summary.pointClasses),
        },
        adequateIndependentEpisodes: { status: 'unproven' },
        chronologicalHoldout: { status: 'unproven' },
        baselineComparison: { status: 'unproven' },
        continuousDuration: { status: 'unproven' },
      },
    }
  })
  return {
    schema: SCHEMA,
    asOfUtc: evaluation.asOfUtc,
    requestedHorizonsSeconds: evaluation.requestedHorizonsSeconds,
    allIssued: evaluation.denominators.allIssued,
    requestedIssued: rows.length,
    byHorizon,
    promotion: {
      probability: 'unavailable',
      duration: 'unavailable',
      alert: 'unavailable',
    },
    caveat:
      'Overlapping-window clusters describe dependence, not independent calibrated events. Sampled successes and right censoring do not prove continuous availability or a clean no-loss interval.',
  }
}

export function readExitReadiness({
  asOfUtc = new Date().toISOString(),
  horizons = [],
  ...options
} = {}) {
  return buildExitReadiness(readEvaluation({ asOfUtc, horizons, ...options }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [asOfUtc = new Date().toISOString(), ...horizonArgs] = process.argv.slice(2)
    if (horizonArgs.some((value) => !/^[1-9][0-9]*$/.test(value)))
      throw new Error('Usage: [asOfUtc] [horizonSeconds ...]')
    console.log(JSON.stringify(readExitReadiness({ asOfUtc, horizons: horizonArgs.map(Number) })))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
