// Pure historical maximum for one pinned direct market. The caller must supply
// finalized, complete coverage and results from reconcileDirectSupplierWithdrawal.
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'

const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const DAY_MS = 86_400_000
const DURATIONS = new Set([DAY_MS, 7 * DAY_MS])
const MARKET_IDENTITIES = Object.freeze({
  aaveV3Usdc: { kind: 'aave', routeKey: 'USDC → supply on Aave V3', venueKind: 'aave_v3_atoken' },
  aaveV3Usde: { kind: 'aave', routeKey: 'USDe → supply on Aave V3', venueKind: 'aave_v3_atoken' },
  sparkLendUsdt: {
    kind: 'spark',
    routeKey: 'USDT → supply on Spark',
    venueKind: 'spark_lend_atoken',
  },
  compoundV3Usdc: {
    kind: 'comet',
    routeKey: 'USDC → supply on Compound v3',
    venueKind: 'compound_v3_comet',
  },
})

const integer = (value) => Number.isSafeInteger(value) && value >= 0
const hash = (value) => (typeof value === 'string' && HASH.test(value) ? value.toLowerCase() : null)
const raw = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null
  return BigInt(value)
}

function pinnedMarket(marketKey) {
  const identity = MARKET_IDENTITIES[marketKey]
  if (!identity) throw new Error('unsupported_direct_market')
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (entry) => entry.kind === identity.kind && entry.routeKey === identity.routeKey,
  )
  if (!route) throw new Error('frozen_direct_market_missing')
  return {
    ...identity,
    destination: route.destination.toLowerCase(),
    underlying: route.asset.toLowerCase(),
  }
}

function validateCoverage(coverage, marketKey, durationMs) {
  if (
    !coverage ||
    coverage.marketKey !== marketKey ||
    !integer(coverage.startMs) ||
    !integer(coverage.endMs) ||
    coverage.endMs <= coverage.startMs ||
    !Array.isArray(coverage.intervals) ||
    coverage.intervals.length === 0
  )
    throw new Error('invalid_direct_flow_coverage')
  if (coverage.endMs - coverage.startMs < durationMs) throw new Error('short_direct_flow_coverage')

  let cursor = coverage.startMs
  for (const interval of coverage.intervals) {
    if (
      !interval ||
      !integer(interval.startMs) ||
      !integer(interval.endMs) ||
      interval.startMs !== cursor ||
      interval.endMs <= interval.startMs ||
      interval.endMs > coverage.endMs ||
      interval.finalized !== true ||
      interval.receiptsComplete !== true ||
      interval.ambiguousReceipts !== 0
    )
      throw new Error('incomplete_direct_flow_coverage')
    cursor = interval.endMs
  }
  if (cursor !== coverage.endMs) throw new Error('incomplete_direct_flow_coverage')
}

function validateWithdrawal(event, marketKey, market, coverage) {
  const blockHash = hash(event?.blockHash)
  const transactionHash = hash(event?.transactionHash)
  const logIndex = event?.logIndex
  const reconciliation = event?.reconciliation
  const amount = raw(reconciliation?.evidence?.amountRaw)
  const burned = raw(reconciliation?.evidence?.burnedSharesRaw)
  if (
    event?.marketKey !== marketKey ||
    !blockHash ||
    !transactionHash ||
    !integer(logIndex) ||
    !integer(event.timestampMs) ||
    event.timestampMs < coverage.startMs ||
    event.timestampMs >= coverage.endMs ||
    reconciliation?.status !== 'reconciled_supplier_withdrawal' ||
    reconciliation.reason !== 'exact_receipt_payout' ||
    reconciliation.routeKey !== market.routeKey ||
    reconciliation.venueKind !== market.venueKind ||
    reconciliation.destination?.toLowerCase() !== market.destination ||
    reconciliation.underlying?.toLowerCase() !== market.underlying ||
    hash(reconciliation.transactionHash) !== transactionHash ||
    reconciliation.evidence.withdrawLogIndex !== logIndex ||
    amount === null ||
    amount <= 0n ||
    !ADDRESS.test(reconciliation.evidence.holder ?? '') ||
    !ADDRESS.test(reconciliation.evidence.receiver ?? '') ||
    !integer(reconciliation.evidence.payoutLogIndex) ||
    reconciliation.evidence.payoutLogIndex >= logIndex ||
    (market.venueKind === 'compound_v3_comet'
      ? !integer(reconciliation.evidence.burnLogIndex) ||
        reconciliation.evidence.burnLogIndex <= logIndex ||
        burned === null ||
        burned < amount
      : reconciliation.evidence.burnLogIndex !== null ||
        reconciliation.evidence.burnedSharesRaw !== null)
  )
    throw new Error('invalid_direct_supplier_withdrawal')
  return {
    id: `${blockHash}/${transactionHash}/${logIndex}`,
    timestampMs: event.timestampMs,
    amount,
    // A replay of one physical log must agree on time, amount, and receipt evidence.
    fingerprint: JSON.stringify({
      timestampMs: event.timestampMs,
      amountRaw: amount.toString(),
      holder: reconciliation.evidence.holder,
      receiver: reconciliation.evidence.receiver,
      payoutLogIndex: reconciliation.evidence.payoutLogIndex,
      burnLogIndex: reconciliation.evidence.burnLogIndex,
      burnedSharesRaw: reconciliation.evidence.burnedSharesRaw,
    }),
  }
}

