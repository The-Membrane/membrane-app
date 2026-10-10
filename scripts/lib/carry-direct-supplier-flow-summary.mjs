// Local, historical receipt context for frozen direct-supplier routes.
// This is never a holder exit forecast or a claim about present headroom.
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'
import {
  maxCometWithdrawEventWindow,
  maxDirectSupplierSupplyWindow,
  maxDirectSupplierWithdrawalWindow,
} from './carry-direct-supplier-flow-window.mjs'
import {
  STUDY,
  STUDY_V2,
  SUPPLY_STUDY,
  SUPPLY_STUDY_V2,
  verifyDirectSupplierFlowSegments,
} from '../research/collect-carry-direct-supplier-flow.mjs'
import { ROOT } from './venue-reads.mjs'

export const DIRECT_SUPPLIER_FLOW_DIR = resolve(
  ROOT,
  'data/research/venue-signals/direct-supplier-flow',
)
export const DIRECT_SUPPLIER_MARKETS = Object.freeze({
  aaveV3Usdc: { kind: 'aave', routeKey: 'USDC → supply on Aave V3', decimals: 6 },
  aaveV3Usde: { kind: 'aave', routeKey: 'USDe → supply on Aave V3', decimals: 18 },
  sparkLendUsdt: { kind: 'spark', routeKey: 'USDT → supply on Spark', decimals: 6 },
  compoundV3Usdc: { kind: 'comet', routeKey: 'USDC → supply on Compound v3', decimals: 6 },
})
const MAX_SEGMENTS = 1_000
const MAX_SEGMENT_BYTES = 2 * 1024 ** 2
const MAX_TOTAL_BYTES = 64 * 1024 ** 2
const DAY_MS = 86_400_000

function identity(marketKey) {
  const entry = DIRECT_SUPPLIER_MARKETS[marketKey]
  if (!entry) throw new Error('unsupported_direct_market')
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (item) => item.kind === entry.kind && item.routeKey === entry.routeKey,
  )
  if (!route) throw new Error('frozen_direct_market_missing')
  return {
    marketKey,
    routeKey: entry.routeKey,
    destination: route.destination.toLowerCase(),
    underlying: route.asset.toLowerCase(),
    underlyingDecimals: entry.decimals,
  }
}

/** Read the newest bounded suffix; the verifier checks every selected receipt and boundary. */
export function readDirectSupplierFlowDocuments(
  marketKey,
  directory = DIRECT_SUPPLIER_FLOW_DIR,
  flowKind = 'withdraw',
) {
  identity(marketKey)
  if (flowKind !== 'withdraw' && flowKind !== 'supply')
    throw new Error('unsupported_direct_flow_kind')
  const prefix = flowKind === 'supply' ? `supply-${marketKey}-` : `${marketKey}-`
  const studies = flowKind === 'supply' ? [SUPPLY_STUDY, SUPPLY_STUDY_V2] : [STUDY, STUDY_V2]
  const pattern = new RegExp(`^${prefix}(0|[1-9][0-9]*)-(0|[1-9][0-9]*)\\.json$`)
  const entries = readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const match = pattern.exec(name)
      if (!match) throw new Error('invalid_direct_segment_filename')
      const fromBlock = Number(match[1])
      const toBlock = Number(match[2])
      if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || toBlock < fromBlock)
        throw new Error('invalid_direct_segment_filename')
      return { name, fromBlock, toBlock }
    })
    .sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock)
  const selected = []
  let bytes = 0
  for (let index = entries.length - 1; index >= 0 && selected.length < MAX_SEGMENTS; index--) {
    const entry = entries[index]
    // A recent prefix may have an older acquisition gap. Never stitch across it.
    if (selected.length && entry.toBlock + 1 !== selected.at(-1).range.fromBlock) break
    let fd
    let raw
    try {
      fd = openSync(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW)
      const file = fstatSync(fd)
      if (!file.isFile() || file.size < 1 || file.size > MAX_SEGMENT_BYTES)
        throw new Error('invalid_direct_segment_file')
      if (bytes + file.size > MAX_TOTAL_BYTES) break
      bytes += file.size
      raw = readFileSync(fd, 'utf8')
    } catch (error) {
      if (
        error instanceof Error &&
        ['invalid_direct_segment_file', 'direct_segment_budget_exceeded'].includes(error.message)
      )
        throw error
      throw new Error('invalid_direct_segment_file')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    let document
    try {
      document = JSON.parse(raw)
    } catch {
      throw new Error('invalid_direct_segment_json')
    }
    // The full verifier below replays raw paired logs/receipts. The filename
    // must also bind that verified content to the selected market and range.
    if (
      document.marketKey !== marketKey ||
      !studies.includes(document.study) ||
      document.range?.fromBlock !== entry.fromBlock ||
      document.range?.toBlock !== entry.toBlock
    )
      throw new Error('direct_segment_filename_mismatch')
    selected.push(document)
  }
  return selected.reverse()
}

