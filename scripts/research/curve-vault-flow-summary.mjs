// Offline, descriptive scrvUSD vault event flow over a verified contiguous
// Deposit/Withdraw ledger. This is observed vault activity, not exit capacity,
// an executable withdrawal, a provider-independent completeness proof, or a
// protocol maximum. Never infer a future runway from these observed maxima.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OUT, readValidatedReceipts, sourceIdentity } from './curve-vault-flow-ledger.mjs'

export const STUDY = 'scrvusd-vault-gross-flow-summary-v1'
export const HORIZONS = Object.freeze([
  { label: '24h', seconds: 86_400 },
  { label: '7d', seconds: 604_800 },
])
const RAW = /^(0|[1-9][0-9]*)$/
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const unit = (value) => {
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}
const lowerBound = (events, timestamp) => {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].blockTimestamp < timestamp) lo = mid + 1
    else hi = mid
  }
  return lo
}

function maximumWindow(withdrawals, coverageFrom, coverageToExclusive, horizon) {
  const latestStart = coverageToExclusive - horizon.seconds
  if (latestStart < coverageFrom)
    return {
      status: 'unavailable',
      reason: 'less_than_one_complete_window',
      horizon: horizon.label,
      seconds: horizon.seconds,
    }
  // Half-open integer-second windows [start, start+W). With nonnegative gross
  // outflows, a maximum changes only when an event enters at the right edge.
  // The first complete window is also a candidate, including quiet windows.
  const candidates = new Set([coverageFrom])
  for (const event of withdrawals) {
    const start = event.blockTimestamp - horizon.seconds + 1
    if (start >= coverageFrom && start <= latestStart) candidates.add(start)
  }
  const ordered = [...candidates].sort((a, b) => a - b)
  const prefix = [0n]
  for (const event of withdrawals) prefix.push(prefix.at(-1) + BigInt(event.assetsRaw))
  let best = null
  for (const start of ordered) {
    const left = lowerBound(withdrawals, start)
    const right = lowerBound(withdrawals, start + horizon.seconds)
    const gross = prefix[right] - prefix[left]
    if (best === null || gross > best.gross)
      best = { start, endExclusive: start + horizon.seconds, gross, count: right - left }
  }
  return {
    status: 'observed',
    horizon: horizon.label,
    seconds: horizon.seconds,
    startUtc: iso(best.start),
    endExclusiveUtc: iso(best.endExclusive),
    grossWithdrawalsRaw: String(best.gross),
    grossWithdrawalsCrvUsd: unit(best.gross),
    withdrawEventCount: best.count,
  }
}

function maximumNetWindow(events, coverageFrom, coverageToExclusive, horizon) {
  const latestStart = coverageToExclusive - horizon.seconds
  if (latestStart < coverageFrom)
    return {
      status: 'unavailable',
      reason: 'less_than_one_complete_window',
      horizon: horizon.label,
      seconds: horizon.seconds,
    }

  // A signed maximum can rise when a withdrawal enters or a deposit leaves.
  // Include the first complete window so quiet and all-inflow coverage remain
  // observed without inventing a zero maximum for negative net flow.
  const candidates = new Set([coverageFrom])
  for (const event of events) {
    const start =
      event.kind === 'withdraw'
        ? event.blockTimestamp - horizon.seconds + 1
        : event.blockTimestamp + 1
    if (start >= coverageFrom && start <= latestStart) candidates.add(start)
  }
  const deposits = [0n]
  const withdrawals = [0n]
  const depositCounts = [0]
  const withdrawCounts = [0]
  for (const event of events) {
    const amount = BigInt(event.assetsRaw)
    deposits.push(deposits.at(-1) + (event.kind === 'deposit' ? amount : 0n))
    withdrawals.push(withdrawals.at(-1) + (event.kind === 'withdraw' ? amount : 0n))
    depositCounts.push(depositCounts.at(-1) + (event.kind === 'deposit' ? 1 : 0))
    withdrawCounts.push(withdrawCounts.at(-1) + (event.kind === 'withdraw' ? 1 : 0))
  }
  let best = null
  for (const start of [...candidates].sort((a, b) => a - b)) {
    const left = lowerBound(events, start)
    const right = lowerBound(events, start + horizon.seconds)
    const grossDeposits = deposits[right] - deposits[left]
    const grossWithdrawals = withdrawals[right] - withdrawals[left]
    const net = grossWithdrawals - grossDeposits
    if (best === null || net > best.net)
      best = {
        start,
        net,
        grossDeposits,
        grossWithdrawals,
        depositCount: depositCounts[right] - depositCounts[left],
        withdrawCount: withdrawCounts[right] - withdrawCounts[left],
      }
  }
  return {
    status: 'observed',
    horizon: horizon.label,
    seconds: horizon.seconds,
    startUtc: iso(best.start),
    endExclusiveUtc: iso(best.start + horizon.seconds),
    netDepletionRaw: String(best.net),
    grossDepositsRaw: String(best.grossDeposits),
    grossWithdrawalsRaw: String(best.grossWithdrawals),
    depositEventCount: best.depositCount,
    withdrawEventCount: best.withdrawCount,
    meaning: 'historical_observed_complete_window_stress_context_only',
  }
}