/**
 * Exact maximum over all complete half-open [startMs, startMs + durationMs)
 * windows inside one attested coverage span. Empty complete windows yield zero.
 * This does not establish RPC completeness, executable exits, or percentages.
 */
export function maxDirectSupplierWithdrawalWindow({
  marketKey,
  coverage,
  withdrawals,
  durationMs,
}) {
  const market = pinnedMarket(marketKey)
  if (!DURATIONS.has(durationMs)) throw new Error('unsupported_direct_flow_duration')
  validateCoverage(coverage, marketKey, durationMs)
  if (!Array.isArray(withdrawals)) throw new Error('invalid_direct_supplier_withdrawals')

  const dedup = new Map()
  for (const event of withdrawals) {
    const row = validateWithdrawal(event, marketKey, market, coverage)
    const previous = dedup.get(row.id)
    if (previous && previous.fingerprint !== row.fingerprint) {
      throw new Error('conflicting_direct_supplier_event_replay')
    }
    dedup.set(row.id, row)
  }
  const events = [...dedup.values()].sort(
    (a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id),
  )
  const lastStart = coverage.endMs - durationMs
  const starts = [
    coverage.startMs,
    ...events.map((event) => Math.min(event.timestampMs, lastStart)),
  ]
    .sort((a, b) => a - b)
    .filter((start, i, all) => i === 0 || start !== all[i - 1])

  let left = 0
  let right = 0
  let sum = 0n
  let best = { startMs: starts[0], amountRaw: 0n, eventCount: 0 }
  for (const startMs of starts) {
    while (left < right && events[left].timestampMs < startMs) sum -= events[left++].amount
    while (right < events.length && events[right].timestampMs < startMs + durationMs) {
      sum += events[right++].amount
    }
    if (sum > best.amountRaw) best = { startMs, amountRaw: sum, eventCount: right - left }
  }
  return {
    marketKey,
    routeKey: market.routeKey,
    destination: market.destination,
    underlying: market.underlying,
    durationMs,
    coverageStartMs: coverage.startMs,
    coverageEndMs: coverage.endMs,
    startMs: best.startMs,
    endMs: best.startMs + durationMs,
    amountRaw: best.amountRaw.toString(),
    eventCount: best.eventCount,
  }
}

/** Gross receipt-reconciled underlying inflow. Comet Supply can also repay debt. */
export function maxDirectSupplierSupplyWindow({ marketKey, coverage, supplies, durationMs }) {
  const market = pinnedMarket(marketKey)
  if (!DURATIONS.has(durationMs)) throw new Error('unsupported_direct_flow_duration')
  validateCoverage(coverage, marketKey, durationMs)
  if (!Array.isArray(supplies)) throw new Error('invalid_direct_supplier_supplies')

  const dedup = new Map()
  for (const event of supplies) {
    const blockHash = hash(event?.blockHash)
    const transactionHash = hash(event?.transactionHash)
    const reconciliation = event?.reconciliation
    const evidence = reconciliation?.evidence
    const amount = raw(evidence?.amountRaw)
    if (
      event?.marketKey !== marketKey ||
      !blockHash ||
      !transactionHash ||
      !integer(event.logIndex) ||
      !integer(event.timestampMs) ||
      event.timestampMs < coverage.startMs ||
      event.timestampMs >= coverage.endMs ||
      reconciliation?.status !== 'reconciled_supplier_supply' ||
      reconciliation.reason !== null ||
      reconciliation.marketKey !== marketKey ||
      reconciliation.routeKey !== market.routeKey ||
      reconciliation.destination?.toLowerCase() !== market.destination ||
      reconciliation.underlying?.toLowerCase() !== market.underlying ||
      hash(reconciliation.transactionHash) !== transactionHash ||
      evidence?.supplyLogIndex !== event.logIndex ||
      !integer(evidence?.transferLogIndex) ||
      evidence.transferLogIndex >= event.logIndex ||
      !ADDRESS.test(evidence.supplier ?? '') ||
      !ADDRESS.test(evidence.beneficiary ?? '') ||
      amount === null ||
      amount <= 0n
    )
      throw new Error('invalid_direct_supplier_supply')
    const id = `${blockHash}/${transactionHash}/${event.logIndex}`
    const fingerprint = JSON.stringify({
      timestampMs: event.timestampMs,
      amountRaw: amount.toString(),
      supplier: evidence.supplier.toLowerCase(),
      beneficiary: evidence.beneficiary.toLowerCase(),
      transferLogIndex: evidence.transferLogIndex,
    })
    const previous = dedup.get(id)
    if (previous && previous.fingerprint !== fingerprint)
      throw new Error('conflicting_direct_supplier_event_replay')
    dedup.set(id, { id, timestampMs: event.timestampMs, amount, fingerprint })
  }

  const events = [...dedup.values()].sort(
    (a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id),
  )
  const lastStart = coverage.endMs - durationMs
  const starts = [
    coverage.startMs,
    ...events.map((event) => Math.min(event.timestampMs, lastStart)),
  ]
    .sort((a, b) => a - b)
    .filter((start, i, all) => i === 0 || start !== all[i - 1])
  let left = 0
  let right = 0
  let sum = 0n
  let best = { startMs: starts[0], amountRaw: 0n, eventCount: 0 }
  for (const startMs of starts) {
    while (left < right && events[left].timestampMs < startMs) sum -= events[left++].amount
    while (right < events.length && events[right].timestampMs < startMs + durationMs)
      sum += events[right++].amount
    if (sum > best.amountRaw) best = { startMs, amountRaw: sum, eventCount: right - left }
  }
  return {
    marketKey,
    routeKey: market.routeKey,
    destination: market.destination,
    underlying: market.underlying,
    durationMs,
    coverageStartMs: coverage.startMs,
    coverageEndMs: coverage.endMs,
    startMs: best.startMs,
    endMs: best.startMs + durationMs,
    amountRaw: best.amountRaw.toString(),
    eventCount: best.eventCount,
  }
}