/** Receipt-matched Supply events are gross underlying inflow, including Comet debt repayment. */
export function summarizeVerifiedDirectSupplierSupply(marketKey, verified) {
  const route = identity(marketKey)
  const coverage = verified?.coverage
  const supplies = verified?.supplies
  if (
    coverage?.marketKey !== marketKey ||
    !Number.isSafeInteger(coverage.startMs) ||
    !Number.isSafeInteger(coverage.endMs) ||
    coverage.endMs <= coverage.startMs ||
    !Array.isArray(coverage.intervals) ||
    coverage.intervals.length === 0 ||
    !coverage.intervals.every(
      (interval) =>
        interval.finalized === true &&
        interval.receiptsComplete === true &&
        interval.ambiguousReceipts === 0,
    ) ||
    !Array.isArray(supplies)
  )
    throw new Error('invalid_direct_supply_coverage')
  let cursor = coverage.startMs
  for (const interval of coverage.intervals) {
    if (
      !Number.isSafeInteger(interval.startMs) ||
      !Number.isSafeInteger(interval.endMs) ||
      interval.startMs !== cursor ||
      interval.endMs <= interval.startMs ||
      interval.endMs > coverage.endMs
    )
      throw new Error('invalid_direct_supply_coverage')
    cursor = interval.endMs
  }
  if (cursor !== coverage.endMs) throw new Error('invalid_direct_supply_coverage')
  let gross = 0n
  for (const event of supplies) {
    const amount = event?.reconciliation?.evidence?.amountRaw
    if (
      event?.marketKey !== marketKey ||
      event?.reconciliation?.status !== 'reconciled_supplier_supply' ||
      !/^[1-9][0-9]*$/.test(amount ?? '')
    )
      throw new Error('invalid_direct_supplier_supply')
    gross += BigInt(amount)
  }
  const complete24h = coverage.endMs - coverage.startMs >= DAY_MS
  const maximum = complete24h
    ? maxDirectSupplierSupplyWindow({ marketKey, coverage, supplies, durationMs: DAY_MS })
    : null
  return {
    status: 'observed',
    ...route,
    coverage: {
      startMs: coverage.startMs,
      endMs: coverage.endMs,
      durationMs: coverage.endMs - coverage.startMs,
      finalized: true,
      receiptsComplete: true,
    },
    supplyEventCount: supplies.length,
    grossUnderlyingInflowRaw: gross.toString(),
    max24hGrossUnderlyingInflow: maximum
      ? {
          status: 'observed',
          amountRaw: maximum.amountRaw,
          eventCount: maximum.eventCount,
          startMs: maximum.startMs,
          endMs: maximum.endMs,
        }
      : { status: 'unavailable', reason: 'coverage_under_24h' },
    evidenceKind: 'sealed_public_receipt_replay',
    historyScope: 'bounded_contiguous_recent_suffix',
    calibratedForecast: false,
    interpretation: 'gross_underlying_inflow_not_net_replenishment_or_holder_exit',
  }
}

export function readLocalDirectSupplierSupplySummary(
  marketKey,
  directory = DIRECT_SUPPLIER_FLOW_DIR,
) {
  const route = identity(marketKey)
  const documents = readDirectSupplierFlowDocuments(marketKey, directory, 'supply')
  if (!documents.length)
    return {
      status: 'unavailable',
      ...route,
      reason: 'no_sealed_segments',
      calibratedForecast: false,
    }
  return summarizeVerifiedDirectSupplierSupply(
    marketKey,
    verifyDirectSupplierFlowSegments(documents),
  )
}

