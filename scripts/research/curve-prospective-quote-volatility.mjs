// Offline research candidate: trailing realized variation of the nominal fixed-$1m
// crvUSD Curve route quote. This is neither asset/oracle volatility nor a
// validated independent predictor, holder exit, or executable swap signal.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT,
  readValidatedCheckpoints,
  sourceIdentity,
  STUDY_V2,
} from './curve-prospective-quote.mjs'

export const STUDY = 'curve-prospective-fixed-route-quote-realized-volatility-candidate-v1'
export const WINDOW_SECONDS = 24 * 3600
export const DEFAULT_MIN_COUNT = 12
export const DEFAULT_MIN_SPAN_SECONDS = 18 * 3600
export const DEFAULT_MAX_GAP_SECONDS = 4 * 3600
const HEX = /^[0-9a-f]{64}$/
const RAW = /^[1-9][0-9]*$/

function instant(value, label) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
    throw new Error(`Invalid ${label}`)
  return ms
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`)
}

/** The caller supplies a local computation clock for historical replay. Its value
 * is a declared availability bound, never a retroactive first-known timestamp.
 */
export function calculate(
  rows,
  {
    asOfUtc,
    computedAtUtc = asOfUtc,
    windowSeconds = WINDOW_SECONDS,
    minCount = DEFAULT_MIN_COUNT,
    minSpanSeconds = DEFAULT_MIN_SPAN_SECONDS,
    maxGapSeconds = DEFAULT_MAX_GAP_SECONDS,
  } = {},
) {
  const asOfMs = instant(asOfUtc, 'as-of clock')
  const computedMs = instant(computedAtUtc, 'computation clock')
  for (const [value, label] of [
    [windowSeconds, 'window'],
    [minCount, 'minimum count'],
    [minSpanSeconds, 'minimum span'],
    [maxGapSeconds, 'maximum gap'],
  ])
    positiveInteger(value, label)
  if (minCount < 2 || minSpanSeconds > windowSeconds || maxGapSeconds > windowSeconds)
    throw new Error('Inconsistent volatility coverage controls')
  if (!Array.isArray(rows)) throw new Error('Invalid validated checkpoint rows')

  const base = {
    study: STUDY,
    status: 'unavailable',
    asOfUtc,
    featureAvailableAtUtc: computedAtUtc,
    availabilityMeaning:
      'latest required capture or declared local computation; not historical first-known time',
    windowSeconds,
    minCount,
    minSpanSeconds,
    maxGapSeconds,
    coverageMeaning:
      'bounded sparse samples within a trailing 24h window; not continuous 24h coverage',
    metric:
      'sqrt(sum of squared adjacent natural-log returns of the nominal fixed-$1m best-split Curve get_dy quote)',
    unit: 'dimensionless fraction of quote; multiply by 100 for percent; unannualized trailing-window variation',
    signalLimit:
      'route quote variation, not asset/oracle volatility, an independent signal, or a validated predictor',
  }
  const fail = (reason, extra = {}) => ({ ...base, reason, ...extra })
  if (computedMs > asOfMs) return fail('computed_after_asof')

  const floorMs = asOfMs - windowSeconds * 1000
  const inWindow = rows.filter(({ checkpoint: p }) => {
    const t = p?.block?.timestamp * 1000
    return Number.isSafeInteger(t) && t >= floorMs && t <= asOfMs
  })
  if (!inWindow.length) return fail('missing_checkpoints')
  if (inWindow.some(({ checkpoint: p }) => p.study !== STUDY_V2))
    return fail('legacy_v1_checkpoint')
  const parsed = inWindow.map((row) => ({
    row,
    captureMs: instant(row.checkpoint.captureEndUtc, 'capture end'),
  }))
  if (parsed.some(({ row, captureMs }) => captureMs < row.checkpoint.block.timestamp * 1000))
    return fail('invalid_capture_clock')
  if (parsed.some(({ captureMs }) => captureMs > asOfMs))
    return fail('late_checkpoint', {
      excludedLateCount: parsed.filter(({ captureMs }) => captureMs > asOfMs).length,
    })
  if (parsed.some(({ captureMs }) => captureMs > computedMs))
    return fail('computed_before_capture', {
      featureAvailableAtUtc: new Date(
        Math.max(...parsed.map(({ captureMs }) => captureMs)),
      ).toISOString(),
    })
  parsed.sort((a, b) => a.row.checkpoint.block.timestamp - b.row.checkpoint.block.timestamp)
  if (parsed.length < minCount) return fail('insufficient_count', { observedCount: parsed.length })

  const sourceSha = parsed[0].row.checkpoint.source?.identitySha256
  const routeCodeIdentity = JSON.stringify(parsed[0].row.checkpoint.raw?.codeIdentities)
  if (
    parsed.some(
      ({ row }) =>
        row.checkpoint.source?.identitySha256 !== sourceSha ||
        JSON.stringify(row.checkpoint.raw?.codeIdentities) !== routeCodeIdentity,
    )
  )
    return fail('source_or_route_identity_changed')
  if (
    parsed.some(({ row }) => {
      const route = row.checkpoint.routes?.['1000000']
      const raw = route?.bestOutputRaw
      return (
        !HEX.test(row.physicalSha256) ||
        !RAW.test(raw) ||
        !Number.isFinite(route?.bestQuote) ||
        route.bestQuote <= 0 ||
        Number(raw) / 1e12 !== route.bestQuote
      )
    })
  )
    return fail('invalid_or_zero_quote')
  const points = parsed.map(({ row, captureMs }) => {
    const p = row.checkpoint
    const route = p.routes?.['1000000']
    const raw = route?.bestOutputRaw
    return {
      block: p.block.number,
      blockHash: p.block.hash,
      blockTimeUtc: new Date(p.block.timestamp * 1000).toISOString(),
      captureEndUtc: new Date(captureMs).toISOString(),
      filename: row.filename,
      physicalSha256: row.physicalSha256,
      sourceIdentitySha256: sourceSha,
      fixedQCrvUsd: 1_000_000,
      route: 'best split over the same pinned two-pool five-split get_dy grid',
      bestOutputRaw: raw,
      bestQuote: route.bestQuote,
    }
  })
  for (let i = 1; i < points.length; i++) {
    if (
      points[i].block <= points[i - 1].block ||
      points[i].blockTimeUtc <= points[i - 1].blockTimeUtc
    )
      return fail('duplicate_or_nonadvancing_checkpoint')
  }
  const first = Date.parse(points[0].blockTimeUtc)
  const last = Date.parse(points.at(-1).blockTimeUtc)
  const spanSeconds = (last - first) / 1000
  if (spanSeconds < minSpanSeconds)
    return fail('insufficient_span', { observedCount: points.length, spanSeconds })
  const gaps = points
    .slice(1)
    .map((p, i) => (Date.parse(p.blockTimeUtc) - Date.parse(points[i].blockTimeUtc)) / 1000)
  const leadingGapSeconds = (first - floorMs) / 1000
  const edgeGapSeconds = (asOfMs - last) / 1000
  const largestGapSeconds = Math.max(leadingGapSeconds, ...gaps, edgeGapSeconds)
  if (largestGapSeconds > maxGapSeconds)
    return fail('observation_gap', {
      observedCount: points.length,
      spanSeconds,
      largestGapSeconds,
      leadingGapSeconds,
      edgeGapSeconds,
    })

  const logReturns = points.slice(1).map((p, i) => Math.log(p.bestQuote / points[i].bestQuote))
  const realizedVariation = Math.sqrt(logReturns.reduce((sum, value) => sum + value * value, 0))
  return {
    ...base,
    status: 'research_candidate',
    reason: null,
    featureAvailableAtUtc: new Date(
      Math.max(computedMs, ...parsed.map(({ captureMs }) => captureMs)),
    ).toISOString(),
    observedCount: points.length,
    returnCount: logReturns.length,
    spanSeconds,
    largestGapSeconds,
    leadingGapSeconds,
    edgeGapSeconds,
    realizedVariation,
    realizedVariationPercent: realizedVariation * 100,
    contributingSources: points,
  }
}

export function analyze({
  out = OUT,
  identity = sourceIdentity(),
  now = () => new Date(),
  ...options
} = {}) {
  const computedAtUtc = options.computedAtUtc ?? now().toISOString()
  const asOfUtc = options.asOfUtc ?? computedAtUtc
  // The recorder's reader verifies physical/logical seals, filenames, duplicate
  // blocks, source identity, and reconstructed routes before any selection.
  const rows = readValidatedCheckpoints({ out, identity })
  return calculate(rows, { ...options, asOfUtc, computedAtUtc })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(analyze()))
  } catch {
    console.error('Quote volatility research analysis failed')
    process.exitCode = 1
  }
}
