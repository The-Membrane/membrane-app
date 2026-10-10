// Offline research view of one predeclared holder/q. Never emits a forecast or alert.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import {
  OUT as HOLDER_OUT,
  readPlan,
  validateIssue,
  verify as verifyHolder,
} from './scrvusd-fixed-holder-exit.mjs'
import { OUT as SEED_OUT } from './scrvusd-index-holder-seed.mjs'
import {
  OUT as SELECTION_OUT,
  verify as verifySelection,
} from './scrvusd-holder-selection-link.mjs'

export const STUDY = 'scrvusd-holder-exit-trend-v1'
// At the hourly recorder cadence, allow one delayed capture but no missing quote.
export const MAX_PAIR_SECONDS = 7200
export const MAX_CAPTURE_AGE_SECONDS = 7200
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const unavailable = (reason, extra = {}) => ({ status: 'unavailable', reason, ...extra })

function ref(issue) {
  return {
    block: issue.checkpoint.block.number,
    blockHash: issue.checkpoint.block.hash,
    blockUtc: iso(issue.checkpoint.block.timestamp),
    captureEndUtc: issue.captureEndUtc,
    result: issue.result.status,
  }
}

export function computeTrend({ plan, issues, checkpoints, now = new Date() }) {
  const orderedQuotes = [...checkpoints].sort(
    (a, b) => a.checkpoint.block.number - b.checkpoint.block.number,
  )
  const ordered = [...issues].sort((a, b) => a.checkpoint.block.number - b.checkpoint.block.number)
  const base = {
    study: STUDY,
    holder: plan.holder,
    rawCrvUsd: plan.rawCrvUsd,
    planSha256: plan.sha256,
    observationCount: ordered.length,
    quoteCount: orderedQuotes.length,
    bounds: {
      maxPairSeconds: MAX_PAIR_SECONDS,
      maxCaptureAgeSeconds: MAX_CAPTURE_AGE_SECONDS,
      requiresAdjacentQuoteCheckpoints: true,
    },
  }
  if (!ordered.length) return { ...base, ...unavailable('no_observations') }
  const current = ordered.at(-1)
  const currentRef = ref(current)
  const ageSeconds = (now.getTime() - Date.parse(current.captureEndUtc)) / 1000
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > MAX_CAPTURE_AGE_SECONDS)
    return { ...base, ...unavailable('stale_or_future_capture', { current: currentRef }) }
  if (orderedQuotes.at(-1)?.checkpoint.block.number !== current.checkpoint.block.number)
    return { ...base, ...unavailable('missing_latest_checkpoint', { current: currentRef }) }
  if (ordered.length < 2)
    return {
      ...base,
      status: current.result.status === 'success' ? 'right_censored' : 'unavailable',
      reason: current.result.status === 'success' ? 'one_success_only' : 'no_success_pair',
      current: currentRef,
    }

  const previous = ordered.at(-2)
  const previousRef = ref(previous)
  const pair = { previous: previousRef, current: currentRef }
  const fromIndex = orderedQuotes.findIndex(
    (row) => row.checkpoint.block.number === previous.checkpoint.block.number,
  )
  const toIndex = orderedQuotes.findIndex(
    (row) => row.checkpoint.block.number === current.checkpoint.block.number,
  )
  if (fromIndex < 0 || toIndex !== fromIndex + 1)
    return { ...base, ...unavailable('missing_intermediate_checkpoint', pair) }
  const elapsedSeconds = current.checkpoint.block.timestamp - previous.checkpoint.block.timestamp
  if (elapsedSeconds <= 0 || elapsedSeconds > MAX_PAIR_SECONDS)
    return { ...base, ...unavailable('sample_gap', { ...pair, elapsedSeconds }) }
  if (previous.result.status !== 'success')
    return { ...base, ...unavailable('no_prior_success', pair) }
  if (current.result.status === 'provider_error')
    return { ...base, ...unavailable('ambiguous_current_result', pair) }

  const previousShares = previous.result.balanceSharesRaw
  const currentShares = current.result.balanceSharesRaw
  const currentPreview = current.result.previewSharesRaw
  if (previousShares === null || currentShares === null || currentPreview === null)
    return { ...base, ...unavailable('holder_diagnostics_unavailable', pair) }
  if (
    BigInt(currentShares) < BigInt(previousShares) ||
    BigInt(currentShares) < BigInt(currentPreview)
  )
    return { ...base, ...unavailable('holder_attrition_or_insufficient_shares', pair) }

  if (current.result.status === 'revert')
    return {
      ...base,
      status: 'sampled_transition',
      transition: 'success_to_structured_evm_revert',
      ...pair,
      elapsedSeconds,
      intervalStartUtc: previousRef.blockUtc,
      intervalEndUtc: currentRef.blockUtc,
      caveat: 'Revert was observed at a sampled block; the time or cause of the change is unknown.',
    }
  if (current.result.status !== 'success')
    return { ...base, ...unavailable('ambiguous_current_result', pair) }
  const previousMax = previous.result.maxWithdrawAssetsRaw
  const currentMax = current.result.maxWithdrawAssetsRaw
  if (previousMax === null || currentMax === null)
    return { ...base, ...unavailable('max_withdraw_unavailable', pair) }
  const q = BigInt(plan.rawCrvUsd)
  if (BigInt(previousMax) < q || BigInt(currentMax) < q)
    return { ...base, ...unavailable('inconsistent_success_max_withdraw', pair) }
  const before = BigInt(previousMax) - q
  const after = BigInt(currentMax) - q
  const delta = after - before
  return {
    ...base,
    status: 'measured_pair',
    direction: delta < 0n ? 'shrinking' : delta > 0n ? 'growing' : 'flat',
    ...pair,
    elapsedSeconds,
    previousHeadroomAssetsRaw: before.toString(),
    currentHeadroomAssetsRaw: after.toString(),
    signedHeadroomChangeAssetsRaw: delta.toString(),
    caveat: 'Two sampled holder simulations; the change between blocks is not a future trajectory.',
  }
}

export function readTrend({
  out = HOLDER_OUT,
  quoteOut = QUOTE_OUT,
  seedOut = SEED_OUT,
  selectionOut = SELECTION_OUT,
  identity = sourceIdentity(),
  now = () => new Date(),
} = {}) {
  const selection = verifySelection({
    out: selectionOut,
    sourceOptions: { planOut: out, seedOut, quoteOut, identity },
    nowMs: now().getTime(),
  })
  if (selection.status !== 'verified') throw new Error('Holder selection certificate unavailable')
  const audited = verifyHolder({ out, quoteOut, identity, now })
  const plan = readPlan({ out, identity })
  if (!plan) return { study: STUDY, ...unavailable('no_predeclared_plan') }
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  const dir = join(out, 'issues')
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  if (files.length !== audited.count) throw new Error('Holder ledger changed during trend read')
  const issues = files.map((file) => {
    const issue = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    validateIssue(issue, { plan, checkpoints, nowUtc: now().toISOString() })
    if (
      file !==
      `${String(issue.checkpoint.block.number).padStart(12, '0')}-${issue.checkpoint.block.hash.slice(2)}.json`
    )
      throw new Error('Holder issue filename changed during trend read')
    return issue
  })
  return computeTrend({ plan, issues, checkpoints, now: now() })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(readTrend()))
  } catch {
    console.error('Holder trend verification failed')
    process.exitCode = 1
  }
}