export function summarizeVerifiedDirectSupplierFlow(marketKey, verified) {
  const route = identity(marketKey)
  const coverage = verified?.coverage
  const withdrawals = verified?.withdrawals
  const unclassifiedWithdrawals = verified?.unclassifiedWithdrawals
  if (
    coverage?.marketKey !== marketKey ||
    !Number.isSafeInteger(coverage.startMs) ||
    !Number.isSafeInteger(coverage.endMs) ||
    coverage.endMs <= coverage.startMs ||
    !Array.isArray(withdrawals) ||
    !Array.isArray(unclassifiedWithdrawals)
  )
    throw new Error('invalid_direct_flow_coverage')
  let largest = 0n
  let sameAddressSettledCount = 0
  for (const event of withdrawals) {
    const evidence = event?.reconciliation?.evidence
    const amount = evidence?.amountRaw
    if (
      event.marketKey !== marketKey ||
      !/^[1-9][0-9]*$/.test(amount ?? '') ||
      !/^0x[0-9a-f]{40}$/i.test(evidence?.holder ?? '') ||
      !/^0x[0-9a-f]{40}$/i.test(evidence?.receiver ?? '')
    )
      throw new Error('invalid_direct_supplier_withdrawal')
    if (evidence.holder.toLowerCase() !== evidence.receiver.toLowerCase()) continue
    sameAddressSettledCount++
    const raw = BigInt(amount)
    if (raw > largest) largest = raw
  }
  const complete24h = coverage.endMs - coverage.startMs >= DAY_MS
  const receiptsComplete = unclassifiedWithdrawals.length === 0
  let grossCometWithdrawRaw = 0n
  if (marketKey === 'compoundV3Usdc') {
    for (const event of withdrawals)
      grossCometWithdrawRaw += BigInt(event.reconciliation.evidence.amountRaw)
    for (const event of unclassifiedWithdrawals) {
      if (event.marketKey !== marketKey || !/^[1-9][0-9]*$/.test(event.eventAmountRaw ?? ''))
        throw new Error('invalid_unclassified_comet_withdrawal')
      grossCometWithdrawRaw += BigInt(event.eventAmountRaw)
    }
  }
  const maximum =
    complete24h && receiptsComplete
      ? maxDirectSupplierWithdrawalWindow({
          marketKey,
          coverage,
          withdrawals,
          durationMs: DAY_MS,
        })
      : null
  const cometMaximum =
    marketKey === 'compoundV3Usdc' && complete24h
      ? maxCometWithdrawEventWindow({
          coverage,
          withdrawals,
          unclassifiedWithdrawals,
          durationMs: DAY_MS,
        })
      : null
  return {
    status: 'observed',
    ...route,
    coverage: {
      startMs: coverage.startMs,
      endMs: coverage.endMs,
      durationMs: coverage.endMs - coverage.startMs,
      finalized: true,
      receiptsComplete,
    },
    payoutCount: withdrawals.length,
    unclassifiedWithdrawalCount: unclassifiedWithdrawals.length,
    ...(marketKey === 'compoundV3Usdc'
      ? {
          grossCometWithdrawEvents: {
            eventCount: withdrawals.length + unclassifiedWithdrawals.length,
            amountRaw: grossCometWithdrawRaw.toString(),
          },
          max24hGrossCometWithdrawEvents: cometMaximum
            ? {
                status: 'observed',
                amountRaw: cometMaximum.amountRaw,
                eventCount: cometMaximum.eventCount,
                startMs: cometMaximum.startMs,
                endMs: cometMaximum.endMs,
              }
            : { status: 'unavailable', reason: 'coverage_under_24h' },
        }
      : {}),
    sameAddressSettledCount,
    largestSameAddressSinglePayoutRaw: largest.toString(),
    max24hGrossWithdrawal: maximum
      ? {
          status: 'observed',
          amountRaw: maximum.amountRaw,
          startMs: maximum.startMs,
          endMs: maximum.endMs,
          payoutCount: maximum.eventCount,
        }
      : {
          status: 'unavailable',
          reason: receiptsComplete ? 'coverage_under_24h' : 'unclassified_withdrawals',
        },
    evidenceKind: 'sealed_public_receipt_replay',
    historyScope: 'bounded_contiguous_recent_suffix',
    calibratedForecast: false,
    limitations: [
      'Historical gross flow includes other holders, not the queried holder’s future exit capacity.',
      'Same-address payout counts do not prove an end-to-end route or future headroom.',
      'Hash seals and paired RPC results do not independently prove upstream provider honesty.',
      ...(receiptsComplete
        ? []
        : [
            'Some corroborated market Withdraw events could not be classified as supplier payouts.',
          ]),
    ],
  }
}

export function readLocalDirectSupplierFlowSummary(
  marketKey,
  directory = DIRECT_SUPPLIER_FLOW_DIR,
) {
  const route = identity(marketKey)
  const documents = readDirectSupplierFlowDocuments(marketKey, directory)
  if (!documents.length)
    return {
      status: 'unavailable',
      ...route,
      reason: 'no_sealed_segments',
      calibratedForecast: false,
    }
  return summarizeVerifiedDirectSupplierFlow(marketKey, verifyDirectSupplierFlowSegments(documents))
}