/** Gross Comet base Withdraw events include supplier exits and borrowing. */
export function maxCometWithdrawEventWindow({
  coverage,
  withdrawals,
  unclassifiedWithdrawals,
  durationMs,
}) {
  const marketKey = 'compoundV3Usdc'
  const market = pinnedMarket(marketKey)
  if (!DURATIONS.has(durationMs)) throw new Error('unsupported_direct_flow_duration')
  if (
    coverage?.marketKey !== marketKey ||
    !integer(coverage.startMs) ||
    !integer(coverage.endMs) ||
    coverage.endMs - coverage.startMs < durationMs ||
    !Array.isArray(coverage.intervals) ||
    !Array.isArray(withdrawals) ||
    !Array.isArray(unclassifiedWithdrawals)
  )
    throw new Error('invalid_comet_flow_coverage')
  let cursor = coverage.startMs
  let ambiguousCount = 0
  for (const interval of coverage.intervals) {
    if (
      interval.startMs !== cursor ||
      !integer(interval.endMs) ||
      interval.endMs <= cursor ||
      interval.finalized !== true ||
      !integer(interval.ambiguousReceipts) ||
      interval.receiptsComplete !== (interval.ambiguousReceipts === 0)
    )
      throw new Error('incomplete_comet_flow_coverage')
    ambiguousCount += interval.ambiguousReceipts
    cursor = interval.endMs
  }
  if (cursor !== coverage.endMs || ambiguousCount !== unclassifiedWithdrawals.length)
    throw new Error('incomplete_comet_flow_coverage')

  const events = withdrawals.map((event) => validateWithdrawal(event, marketKey, market, coverage))
  for (const event of unclassifiedWithdrawals) {
    const blockHash = hash(event?.blockHash)
    const transactionHash = hash(event?.transactionHash)
    const amount = raw(event?.eventAmountRaw)
    if (
      event?.marketKey !== marketKey ||
      !blockHash ||
      !transactionHash ||
      !integer(event.logIndex) ||
      !integer(event.timestampMs) ||
      event.timestampMs < coverage.startMs ||
      event.timestampMs >= coverage.endMs ||
      amount === null ||
      amount <= 0n ||
      ![
        'mixed_or_multiple_market_flows',
        'withdraw_payout_mismatch',
        'comet_borrow_or_share_burn_mismatch',
      ].includes(event.reason)
    )
      throw new Error('invalid_unclassified_comet_withdrawal')
    events.push({
      id: `${blockHash}/${transactionHash}/${event.logIndex}`,
      timestampMs: event.timestampMs,
      amount,
      fingerprint: `${event.timestampMs}/${amount}/${event.reason}`,
    })
  }
  if (new Set(events.map((event) => event.id)).size !== events.length)
    throw new Error('duplicate_comet_withdraw_event')
  events.sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id))
  const lastStart = coverage.endMs - durationMs
  const starts = [
    coverage.startMs,
    ...events.map((event) => Math.min(event.timestampMs, lastStart)),
  ]
    .sort((a, b) => a - b)
    .filter((start, i, all) => i === 0 || start !== all[i - 1])
  let left = 0
  let right = 0
  let sum = 0n
  let best = { startMs: starts[0], amountRaw: 0n, eventCount: 0 }
  for (const startMs of starts) {
    while (left < right && events[left].timestampMs < startMs) sum -= events[left++].amount
    while (right < events.length && events[right].timestampMs < startMs + durationMs)
      sum += events[right++].amount
    if (sum > best.amountRaw) best = { startMs, amountRaw: sum, eventCount: right - left }
  }
  return {
    marketKey,
    routeKey: market.routeKey,
    destination: market.destination,
    underlying: market.underlying,
    durationMs,
    coverageStartMs: coverage.startMs,
    coverageEndMs: coverage.endMs,
    startMs: best.startMs,
    endMs: best.startMs + durationMs,
    amountRaw: best.amountRaw.toString(),
    eventCount: best.eventCount,
    includesBorrowing: true,
  }
}
