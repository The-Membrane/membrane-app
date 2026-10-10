/** Offline source-time walk-forward selection. No provider, live issuance or calibration. */
import { createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadPinnedAudit,
  buildReport as buildBaselineReport,
  validateHistory,
  translateCash,
  HORIZONS,
  writeReport,
} from './conditional-cash-time-holdout.mjs'
export const CANDIDATES = Object.freeze([
  Object.freeze({ name: 'persistence', window: 0 }),
  ...[3, 7, 14, 30, 60].map((window) => Object.freeze({ name: 'last_' + window, window })),
  Object.freeze({ name: 'all', window: null }),
])
const hash = (s) => createHash('sha256').update(s).digest('hex')
const abs = (n) => (n < 0n ? -n : n)
const metric = () => ({
  scoredFolds: 0,
  censoredFolds: 0,
  censorReasons: {},
  absoluteErrorSumRaw: '0',
  signedErrorSumRaw: '0',
  meanAbsoluteError: null,
})
/** Window membership depends on strictly older interval endpoints, never target outcomes. */
export function candidateForecasts(history, originIndex, H) {
  const ps = history.points,
    origin = ps[originIndex]
  if (!origin || originIndex < 2 || !HORIZONS.includes(H)) throw Error('causal_fold_invalid')
  const donors = []
  for (let end = 1; end < originIndex; end++) {
    const a = ps[end - 1],
      b = ps[end],
      ms = Date.parse(b[3]) - Date.parse(a[3])
    const result =
      b[0] !== a[0] + 1 || !Number.isSafeInteger(ms) || ms <= 0 || ms > 91800000
        ? { status: 'censored', reason: 'donor_gap' }
        : translateCash(origin[4], BigInt(b[4]) - BigInt(a[4]), H * 3600, ms / 1000)
    donors.push({ startAnchor: a[0], endAnchor: b[0], endAt: b[3], ...result })
  }
  const persistence = {
    status: 'estimated',
    cashRaw: origin[4],
    donorCandidates: 0,
    donorCensored: 0,
    donorDetailsSha256: null,
  }
  return [
    persistence,
    ...CANDIDATES.slice(1).map((c) => {
      const ds = c.window === null ? donors : donors.slice(-c.window),
        bad = ds.filter((d) => d.status !== 'estimated')
      const common = {
        donorCandidates: ds.length,
        donorCensored: bad.length,
        donorDetailsSha256: hash(JSON.stringify(ds)),
      }
      if (bad.length)
        return {
          ...common,
          status: 'censored',
          censorReasons: Object.fromEntries(
            [...new Set(bad.map((d) => d.reason))].map((reason) => [
              reason,
              bad.filter((d) => d.reason === reason).length,
            ]),
          ),
        }
      const xs = ds.map((d) => BigInt(d.cashRaw)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      return {
        ...common,
        status: 'estimated',
        cashRaw: xs[Math.floor((xs.length - 1) / 2)].toString(),
      }
    }),
  ]
}
/** Exact MAE comparison; censored validation candidates are not silently compared on easier labels. */
export function chooseCandidate(training, completedLabels) {
  if (completedLabels < 7) return 0
  let best = 0
  for (let i = 1; i < training.length; i++) {
    const a = training[i],
      b = training[best]
    if (a.censored || a.scored !== completedLabels) continue
    if (a.absolute * BigInt(b.scored) < b.absolute * BigInt(a.scored)) best = i
  }
  return best
}
function addMetric(m, forecast, actual) {
  if (forecast.status !== 'estimated') {
    m.censoredFolds++
    for (const [reason, count] of Object.entries(forecast.censorReasons ?? {}))
      m.censorReasons[reason] = (m.censorReasons[reason] ?? 0) + count
    return
  }
  const error = BigInt(forecast.cashRaw) - actual
  m.scoredFolds++
  m.absoluteErrorSumRaw = (BigInt(m.absoluteErrorSumRaw) + abs(error)).toString()
  m.signedErrorSumRaw = (BigInt(m.signedErrorSumRaw) + error).toString()
}
export function scoreCausalHistory(history, H) {
  validateHistory(history)
  if (!HORIZONS.includes(H)) throw Error('causal_horizon_invalid')
  const ps = history.points,
    labels = new Map(ps.map((p, i) => [Date.parse(p[3]), i])),
    training = CANDIDATES.map(() => ({ scored: 0, censored: 0, absolute: 0n })),
    pending = []
  const out = {
    horizonHours: H,
    candidateOrigins: ps.length - 2,
    exactLabels: 0,
    missingExactLabels: 0,
    selected: metric(),
    fixedCandidates: CANDIDATES.map((c) => ({ candidate: c.name, ...metric() })),
    selectionCounts: CANDIDATES.map((c) => ({ candidate: c.name, folds: 0 })),
    thresholdDiagnostics: [10, 50, 90].map((originCashPercent) => ({
      originCashPercent,
      labelledFolds: 0,
      scoredFolds: 0,
      censoredFolds: 0,
      positiveQFolds: 0,
      zeroQFolds: 0,
      actualCashCoversQ: 0,
      selectedCashCoversQ: 0,
      falseCoverage: 0,
      missedCoverage: 0,
    })),
    choices: [],
    worstFalseCoverage: [],
    worstAbsoluteErrors: [],
    foldDetailsSha256: null,
  }
  const digest = createHash('sha256')
  let cursor = 0,
    completed = 0,
    latest = null
  for (let i = 2; i < ps.length; i++) {
    const originTime = Date.parse(ps[i][3])
    // A target equal to origin is deliberately NOT a completed earlier validation label.
    while (cursor < pending.length && pending[cursor].targetMs < originTime) {
      const p = pending[cursor++]
      completed++
      latest = new Date(p.targetMs).toISOString()
      for (const [k, f] of p.forecasts.entries()) {
        if (f.status !== 'estimated') {
          training[k].censored++
          continue
        }
        training[k].scored++
        training[k].absolute += abs(BigInt(f.cashRaw) - p.actual)
      }
    }
    const chosen = chooseCandidate(training, completed),
      targetMs = originTime + H * 3600000,
      j = labels.get(targetMs)
    const causal = {
      originAnchor: ps[i][0],
      chosenCandidate: chosen,
      completedValidationLabels: completed,
      latestValidationTargetAt: latest,
      training: training.map((t) => ({
        scored: t.scored,
        censored: t.censored,
        absoluteErrorSumRaw: t.absolute.toString(),
      })),
    }
    if (j === undefined) {
      out.missingExactLabels++
      digest.update(
        JSON.stringify({
          ...causal,
          status: 'missing_exact_label',
          targetAt: new Date(targetMs).toISOString(),
        }) + '\n',
      )
      continue
    }
    const forecasts = candidateForecasts(history, i, H),
      actual = BigInt(ps[j][4]),
      selected = forecasts[chosen]
    out.exactLabels++
    out.selectionCounts[chosen].folds++
    out.choices.push([ps[i][0], ps[j][0], chosen, completed, latest])
    for (const [k, f] of forecasts.entries()) addMetric(out.fixedCandidates[k], f, actual)
    addMetric(out.selected, selected, actual)
    const thresholds = [10, 50, 90].map((percent) => {
      const q = (BigInt(ps[i][4]) * BigInt(percent)) / 100n,
        positive = q > 0n,
        actualCovers = actual >= q,
        predicted = selected.status === 'estimated' ? BigInt(selected.cashRaw) >= q : null
      const d = out.thresholdDiagnostics[[10, 50, 90].indexOf(percent)]
      d.labelledFolds++
      d.positiveQFolds += Number(positive)
      d.zeroQFolds += Number(!positive)
      d.actualCashCoversQ += Number(actualCovers)
      if (predicted === null) d.censoredFolds++
      else {
        d.scoredFolds++
        d.selectedCashCoversQ += Number(predicted)
        d.falseCoverage += Number(predicted && !actualCovers)
        d.missedCoverage += Number(!predicted && actualCovers)
      }
      return {
        originCashPercent: percent,
        requestedRaw: q.toString(),
        positiveQ: positive,
        actualCashCoversQ: actualCovers,
        selectedCashCoversQ: predicted,
      }
    })
    const fold = {
      ...causal,
      targetAnchor: ps[j][0],
      originAt: ps[i][3],
      targetAt: ps[j][3],
      originCashRaw: ps[i][4],
      actualTargetCashRaw: ps[j][4],
      forecasts,
      thresholds,
    }
    digest.update(JSON.stringify(fold) + '\n')
    const publicFold = {
      originAnchor: ps[i][0],
      targetAnchor: ps[j][0],
      originAt: ps[i][3],
      targetAt: ps[j][3],
      chosenCandidate: CANDIDATES[chosen].name,
      completedValidationLabels: completed,
      latestValidationTargetAt: latest,
      originCashRaw: ps[i][4],
      forecastCashRaw: selected.cashRaw ?? null,
      actualTargetCashRaw: ps[j][4],
    }
    if (selected.status === 'estimated') {
      const error = abs(BigInt(selected.cashRaw) - actual)
      out.worstAbsoluteErrors.push({ ...publicFold, absoluteErrorRaw: error.toString() })
      out.worstAbsoluteErrors.sort((a, b) =>
        BigInt(a.absoluteErrorRaw) > BigInt(b.absoluteErrorRaw)
          ? -1
          : BigInt(a.absoluteErrorRaw) < BigInt(b.absoluteErrorRaw)
            ? 1
            : a.originAnchor - b.originAnchor,
      )
      out.worstAbsoluteErrors.length = Math.min(3, out.worstAbsoluteErrors.length)
      for (const t of thresholds)
        if (t.selectedCashCoversQ && !t.actualCashCoversQ) {
          out.worstFalseCoverage.push({
            ...publicFold,
            ...t,
            actualShortfallRaw: (BigInt(t.requestedRaw) - actual).toString(),
          })
          out.worstFalseCoverage.sort((a, b) =>
            BigInt(a.actualShortfallRaw) > BigInt(b.actualShortfallRaw)
              ? -1
              : BigInt(a.actualShortfallRaw) < BigInt(b.actualShortfallRaw)
                ? 1
                : a.originAnchor - b.originAnchor,
          )
          out.worstFalseCoverage.length = Math.min(3, out.worstFalseCoverage.length)
        }
    }
    // Outcomes are unavailable to the selection state until the strict future maturation loop.
    pending.push({ targetMs, actual, forecasts })
  }
  for (const m of [out.selected, ...out.fixedCandidates])
    m.meanAbsoluteError = m.scoredFolds
      ? { numeratorRaw: m.absoluteErrorSumRaw, denominator: m.scoredFolds }
      : null
  out.foldDetailsSha256 = digest.digest('hex')
  out.labelAvailability = out.exactLabels ? 'exact_source_time_labels' : 'no_supported_exact_labels'
  return out
}
export function buildCausalReport(audit, builtAtUtc) {
  // Existing frozen scorer verifies that this exact immutable audit was externally pinned.
  const baseline = buildBaselineReport(audit, builtAtUtc),
    baselineByKey = new Map(baseline.destinations.map((d) => [d.subjectKey, d]))
  const destinations = Object.entries(audit.histories)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([subjectKey, h]) => {
      const old = baselineByKey.get(subjectKey)
      return {
        subjectKey,
        lane: old.lane,
        identity: h.identity,
        witness: h.witness,
        observations: h.points.length,
        horizons: HORIZONS.map((H) => {
          const score = scoreCausalHistory(h, H),
            all = old.horizons.find((s) => s.horizonHours === H)
          return {
            ...score,
            allDonorBaseline: {
              scoredFolds: all.scoredFolds,
              censoredFolds: all.censoredFolds,
              absoluteErrorSumRaw: all.medianAbsoluteErrorSumRaw,
              meanAbsoluteError: all.meanMedianAbsoluteError,
            },
          }
        }),
      }
    })
  const totals = {
    core: {
      groups: baseline.totals.core.groups,
      destinations: baseline.totals.core.destinations,
      horizons: {},
    },
    supplemental: { groups: 1, destinations: 1, horizons: {} },
  }
  for (const d of destinations)
    for (const h of d.horizons) {
      const t = (totals[d.lane].horizons[h.horizonHours] ??= {
        exactLabels: 0,
        selectedScoredFolds: 0,
        selectedCensoredFolds: 0,
        missingExactLabels: 0,
        vsPersistence: { betterDestinations: 0, equalDestinations: 0, worseDestinations: 0 },
        vsAllDonors: { betterDestinations: 0, equalDestinations: 0, worseDestinations: 0 },
      })
      t.exactLabels += h.exactLabels
      t.selectedScoredFolds += h.selected.scoredFolds
      t.selectedCensoredFolds += h.selected.censoredFolds
      t.missingExactLabels += h.missingExactLabels
      if (h.selected.scoredFolds) {
        for (const [name, m] of [
          ['vsPersistence', h.fixedCandidates[0]],
          ['vsAllDonors', h.allDonorBaseline],
        ]) {
          if (
            m.scoredFolds !== h.selected.scoredFolds ||
            m.censoredFolds !== h.selected.censoredFolds
          )
            continue
          const a = BigInt(h.selected.absoluteErrorSumRaw),
            b = BigInt(m.absoluteErrorSumRaw)
          t[name][
            a < b ? 'betterDestinations' : a > b ? 'worseDestinations' : 'equalDestinations'
          ]++
        }
      }
    }
  const body = {
    schemaVersion: 1,
    status: 'retrospective_source_time_walk_forward_selection',
    historicalIssueClockUnestablished: true,
    evaluationScope: 'retrospective_development_walk_forward_on_previously_exposed_snapshot',
    untouchedHoldout: false,
    priorStudy: 'carry-h24-subject-local-candidate-sweep-v1',
    builtAtUtc,
    input: baseline.input,
    claim: baseline.claim,
    forecastValidated: false,
    calibratedProbability: false,
    holderExecutableExit: false,
    availability: baseline.availability,
    dependence: baseline.dependence,
    nativeAggregation: baseline.nativeAggregation,
    selection: {
      criterion: 'expanding_mae_only_targets_strictly_before_current_origin',
      minimumCompletedValidationLabels: 7,
      default: 'persistence',
      ties: 'persistence_then_smaller_window_then_all',
      censoredCandidateValidation: 'ineligible_not_dropped_from_denominator',
      quantile: 'lower_empirical_median_floor_index',
      candidates: CANDIDATES,
      choiceTuple: [
        'originAnchor',
        'targetAnchor',
        'candidateIndex',
        'completedValidationLabels',
        'latestValidationTargetAt',
      ],
    },
    totals,
    exclusions: baseline.exclusions,
    destinations,
  }
  return { ...body, sha256: hash(JSON.stringify(body)) }
}
export function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--out' || !args[1])
    throw Error('usage: --out <new-report.json>')
  const report = buildCausalReport(loadPinnedAudit(), new Date().toISOString()),
    out = resolve(args[1]),
    s = statfsSync(dirname(out)),
    receipt = writeReport(report, out, Number(s.bavail) * Number(s.bsize))
  process.stdout.write(JSON.stringify({ output: out, ...receipt, totals: report.totals }) + '\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
