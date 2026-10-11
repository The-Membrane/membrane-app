/** Offline retrospective source-time scoring; never creates a provider or a historical live issue. */
import { createHash } from 'node:crypto'
import { statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import * as identityModule from '../../lib/carry/conditionalSampledCashPathProjection.ts'
const identityFor =
  identityModule.registeredConditionalSampledCashIdentity ??
  identityModule.default?.registeredConditionalSampledCashIdentity
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const AUDIT_PATH =
  'data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json'
const PINS_PATH = 'data/research/venue-signals/conditional-sampled-cash-history-v1.pins.json'
export const AUDIT_SHA = '02e5fef639fa564e0b6e07487415aabd673e5055f6e6d9f64c8f76643e0c7917'
const PINS_SHA = '8b40e48d29ab5d39c7e37ca91f2a398f9797ad2da9478a41cff74ee48f20d3b0'
const CORE_MANIFEST = '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3'
const SUPP_MANIFEST = '11647d6e15a5f6d18d96d016e5522b1dcbf452b45022992dd139c2fa9a0d6ede'
export const MAX_UINT = (1n << 256n) - 1n
export const HORIZONS = Object.freeze([1, 24, 48, 168])
const hash = (s) => createHash('sha256').update(s).digest('hex')
const approvedAudits = new WeakSet()
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const raw = (x) =>
  typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x) && x.length <= 78 && BigInt(x) <= MAX_UINT
const utc = (x) =>
  typeof x === 'string' &&
  Number.isFinite(Date.parse(x)) &&
  new Date(Date.parse(x)).toISOString() === x
