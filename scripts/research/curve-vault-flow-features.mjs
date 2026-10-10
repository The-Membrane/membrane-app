// Offline, as-of vault event features for one fixed nominal quote checkpoint.
// Observed Deposit/Withdraw events do not establish executable holder exits.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity as quoteIdentity,
} from './curve-prospective-quote.mjs'
import {
  OUT as FLOW_OUT,
  readValidatedReceipts,
  sourceIdentity as flowIdentity,
} from './curve-vault-flow-ledger.mjs'

export const STUDY = 'scrvusd-vault-flow-asof-features-v1'
export const HORIZONS = Object.freeze([
  { label: '24h', seconds: 86_400 },
  { label: '7d', seconds: 604_800 },
])
const RAW = /^(0|[1-9][0-9]*)$/
const safe = (value) => Number.isSafeInteger(value) && value >= 0
const utc = (second) => new Date(second * 1000).toISOString()
const unavailable = (reason, extra = {}) => ({ status: 'unavailable', reason, ...extra })
const lowerBound = (events, second) => {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].blockTimestamp < second) lo = mid + 1
    else hi = mid
  }
  return lo
}

function totals(events, from, endExclusive) {
  let deposits = 0n
  let withdrawals = 0n
  let depositEvents = 0
  let withdrawEvents = 0
  for (let i = lowerBound(events, from); i < events.length; i++) {
    const event = events[i]
    if (event.blockTimestamp >= endExclusive) break
    const amount = BigInt(event.assetsRaw)
    if (event.kind === 'deposit') {
      deposits += amount
      depositEvents++
    } else {
      withdrawals += amount
      withdrawEvents++
    }
  }
  return {
    grossDepositsRaw: String(deposits),
    grossWithdrawalsRaw: String(withdrawals),
    netWithdrawalsRaw: String(withdrawals - deposits),
    netDepletionRaw: String(withdrawals - deposits),
    depositEventCount: depositEvents,
    withdrawEventCount: withdrawEvents,
  }
}

function maximumCompleteWindow(events, coverageStart, endExclusive, horizon) {
  const latestStart = endExclusive - horizon.seconds
  if (latestStart < coverageStart)
    return unavailable('less_than_one_complete_window', {
      horizon: horizon.label,
      seconds: horizon.seconds,
    })

  // Signed net depletion can rise either when a withdrawal enters OR a
  // deposit leaves. Consider both event entry and exit boundaries; zero is
  // never fabricated as a maximum when all complete windows are net inflow.
  const candidates = new Set([coverageStart])
  for (const event of events) {
    for (const start of [event.blockTimestamp - horizon.seconds + 1, event.blockTimestamp + 1]) {
      if (start >= coverageStart && start <= latestStart) candidates.add(start)
    }
  }
  const depositPrefix = [0n]
  const withdrawalPrefix = [0n]
  for (const event of events) {
    const amount = BigInt(event.assetsRaw)
    depositPrefix.push(depositPrefix.at(-1) + (event.kind === 'deposit' ? amount : 0n))
    withdrawalPrefix.push(withdrawalPrefix.at(-1) + (event.kind === 'withdraw' ? amount : 0n))
  }
  let grossMax = null
  let netMax = null
  for (const start of [...candidates].sort((a, b) => a - b)) {
    const left = lowerBound(events, start)
    const right = lowerBound(events, start + horizon.seconds)
    const gross = withdrawalPrefix[right] - withdrawalPrefix[left]
    const net = gross - (depositPrefix[right] - depositPrefix[left])
    if (!grossMax || gross > grossMax.value) grossMax = { start, value: gross }
    if (!netMax || net > netMax.value) netMax = { start, value: net }
  }
  return {
    status: 'observed',
    horizon: horizon.label,
    seconds: horizon.seconds,
    maximumGrossWithdrawalsRaw: String(grossMax.value),
    grossWindowStartUtc: utc(grossMax.start),
    grossWindowEndExclusiveUtc: utc(grossMax.start + horizon.seconds),
    maximumNetDepletionRaw: String(netMax.value),
    netWindowStartUtc: utc(netMax.start),
    netWindowEndExclusiveUtc: utc(netMax.start + horizon.seconds),
    meaning: 'historical_observed_complete_window_stress_context_only',
  }
}