export function summarizeReceipts({ receipts, source }) {
  if (!receipts.length)
    return {
      study: STUDY,
      source,
      status: 'unavailable',
      reason: 'no_validated_coverage',
      unit: 'crvUSD',
      rawDecimals: 18,
      coverage: null,
      totals: null,
      maximumObservedCompleteWindow: Object.fromEntries(
        HORIZONS.map((horizon) => [horizon.label, maximumWindow([], 0, 0, horizon)]),
      ),
      maximumObservedCompleteWindowNetDepletion: Object.fromEntries(
        HORIZONS.map((horizon) => [horizon.label, maximumNetWindow([], 0, 0, horizon)]),
      ),
    }
  const first = receipts[0].range.from
  const last = receipts.at(-1).range.to
  const coverageToExclusive = last.timestamp + 1
  if (!Number.isSafeInteger(coverageToExclusive)) throw new Error('Unsafe coverage timestamp')
  let deposits = 0n
  let withdrawalsTotal = 0n
  let depositEventCount = 0
  const withdrawals = []
  const events = []
  for (const receipt of receipts) {
    for (const event of receipt.events) {
      if (!RAW.test(event.assetsRaw)) throw new Error('Malformed validated event amount')
      events.push(event)
      if (event.kind === 'deposit') {
        deposits += BigInt(event.assetsRaw)
        depositEventCount++
      } else if (event.kind === 'withdraw') {
        withdrawalsTotal += BigInt(event.assetsRaw)
        withdrawals.push(event)
      } else throw new Error('Unexpected validated vault event kind')
    }
  }
  withdrawals.sort(
    (a, b) =>
      a.blockTimestamp - b.blockTimestamp ||
      a.blockNumber - b.blockNumber ||
      a.logIndex - b.logIndex,
  )
  events.sort(
    (a, b) =>
      a.blockTimestamp - b.blockTimestamp ||
      a.blockNumber - b.blockNumber ||
      a.logIndex - b.logIndex,
  )
  return {
    study: STUDY,
    source,
    status: 'observed',
    observation: 'successful_scrvusd_vault_deposit_and_withdraw_events_only',
    unit: 'crvUSD',
    rawDecimals: 18,
    coverage: {
      fromBlock: first.number,
      throughBlock: last.number,
      fromUtc: iso(first.timestamp),
      throughUtc: iso(last.timestamp),
      endExclusiveUtc: iso(coverageToExclusive),
      receiptCount: receipts.length,
      consecutiveBlocks: last.number - first.number + 1,
      verifiedQuietRangesIncluded: true,
    },
    totals: {
      grossDepositsRaw: String(deposits),
      grossWithdrawalsRaw: String(withdrawalsTotal),
      grossDepositsCrvUsd: unit(deposits),
      grossWithdrawalsCrvUsd: unit(withdrawalsTotal),
      depositEventCount,
      withdrawEventCount: withdrawals.length,
    },
    maximumObservedCompleteWindow: Object.fromEntries(
      HORIZONS.map((horizon) => [
        horizon.label,
        maximumWindow(withdrawals, first.timestamp, coverageToExclusive, horizon),
      ]),
    ),
    maximumObservedCompleteWindowNetDepletion: Object.fromEntries(
      HORIZONS.map((horizon) => [
        horizon.label,
        maximumNetWindow(events, first.timestamp, coverageToExclusive, horizon),
      ]),
    ),
  }
}

export function summarize({ out = OUT, source = sourceIdentity() } = {}) {
  return summarizeReceipts({ receipts: readValidatedReceipts({ out, source }), source })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    console.error('Vault flow summary takes no CLI options')
    process.exitCode = 1
  } else {
    try {
      console.log(JSON.stringify(summarize()))
    } catch {
      console.error('Validated vault flow summary unavailable')
      process.exitCode = 1
    }
  }
}
