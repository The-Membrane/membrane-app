// Offline observation of changes in the nominal $1m crvUSD secondary quote.
// A deterioration is measured after the fact. It is not a forecast or an executable exit.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OUT, readValidatedCheckpoints, sourceIdentity } from './curve-prospective-quote.mjs'

export const STUDY = 'curve-crvusd-secondary-quote-shrinkage-watch-v1'
export const DEFAULT_MAX_GAP_SECONDS = 4 * 3600
export const DEFAULT_THRESHOLD_BPS = 10
export const DEFAULT_FRESHNESS_SECONDS = 2 * 3600
const QUOTE_RAW_PER_BP = 100_000_000n // $1m input, 6-decimal stablecoin output

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`)
  return value
}

function snapshot(row) {
  const p = row.checkpoint
  return {
    block: p.block.number,
    blockHash: p.block.hash,
    blockTimeUtc: new Date(p.block.timestamp * 1000).toISOString(),
    captureStartUtc: p.captureStartUtc,
    captureEndUtc: p.captureEndUtc,
    physicalSha256: row.physicalSha256,
    pinMode: p.pinMode,
    sourceIdentitySha256: p.source.identitySha256,
    quoteSource:
      'two configured Curve StableSwap pools, best fixed split of nominal $1m crvUSD get_dy',
    bestOutputRaw: p.routes['1000000'].bestOutputRaw,
    bestQuote: p.routes['1000000'].bestQuote,
  }
}

export function assessPair(
  previous,
  current,
  { maxGapSeconds = DEFAULT_MAX_GAP_SECONDS, thresholdBps = DEFAULT_THRESHOLD_BPS } = {},
) {
  positiveInteger(maxGapSeconds, 'maximum gap')
  positiveInteger(thresholdBps, 'threshold')
  const before = snapshot(previous)
  const after = snapshot(current)
  const gapSeconds = current.checkpoint.block.timestamp - previous.checkpoint.block.timestamp
  const base = {
    study: STUDY,
    previous: before,
    current: after,
    gapSeconds,
    maxGapSeconds,
    thresholdBps,
    thresholdMeaning: `absolute basis points of the $1m crvUSD input; ${thresholdBps} bps is a $${(thresholdBps * 100).toLocaleString('en-US')} nominal output change in either direction`,
  }
  if (after.sourceIdentitySha256 !== before.sourceIdentitySha256)
    return { ...base, status: 'unavailable', reason: 'source_changed' }
  if (after.block <= before.block || gapSeconds <= 0)
    return { ...base, status: 'unavailable', reason: 'nonadvancing_finalized_block' }
  if (gapSeconds > maxGapSeconds)
    return { ...base, status: 'unavailable', reason: 'observation_gap' }
  const priorRaw = BigInt(before.bestOutputRaw)
  const currentRaw = BigInt(after.bestOutputRaw)
  if (priorRaw === 0n || currentRaw === 0n)
    return { ...base, status: 'unavailable', reason: 'zero_quote' }
  const changeRaw = currentRaw - priorRaw
  const deteriorationRaw = changeRaw < 0n ? -changeRaw : 0n
  const improvementRaw = changeRaw > 0n ? changeRaw : 0n
  const thresholdRaw = BigInt(thresholdBps) * QUOTE_RAW_PER_BP
  return {
    ...base,
    status:
      deteriorationRaw >= thresholdRaw
        ? 'deteriorating'
        : improvementRaw >= thresholdRaw
          ? 'improving'
          : 'stable',
    nominalOutputChangeUsd: Number(changeRaw) / 1e6,
    quoteChange: Number(changeRaw) / 1e12,
    absoluteDeteriorationBpsOfInput: Number(deteriorationRaw) / Number(QUOTE_RAW_PER_BP),
    absoluteImprovementBpsOfInput: Number(improvementRaw) / Number(QUOTE_RAW_PER_BP),
    relativeOutputChangeBps: (Number(changeRaw) / Number(priorRaw)) * 10_000,
  }
}

export function analyze({
  out = OUT,
  identity = sourceIdentity(),
  maxGapSeconds = DEFAULT_MAX_GAP_SECONDS,
  thresholdBps = DEFAULT_THRESHOLD_BPS,
  freshnessSeconds = DEFAULT_FRESHNESS_SECONDS,
  now = () => new Date(),
} = {}) {
  positiveInteger(maxGapSeconds, 'maximum gap')
  positiveInteger(thresholdBps, 'threshold')
  positiveInteger(freshnessSeconds, 'freshness')
  const asOf = now()
  const asOfMs = asOf instanceof Date ? asOf.getTime() : NaN
  if (!Number.isFinite(asOfMs)) throw new Error('Invalid analysis clock')
  // This reader verifies every receipt seal, reconstructs the route, and checks
  // the configured source. A corrupt receipt must fail the whole report.
  const rows = readValidatedCheckpoints({ out, identity })
  const pairs = rows
    .slice(1)
    .map((row, index) => assessPair(rows[index], row, { maxGapSeconds, thresholdBps }))
  const latestHistorical = pairs.at(-1) ?? null
  const latestRow = rows.at(-1)
  const blockAgeSeconds = latestRow ? asOfMs / 1000 - latestRow.checkpoint.block.timestamp : null
  const captureAgeSeconds = latestRow
    ? (asOfMs - Date.parse(latestRow.checkpoint.captureEndUtc)) / 1000
    : null
  const stale =
    latestRow &&
    (blockAgeSeconds > freshnessSeconds ||
      captureAgeSeconds > freshnessSeconds ||
      blockAgeSeconds < -60 ||
      captureAgeSeconds < -60)
  return {
    study: STUDY,
    asOfUtc: asOf.toISOString(),
    freshnessSeconds,
    checkpointCount: rows.length,
    comparedPairs: pairs.length,
    deterioratingPairs: pairs.filter((pair) => pair.status === 'deteriorating').length,
    unavailablePairs: pairs.filter((pair) => pair.status === 'unavailable').length,
    latestHistorical,
    latest: latestHistorical
      ? stale
        ? {
            status: 'unavailable',
            reason: 'stale_checkpoint',
            lastObserved: latestHistorical,
            blockAgeSeconds,
            captureAgeSeconds,
          }
        : latestHistorical
      : {
          status: 'unavailable',
          reason: 'insufficient_checkpoints',
          latestCheckpoint: latestRow ? snapshot(latestRow) : null,
          stale: Boolean(stale),
        },
  }
}

function options(args) {
  const result = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!['--threshold-bps', '--max-gap-seconds'].includes(arg) || result[arg] !== undefined)
      throw new Error('Unknown or duplicate option')
    const value = Number(args[++i])
    positiveInteger(value, arg)
    result[arg] = value
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const opts = options(process.argv.slice(2))
    console.log(
      JSON.stringify(
        analyze({
          thresholdBps: opts['--threshold-bps'] ?? DEFAULT_THRESHOLD_BPS,
          maxGapSeconds: opts['--max-gap-seconds'] ?? DEFAULT_MAX_GAP_SECONDS,
        }),
      ),
    )
  } catch {
    // Input and provider-originated paths are not exposed to terminal logs.
    console.error('Quote shrinkage analysis failed')
    process.exitCode = 1
  }
}