// Inputs must come from readValidatedCheckpoints/readValidatedReceipts. This
// second boundary check prevents accidental mixing of two separately valid
// prefixes, a newer receipt, or a different chain/asset at the chosen B.
export function computeFlowFeatures({ checkpointRow, receipts, source, asOfUtc }) {
  const checkpoint = checkpointRow?.checkpoint
  const B = checkpoint?.block
  const issueMs = Date.parse(asOfUtc)
  if (!Number.isFinite(issueMs)) throw new Error('Valid as-of issue time required')
  const at = {
    blockNumber: B?.number ?? null,
    blockHash: B?.hash ?? null,
    timestamp: B?.timestamp ?? null,
  }
  const base = {
    study: STUDY,
    asOfUtc: new Date(issueMs).toISOString(),
    checkpoint: at,
    unit: 'crvUSD',
    rawDecimals: 18,
  }
  if (!B || !safe(B.number) || !safe(B.timestamp))
    return { ...base, ...unavailable('missing_checkpoint') }
  if (
    !source ||
    checkpoint.source?.chainId !== source.chainId ||
    checkpoint.source?.vault !== source.vault ||
    checkpoint.source?.crvUsd !== source.asset
  )
    return { ...base, ...unavailable('chain_vault_or_asset_mismatch') }
  if (Date.parse(checkpoint.captureEndUtc) > issueMs)
    return { ...base, ...unavailable('checkpoint_captured_after_asof') }
  if (!Array.isArray(receipts) || receipts.length === 0)
    return { ...base, ...unavailable('no_validated_coverage') }

  let previous = null
  const events = []
  for (const receipt of receipts) {
    const from = receipt?.range?.from
    const to = receipt?.range?.to
    if (
      receipt?.source?.chainId !== source.chainId ||
      receipt.source.vault !== source.vault ||
      receipt.source.asset !== source.asset ||
      !safe(from?.number) ||
      !safe(to?.number) ||
      !safe(from?.timestamp) ||
      !safe(to?.timestamp)
    )
      return { ...base, ...unavailable('invalid_or_mismatched_receipt_prefix') }
    if (
      previous &&
      (from.number !== previous.range.to.number + 1 ||
        from.timestamp <= previous.range.to.timestamp ||
        receipt.previousReceiptSha256 !== previous.sha256)
    )
      return { ...base, ...unavailable('unbridged_coverage_gap') }
    if (
      !Number.isFinite(Date.parse(receipt.captureEndUtc)) ||
      Date.parse(receipt.captureEndUtc) > issueMs
    )
      return { ...base, ...unavailable('receipt_captured_after_asof') }
    if (to.number > B.number || to.timestamp > B.timestamp)
      return { ...base, ...unavailable('future_receipt_in_prefix') }
    for (const event of receipt.events ?? []) {
      if (
        !safe(event.blockNumber) ||
        !safe(event.blockTimestamp) ||
        event.blockNumber > B.number ||
        event.blockTimestamp > B.timestamp ||
        !RAW.test(event.assetsRaw) ||
        !['deposit', 'withdraw'].includes(event.kind)
      )
        return { ...base, ...unavailable('invalid_or_future_event') }
      events.push(event)
    }
    previous = receipt
  }
  const first = receipts[0].range.from
  const last = previous.range.to
  if (last.number !== B.number || last.hash !== B.hash || last.timestamp !== B.timestamp)
    return { ...base, ...unavailable('checkpoint_not_exact_covered_tip') }
  events.sort(
    (a, b) =>
      a.blockTimestamp - b.blockTimestamp ||
      a.blockNumber - b.blockNumber ||
      a.logIndex - b.logIndex,
  )
  const coverage = {
    fromBlock: first.number,
    throughBlock: last.number,
    fromUtc: utc(first.timestamp),
    throughUtc: utc(last.timestamp),
    receiptCount: receipts.length,
    verifiedQuietRangesIncluded: true,
  }
  const windows = Object.fromEntries(
    HORIZONS.map((horizon) => {
      const start = B.timestamp - horizon.seconds + 1
      return [
        horizon.label,
        start < first.timestamp
          ? unavailable('incomplete_trailing_window', {
              horizon: horizon.label,
              seconds: horizon.seconds,
            })
          : {
              status: 'observed',
              horizon: horizon.label,
              seconds: horizon.seconds,
              startUtc: utc(start),
              endExclusiveUtc: utc(B.timestamp + 1),
              ...totals(events, start, B.timestamp + 1),
            },
      ]
    }),
  )
  const maxima = Object.fromEntries(
    HORIZONS.map((horizon) => [
      horizon.label,
      maximumCompleteWindow(events, first.timestamp, B.timestamp + 1, horizon),
    ]),
  )
  return {
    ...base,
    status: 'observed',
    observation: 'successful_vault_deposit_and_withdraw_events_only',
    coverage,
    trailingCompleteWindow: windows,
    maximumObservedCompleteWindow: maxima,
    caveat:
      'Maximum observed flow is stress context, not runway, executable exit size, or protocol maximum.',
  }
}

export function readCurrentFeatures({ asOfUtc = new Date().toISOString() } = {}) {
  const quoteSource = quoteIdentity()
  const source = flowIdentity()
  const checkpoints = readValidatedCheckpoints({ out: QUOTE_OUT, identity: quoteSource })
  const checkpointRow = checkpoints.at(-1)
  const receipts = readValidatedReceipts({ out: FLOW_OUT, source })
  return computeFlowFeatures({ checkpointRow, receipts, source, asOfUtc })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === '--verify')) {
    console.error('Usage: node curve-vault-flow-features.mjs [--verify]')
    process.exitCode = 1
  } else {
    try {
      console.log(JSON.stringify(readCurrentFeatures()))
    } catch {
      console.error('Validated as-of vault flow features unavailable')
      process.exitCode = 1
    }
  }
}
