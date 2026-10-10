// Offline availability audit only. No outcome, quiet-day, or predictive inference.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_OUT as DEFAULT_BASELINE,
  readCheckpoint as readBaseline,
} from './aave-core-holder-witness.mjs'
import {
  DEFAULT_OUT as DEFAULT_FEATURES,
  readCheckpoint as readFeatures,
} from './aave-core-anchor-features.mjs'
import { MARKETS } from './aave-core-forward-panel.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isBlockHash = (value) => /^0x[0-9a-fA-F]{64}$/.test(value)
const validRatio = (ratio) =>
  ratio &&
  typeof ratio === 'object' &&
  /^-?\d+$/.test(ratio.numerator) &&
  /^\d+$/.test(ratio.denominator) &&
  BigInt(ratio.denominator) > 0n
const signalState = (record, field, reasonField) => {
  if (!Object.hasOwn(record, field) || !Object.hasOwn(record, reasonField)) return 'invalid'
  if (record[field] === null)
    return typeof record[reasonField] === 'string' && record[reasonField]
      ? 'unavailable'
      : 'invalid'
  return record[reasonField] === null && validRatio(record[field]?.signedGapFraction)
    ? 'available'
    : 'invalid'
}
const marketState = (base, feature, market) => {
  const baselineMarket = base.markets.find((row) => row.name === market.name)
  const featureMarket = feature.markets.find((row) => row.name === market.name)
  if (!baselineMarket || !featureMarket) return { captureStatus: 'missing-market-record' }
  const identity = (row) =>
    row.underlying?.toLowerCase() === market.base.toLowerCase() &&
    row.aToken?.toLowerCase() === market.aToken.toLowerCase()
  if (
    !identity(baselineMarket) ||
    !identity(featureMarket) ||
    baselineMarket.decimals !== market.decimals ||
    featureMarket.decimals !== market.decimals ||
    baselineMarket.quoteRaw !== '1000000000000' ||
    !Array.isArray(baselineMarket.candidates) ||
    !Array.isArray(baselineMarket.qualifyingHolders) ||
    !Number.isSafeInteger(baselineMarket.transferWindow?.logs) ||
    baselineMarket.transferWindow.logs < 0
  )
    return { captureStatus: 'invalid-market-record' }
  return {
    captureStatus: 'captured',
    signalAvailability: {
      rawCashProxy: signalState(featureMarket, 'rawCashProxy', 'rawCashProxyMissingReason'),
      strategyBorrowUsageModel: signalState(
        featureMarket,
        'strategyBorrowUsageModel',
        'strategyBorrowUsageMissingReason',
      ),
    },
  }
}
const dayOf = (seconds) => {
  if (!Number.isSafeInteger(seconds)) return null
  const millis = seconds * 1000
  if (!Number.isSafeInteger(millis)) return null
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}
const pilotTiming = (day, base) => {
  const start = Date.parse(`${day}T06:00:00Z`)
  const startEnd = Date.parse(`${day}T06:30:00Z`)
  const finishEnd = Date.parse(`${day}T07:00:00Z`)
  const inPilotDateRange = day >= '2026-09-26' && day <= '2026-10-09'
  const startCheck = (value) =>
    Number.isSafeInteger(value) ? value >= start && value <= startEnd : null
  const checks = {
    inPilotDateRange,
    witnessStartedInWindow: startCheck(base?.captureStartedAtMs),
    witnessFinishedBy07: Number.isSafeInteger(base?.observedAtMs)
      ? base.observedAtMs <= finishEnd
      : null,
  }
  const pilotWindowStatus = !inPilotDateRange
    ? 'outside-pilot-date-range'
    : checks.witnessFinishedBy07 === false
      ? 'out-of-window-end'
      : checks.witnessStartedInWindow === false
        ? 'out-of-window-start'
        : checks.witnessStartedInWindow === null || checks.witnessFinishedBy07 === null
          ? 'unknown-start-or-finish'
          : 'within-observed-window'
  return { checks, pilotWindowStatus }
}