const sealed = (x) => {
  const { sha256, ...body } = x
  return typeof sha256 === 'string' && hash(JSON.stringify(body)) === sha256
}
/** Real file bytes are fixed-fd bounded, then matched to an external immutable trust pin. */
export function authenticateArtifacts(auditText, pinsText) {
  if (
    typeof auditText !== 'string' ||
    typeof pinsText !== 'string' ||
    hash(auditText) !== AUDIT_SHA ||
    hash(pinsText) !== PINS_SHA
  )
    throw Error('holdout_artifact_pin_mismatch')
  const audit = JSON.parse(auditText),
    pins = JSON.parse(pinsText)
  if (
    !sealed(audit) ||
    !sealed(pins) ||
    audit.schemaVersion !== 1 ||
    audit.pinArtifactSha256 !== pins.sha256 ||
    JSON.stringify(audit.profile) !== JSON.stringify(pins.profile)
  )
    throw Error('holdout_seal_mismatch')
  if (
    Object.keys(audit.histories).length !== 64 ||
    audit.exclusions.length !== 4 ||
    audit.profile.cohort !== 'frozen-aug2026-plus-aave-usde-v1'
  )
    throw Error('holdout_roster_mismatch')
  for (const [key, h] of Object.entries(audit.histories)) {
    validateHistory(h)
    const native = identityFor(h.identity.routeKey, h.identity.destination),
      pin = pins.pins[key]
    if (
      !native ||
      JSON.stringify(native) !== JSON.stringify(h.identity) ||
      !pin ||
      pin.compactSha256 !== hash(JSON.stringify(h)) ||
      pin.assetDecimals !== h.identity.assetDecimals ||
      ['manifestSha256', 'lastDailyReceiptSha256', 'availableAt'].some(
        (k) => h.witness[k] !== pin[k],
      )
    )
      throw Error('holdout_history_pin_mismatch')
    if (![CORE_MANIFEST, SUPP_MANIFEST].includes(h.witness.manifestSha256))
      throw Error('holdout_manifest_mismatch')
  }
  const approved = freeze(structuredClone(audit))
  approvedAudits.add(approved)
  return approved
}
export function loadPinnedAudit() {
  const budget = { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, totalBytes: 0 }
  return authenticateArtifacts(
    readBoundedReceiptFile(resolve(ROOT, AUDIT_PATH), budget),
    readBoundedReceiptFile(resolve(ROOT, PINS_PATH), budget),
  )
}
export function validateHistory(h) {
  if (
    !record(h) ||
    !record(h.identity) ||
    typeof h.identity.routeKey !== 'string' ||
    !/^0x[0-9a-f]{40}$/.test(h.identity.destination ?? '') ||
    !/^0x[0-9a-f]{40}$/.test(h.identity.asset ?? '') ||
    !Number.isInteger(h.identity.assetDecimals) ||
    h.identity.assetDecimals < 0 ||
    h.identity.assetDecimals > 36 ||
    !record(h.witness) ||
    !utc(h.witness.availableAt) ||
    !Array.isArray(h.points) ||
    h.points.length < 2 ||
    h.points.length > 120
  )
    throw Error('holdout_history_invalid')
  for (const [i, p] of h.points.entries()) {
    if (
      !Array.isArray(p) ||
      p.length !== 5 ||
      !Number.isSafeInteger(p[0]) ||
      p[0] < 0 ||
      !raw(p[1]) ||
      p[1] === '0' ||
      typeof p[2] !== 'string' ||
      !/^0x[0-9a-f]{64}$/.test(p[2]) ||
      !utc(p[3]) ||
      !raw(p[4]) ||
      Date.parse(p[3]) > Date.parse(h.witness.availableAt)
    )
      throw Error('holdout_point_invalid')
    if (
      i &&
      (p[0] <= h.points[i - 1][0] ||
        BigInt(p[1]) <= BigInt(h.points[i - 1][1]) ||
        Date.parse(p[3]) <= Date.parse(h.points[i - 1][3]))
    )
      throw Error('holdout_point_order')
  }
}
export function floorSigned(n, d) {
  if (typeof n !== 'bigint' || typeof d !== 'bigint' || d <= 0n)
    throw Error('holdout_fraction_invalid')
  return n >= 0n ? n / d : -((-n + d - 1n) / d)
}
/** Public durations are seconds; native arithmetic uses the live kernel's exact millisecond bound. */
export function translateCash(origin, delta, targetSeconds, donorSeconds) {
  if (typeof targetSeconds !== 'number' || typeof donorSeconds !== 'number')
    return { status: 'censored', reason: 'invalid_native_input' }
  return translateCashMilliseconds(origin, delta, targetSeconds * 1000, donorSeconds * 1000)
}
function translateCashMilliseconds(origin, delta, targetMs, donorMs) {
  if (
    !raw(origin) ||
    typeof delta !== 'bigint' ||
    delta < -MAX_UINT ||
    delta > MAX_UINT ||
    !Number.isSafeInteger(targetMs) ||
    targetMs <= 0 ||
    !Number.isSafeInteger(donorMs) ||
    donorMs <= 0
  )
    return { status: 'censored', reason: 'invalid_native_input' }
  // Match checked(delta * elapsedMs) BEFORE division or the physical zero floor.
  const numerator = delta * BigInt(targetMs)
  if (numerator < -MAX_UINT || numerator > MAX_UINT)
    return { status: 'censored', reason: 'native_intermediate_overflow' }
  const translated = BigInt(origin) + floorSigned(numerator, BigInt(donorMs))
  if (translated < -MAX_UINT || translated > MAX_UINT)
    return { status: 'censored', reason: 'native_intermediate_overflow' }
  return { status: 'estimated', cashRaw: (translated < 0n ? 0n : translated).toString() }
}
/** Every strictly earlier donor is retained, including gaps and arithmetic censors. */
export function scoreFold(history, originIndex, targetIndex) {
  const points = history.points,
    origin = points[originIndex],
    target = points[targetIndex]
  if (!origin || !target || originIndex < 2 || targetIndex <= originIndex)
    throw Error('holdout_fold_invalid')
  const targetMs = Date.parse(target[3]) - Date.parse(origin[3]),
    dt = targetMs / 1000
  const donors = []
  for (let end = 1; end < originIndex; end++) {
    const a = points[end - 1],
      b = points[end],
      donorMs = Date.parse(b[3]) - Date.parse(a[3]),
      seconds = donorMs / 1000
    const result =
      b[0] !== a[0] + 1 || seconds > 91800 || donorMs <= 0 || !Number.isSafeInteger(donorMs)
        ? { status: 'censored', reason: 'donor_gap' }
        : translateCashMilliseconds(origin[4], BigInt(b[4]) - BigInt(a[4]), targetMs, donorMs)
    donors.push({
      startAnchor: a[0],
      endAnchor: b[0],
      sourceStart: a[3],
      sourceEnd: b[3],
      elapsedSeconds: seconds,
      ...result,
    })
  }
  const censored = donors.filter((d) => d.status !== 'estimated'),
    n = donors.length
  const base = {
    originAnchor: origin[0],
    targetAnchor: target[0],
    originSource: { block: origin[1], blockHash: origin[2], blockTime: origin[3] },
    targetSource: { block: target[1], blockHash: target[2], blockTime: target[3] },
    originCashRaw: origin[4],
    actualTargetCashRaw: target[4],
    elapsedSeconds: dt,
    donorCandidates: n,
    donorCensored: censored.length,
    donorDetailsSha256: hash(JSON.stringify(donors)),
    latestDonorEndAt: donors.at(-1)?.sourceEnd ?? null,
  }
  if (censored.length)
    return {
      ...base,
      status: 'censored',
      censorReasons: Object.fromEntries(
        [...new Set(censored.map((d) => d.reason))].map((r) => [
          r,
          censored.filter((d) => d.reason === r).length,
        ]),
      ),
      distribution: null,
      thresholds: null,
    }
  const xs = donors.map((d) => BigInt(d.cashRaw)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    actual = BigInt(target[4])
  const percentile = (p) => xs[Math.floor(((n - 1) * p) / 100)],
    p10 = percentile(10),
    p50 = percentile(50),
    p90 = percentile(90),
    error = p50 - actual
  const thresholds = [10, 50, 90].map((percent) => {
    const q = (BigInt(origin[4]) * BigInt(percent)) / 100n,
      covering = xs.filter((x) => x >= q).length
    return {
      originCashPercent: percent,
      requestedRaw: q.toString(),
      positiveQ: q > 0n,
      actualCashCoversQ: actual >= q,
      medianCashCoversQ: p50 >= q,
      scenarioCashCoversQ: { numerator: covering, denominator: n },
    }
  })
  return {
    ...base,
    status: 'scored',
    distribution: {
      p10Raw: p10.toString(),
      p50Raw: p50.toString(),
      p90Raw: p90.toString(),
      minimumRaw: xs[0].toString(),
      maximumRaw: xs.at(-1).toString(),
    },
    signedMedianErrorRaw: error.toString(),
    absoluteMedianErrorRaw: (error < 0n ? -error : error).toString(),
    persistenceAbsoluteErrorRaw: (BigInt(origin[4]) > actual
      ? BigInt(origin[4]) - actual
      : actual - BigInt(origin[4])
    ).toString(),
    empiricalBandContainsActual: actual >= p10 && actual <= p90,
    fullRangeContainsActual: actual >= xs[0] && actual <= xs.at(-1),
    thresholds,
  }
}
export function scoreHistory(history, horizonHours) {
  validateHistory(history)
  if (!HORIZONS.includes(horizonHours)) throw Error('holdout_horizon_invalid')
  const labels = new Map(history.points.map((p, i) => [Date.parse(p[3]), i]))
  const result = {
    horizonHours,
    candidateOrigins: Math.max(0, history.points.length - 2),
    exactLabels: 0,
    missingExactLabels: 0,
    scoredFolds: 0,
    censoredFolds: 0,
    donorCandidates: 0,
    donorCensored: 0,
    censorReasons: {},
    censoredExamples: [],
    empiricalBandContainsActual: 0,
    fullRangeContainsActual: 0,
    medianAbsoluteErrorSumRaw: '0',
    persistenceAbsoluteErrorSumRaw: '0',
    signedMedianErrorSumRaw: '0',
    thresholdDiagnostics: [10, 50, 90].map((percent) => ({
      originCashPercent: percent,
      scoredFolds: 0,
      positiveQFolds: 0,
      zeroQFolds: 0,
      actualCashCoversQ: 0,
      medianCashCoversQ: 0,
      medianFalsePositive: 0,
      medianFalseNegative: 0,
    })),
    worstFolds: [],
    foldDetailsSha256: null,
  }
  let abs = 0n,
    persistence = 0n,
    signed = 0n
  const digest = createHash('sha256')
  for (let i = 2; i < history.points.length; i++) {
    const targetTime = Date.parse(history.points[i][3]) + horizonHours * 3600000,
      j = labels.get(targetTime)
    if (j === undefined) {
      result.missingExactLabels++
      digest.update(
        JSON.stringify({
          originAnchor: history.points[i][0],
          status: 'missing_exact_label',
          targetAt: new Date(targetTime).toISOString(),
        }) + '\n',
      )
      continue
    }
    result.exactLabels++
    const fold = scoreFold(history, i, j)
    digest.update(JSON.stringify(fold) + '\n')
    result.donorCandidates += fold.donorCandidates
    result.donorCensored += fold.donorCensored
    if (fold.status === 'censored') {
      result.censoredFolds++
      for (const [reason, count] of Object.entries(fold.censorReasons))
        result.censorReasons[reason] = (result.censorReasons[reason] ?? 0) + count
      if (result.censoredExamples.length < 3) result.censoredExamples.push(fold)
      continue
    }
    result.scoredFolds++
    abs += BigInt(fold.absoluteMedianErrorRaw)
    persistence += BigInt(fold.persistenceAbsoluteErrorRaw)
    signed += BigInt(fold.signedMedianErrorRaw)
    result.empiricalBandContainsActual += Number(fold.empiricalBandContainsActual)
    result.fullRangeContainsActual += Number(fold.fullRangeContainsActual)
    for (const [k, t] of fold.thresholds.entries()) {
      const d = result.thresholdDiagnostics[k]
      d.scoredFolds++
      d.positiveQFolds += Number(t.positiveQ)
      d.zeroQFolds += Number(!t.positiveQ)
      d.actualCashCoversQ += Number(t.actualCashCoversQ)
      d.medianCashCoversQ += Number(t.medianCashCoversQ)
      d.medianFalsePositive += Number(t.medianCashCoversQ && !t.actualCashCoversQ)
      d.medianFalseNegative += Number(!t.medianCashCoversQ && t.actualCashCoversQ)
    }
    result.worstFolds.push(fold)
    result.worstFolds.sort((a, b) =>
      BigInt(a.absoluteMedianErrorRaw) > BigInt(b.absoluteMedianErrorRaw)
        ? -1
        : BigInt(a.absoluteMedianErrorRaw) < BigInt(b.absoluteMedianErrorRaw)
          ? 1
          : a.originAnchor - b.originAnchor,
    )
    result.worstFolds.length = Math.min(3, result.worstFolds.length)
  }
  result.medianAbsoluteErrorSumRaw = abs.toString()
  result.persistenceAbsoluteErrorSumRaw = persistence.toString()
  result.signedMedianErrorSumRaw = signed.toString()
  result.foldDetailsSha256 = digest.digest('hex')
  result.labelAvailability = result.exactLabels
    ? 'exact_source_time_labels'
    : 'no_supported_exact_labels'
  result.meanMedianAbsoluteError = result.scoredFolds
    ? { numeratorRaw: abs.toString(), denominator: result.scoredFolds }
    : null
  result.meanPersistenceAbsoluteError = result.scoredFolds
    ? { numeratorRaw: persistence.toString(), denominator: result.scoredFolds }
    : null
  return result
}
export function buildReport(audit, builtAtUtc) {
  if (!approvedAudits.has(audit)) throw Error('holdout_unapproved_audit')
  if (!utc(builtAtUtc)) throw Error('holdout_build_clock_invalid')
  const destinations = [],
    totals = {
      core: { groups: 0, destinations: 0, horizons: {} },
      supplemental: { groups: 0, destinations: 0, horizons: {} },
    },
    groups = { core: new Set(), supplemental: new Set() }
  for (const [key, h] of Object.entries(audit.histories).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const lane =
      h.witness.manifestSha256 === CORE_MANIFEST
        ? 'core'
        : h.witness.manifestSha256 === SUPP_MANIFEST
          ? 'supplemental'
          : null
    if (!lane) throw Error('holdout_manifest_mismatch')
    if (Date.parse(builtAtUtc) < Date.parse(h.witness.availableAt))
      throw Error('holdout_build_precedes_knowledge')
    groups[lane].add(h.identity.routeKey)
    totals[lane].destinations++
    const horizons = HORIZONS.map((H) => scoreHistory(h, H))
    for (const score of horizons) {
      const t = (totals[lane].horizons[score.horizonHours] ??= {
        exactLabels: 0,
        scoredFolds: 0,
        censoredFolds: 0,
        missingExactLabels: 0,
      })
      for (const field of Object.keys(t)) t[field] += score[field]
    }
    destinations.push({
      subjectKey: key,
      lane,
      identity: h.identity,
      witness: h.witness,
      observations: h.points.length,
      firstAnchor: h.points[0][0],
      lastAnchor: h.points.at(-1)[0],
      horizons,
    })
  }
  for (const lane of Object.keys(totals)) totals[lane].groups = groups[lane].size
  const body = {
    schemaVersion: 1,
    status: 'retrospective_source_time_scoring',
    historicalIssueClockUnestablished: true,
    builtAtUtc,
    input: {
      path: AUDIT_PATH,
      fileSha256: AUDIT_SHA,
      bodySha256: audit.sha256,
      profile: audit.profile,
    },
    claim: 'conditional_underlying_cash_proxy_not_holder_exit_forecast',
    method: 'strictly_prior_interval_constant_net_cash_rate_to_exact_source_time_label',
    forecastValidated: false,
    calibratedProbability: false,
    holderExecutableExit: false,
    availability: {
      genuineWitnessTimesRetained: true,
      donorsNotAvailableAtHistoricalOrigins: true,
    },
    dependence: { overlappingFolds: true, reusedDonors: true, independentEpisodes: false },
    nativeAggregation: 'raw_errors_only_within_each_exact_destination_no_cross_asset_raw_average',
    quantiles: 'sorted_empirical_floor_index_p_times_n_minus_one',
    gapPolicy: 'any_censored_donor_prevents_fold_distribution_no_bad_path_dropped',
    thresholdPolicy: 'floor_origin_cash_times_10_50_90_percent_zero_thresholds_separate',
    totals,
    exclusions: audit.exclusions,
    destinations,
  }
  return { ...body, sha256: hash(JSON.stringify(body)) }
}
export function writeReport(report, path, freeBytes) {
  if (!record(report) || !sealed(report)) throw Error('holdout_report_seal_invalid')
  const text = JSON.stringify(report) + '\n',
    bytes = Buffer.byteLength(text)
  if (bytes > 2 * 1024 * 1024) throw Error('holdout_report_size')
  if (!Number.isSafeInteger(freeBytes) || freeBytes - bytes < 1024 ** 3)
    throw Error('holdout_disk_reserve')
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 })
  return { bytes, fileSha256: hash(text), bodySha256: report.sha256 }
}
export function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--out' || !args[1])
    throw Error('usage: --out <new-report.json>')
  const audit = loadPinnedAudit(),
    report = buildReport(audit, new Date().toISOString()),
    out = resolve(args[1]),
    s = statfsSync(dirname(out)),
    free = Number(s.bavail) * Number(s.bsize)
  const receipt = writeReport(report, out, free)
  process.stdout.write(JSON.stringify({ output: out, ...receipt, totals: report.totals }) + '\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