export function auditAsOf({
  schedule,
  baselinePath = DEFAULT_BASELINE,
  featurePath = DEFAULT_FEATURES,
  requiredFeature = 'rawCashProxy',
}) {
  if (!Array.isArray(schedule) || schedule.length === 0) throw new Error('Frozen schedule required')
  if (!['rawCashProxy', 'strategyBorrowUsageModel'].includes(requiredFeature))
    throw new Error('Unknown required feature')
  const days = new Set()
  for (const slot of schedule) {
    if (
      !slot ||
      typeof slot.day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(slot.day) ||
      !Number.isSafeInteger(slot.decisionAtMs) ||
      !Number.isFinite(new Date(slot.decisionAtMs).getTime()) ||
      new Date(slot.decisionAtMs).toISOString().slice(0, 10) !== slot.day ||
      (slot.expectedBlock !== undefined &&
        (!Number.isSafeInteger(slot.expectedBlock) || slot.expectedBlock < 0)) ||
      (slot.expectedBlockHash !== undefined && !isBlockHash(slot.expectedBlockHash)) ||
      !(
        (slot.baselinePath === undefined && slot.featurePath === undefined) ||
        (slot.baselinePath === null && slot.featurePath === null) ||
        (typeof slot.baselinePath === 'string' &&
          slot.baselinePath &&
          typeof slot.featurePath === 'string' &&
          slot.featurePath)
      ) ||
      days.has(slot.day)
    )
      throw new Error('Invalid or duplicate frozen schedule row')
    days.add(slot.day)
  }

  // Each caller-supplied pair is checked against its bound baseline path. This
  // does not prove that the path was an immutable or preregistered daily file.
  // Null paths reserve a missing denominator day without fabricating quiet data.
  const sources = schedule.map((slot) => {
    if (slot.baselinePath === null) return { baselines: [], features: [], physicalSha: null }
    const bPath = slot.baselinePath ?? baselinePath
    const fPath = slot.featurePath ?? featurePath
    return {
      baselines: readBaseline(bPath).baselines,
      features: readFeatures(fPath, bPath).rows,
      physicalSha: slot.baselinePath === undefined ? null : hash(readFileSync(bPath)),
    }
  })

  const rows = schedule.flatMap((slot, index) =>
    MARKETS.map((market) => {
      const { baselines, features, physicalSha } = sources[index]
      const candidates = baselines.filter((row) => dayOf(row.blockTimestamp) === slot.day)
      const base =
        slot.expectedBlock === undefined
          ? candidates.length === 1
            ? candidates[0]
            : null
          : candidates.find((row) => row.block === slot.expectedBlock)
      const sameDayFeatures = features.filter((row) => dayOf(row.blockTimestamp) === slot.day)
      const feature = base ? sameDayFeatures.find((row) => row.block === base.block) : null
      const timing = pilotTiming(slot.day, base)
      const result = {
        day: slot.day,
        market: market.name,
        decisionAtMs: slot.decisionAtMs,
        expectedBlock: slot.expectedBlock ?? null,
        expectedBlockHash: slot.expectedBlockHash ?? null,
        baselineBlock: base?.block ?? null,
        baselineCaptureStartedAtMs: base?.captureStartedAtMs ?? null,
        featureCaptureStartedAtMs: feature?.captureStartedAtMs ?? null,
        featureObservedAtMs: feature?.observedAtMs ?? null,
        sourcePhysicalShaStatus: 'unavailable',
        pilotWindowChecks: timing.checks,
        pilotWindowStatus: timing.pilotWindowStatus,
        pilotEligibility: 'unproven',
      }
      const finish = (status, reason) => ({ ...result, status, reason })
      if (candidates.length === 0) {
        if (
          slot.expectedBlock !== undefined &&
          baselines.some((row) => row.block === slot.expectedBlock)
        )
          return finish('censored/invalid', 'baseline-day-mismatch')
        return finish('missing', 'baseline-day-absent')
      }
      if (!base)
        return finish(
          'censored/invalid',
          slot.expectedBlock === undefined ? 'ambiguous-baseline-day' : 'baseline-anchor-mismatch',
        )
      if (
        (slot.expectedBlock !== undefined && slot.expectedBlock !== base.block) ||
        (slot.expectedBlockHash !== undefined &&
          slot.expectedBlockHash.toLowerCase() !== base.blockHash.toLowerCase()) ||
        !Number.isSafeInteger(base.blockTimestamp) ||
        !Number.isSafeInteger(base.observedAtMs) ||
        base.observedAtMs < base.blockTimestamp * 1000
      )
        return finish('censored/invalid', 'baseline-anchor-mismatch')
      if (sameDayFeatures.length === 0) {
        if (features.some((row) => row.block === base.block))
          return finish('censored/invalid', 'feature-day-mismatch')
        return finish('missing', 'feature-day-absent')
      }
      if (!feature) return finish('censored/invalid', 'feature-anchor-mismatch')
      if (
        feature.blockHash.toLowerCase() !== base.blockHash.toLowerCase() ||
        feature.blockTimestamp !== base.blockTimestamp ||
        feature.baselineObservedAtMs !== base.observedAtMs ||
        feature.baselineRowSha256 !== base.rowSha256
      )
        return finish('censored/invalid', 'feature-anchor-mismatch')
      if (physicalSha !== null) {
        if (feature.sourcePhysicalSha256 !== physicalSha)
          return finish('censored/invalid', 'current-source-physical-sha-mismatch')
        result.sourcePhysicalShaStatus =
          'current-file-bytes-match-feature-record; immutability-unproven'
      }
      const marketReading = marketState(base, feature, market)
      Object.assign(result, marketReading)
      if (marketReading.captureStatus !== 'captured')
        return finish('censored/invalid', marketReading.captureStatus)
      if (marketReading.signalAvailability[requiredFeature] !== 'available')
        return finish(
          'censored/invalid',
          `required-feature-${marketReading.signalAvailability[requiredFeature]}`,
        )
      if (base.observedAtMs > slot.decisionAtMs || feature.observedAtMs > slot.decisionAtMs)
        return finish('late', 'observation-after-decision')
      return finish('asof_available_at_caller_clock', 'feature-available-as-of-caller-decision')
    }),
  )
  return {
    study: 'venue-signal-asof-audit-v1',
    scheduleSha256: hash(JSON.stringify(schedule)),
    scheduleProvenance:
      'caller-supplied; SHA covers normalized JSON, not physical file bytes or independent preregistration',
    requiredFeature,
    caveat:
      'Market-day availability at caller-supplied decision clocks only. The 06:00–06:30 start and 07:00 finish pilot window applies to witness capture; feature completion is evaluated separately for as-of availability. Legacy witness starts may be absent; observed timing and a current-file SHA match do not independently prove frozen daily source identity or preregistration, so pilot eligibility remains unproven. Missing days are not quiet days; no outcome or predictive claim is made.',
    rows,
    counts: Object.fromEntries(
      ['asof_available_at_caller_clock', 'late', 'missing', 'censored/invalid'].map((status) => [
        status,
        rows.filter((row) => row.status === status).length,
      ]),
    ),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [schedulePath, baselinePath = DEFAULT_BASELINE, featurePath = DEFAULT_FEATURES] =
      process.argv.slice(2)
    if (!schedulePath || process.argv.length > 5)
      throw new Error(
        'Usage: node venue-signal-asof-audit.mjs <frozen-schedule.json> [baseline.json] [features.json]',
      )
    const schedule = JSON.parse(readFileSync(schedulePath, 'utf8'))
    process.stdout.write(
      `${JSON.stringify(auditAsOf({ schedule, baselinePath, featurePath }), null, 2)}\n`,
    )
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
