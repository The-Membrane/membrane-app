// Offline, censoring-aware request-to-holder-USDat-payment diagnostic for the
// frozen Saturn ticket cohort. Payment receipts prove the exact holder and
// amount, but do not contain block timestamps, so payment durations remain
// interval-censored between independently sealed block headers.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { verifyPayouts } from './saturn-queue-claim-payouts.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'
import { TO, verifyQueueEvents } from './saturn-queue-event-cohort.mjs'
import { verifyPending } from './saturn-queue-pending-terms.mjs'
import { verifyBoundary } from './saturn-queue-upgrade-boundary.mjs'

export const HORIZON_HOURS = Object.freeze([24, 72, 168, 336, 672])
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9]\d*)$/
const safePositive = (value) => Number.isSafeInteger(value) && value > 0
const canonical = JSON.stringify
const utc = (seconds) => new Date(seconds * 1_000).toISOString()
const ticketId = (log) => BigInt(log.topics[1]).toString()
const address = (topic) => `0x${topic.slice(-40)}`
const word = (data, index) => BigInt(`0x${data.slice(2 + index * 64, 66 + index * 64)}`)
const eventPosition = (log) => [log.blockNumber, log.logIndex]
const before = (left, right) => left[0] < right[0] || (left[0] === right[0] && left[1] < right[1])

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
}

function quantile(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)]
}

function exactDurationSummary(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return {
    observed: sorted.length,
    min: sorted[0],
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted.at(-1),
  }
}

function intervalDurationSummary(intervals) {
  if (intervals.length === 0) return null
  const lower = intervals.map((row) => row.lowerSeconds).sort((a, b) => a - b)
  const upper = intervals.map((row) => row.upperSeconds).sort((a, b) => a - b)
  const bounded = (fraction) => ({
    lowerSeconds: quantile(lower, fraction),
    upperSeconds: quantile(upper, fraction),
  })
  return {
    observed: intervals.length,
    intervalBasis: 'exact payment block bounded by sealed historical block-header timestamps',
    min: bounded(0),
    p25: bounded(0.25),
    median: bounded(0.5),
    p75: bounded(0.75),
    max: bounded(1),
  }
}

function rawAmountSummary(values) {
  if (values.length === 0) return null
  const sorted = values
    .map(BigInt)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const pick = (fraction) => quantile(sorted, fraction).toString()
  return {
    count: sorted.length,
    minRaw: pick(0),
    p25Raw: pick(0.25),
    medianRaw: pick(0.5),
    p75Raw: pick(0.75),
    maxRaw: pick(1),
    sumRaw: sorted.reduce((sum, value) => sum + value, 0n).toString(),
  }
}

function validateAsOf(asOf) {
  if (
    !safePositive(asOf?.blockNumber) ||
    !safePositive(asOf?.timestamp) ||
    !['inclusive', 'exclusive'].includes(asOf.blockRule)
  )
    throw Error('saturn_final_payment_asof_invalid')
  return asOf
}

function visibleAt(block, asOf) {
  return asOf.blockRule === 'inclusive' ? block <= asOf.blockNumber : block < asOf.blockNumber
}

/**
 * Fixed-horizon partial-identification bounds. A payment timestamp interval
 * which crosses the horizon remains interval-censored; a subject without a
 * visible payment is a known survivor only after its horizon has elapsed.
 */
export function scoreCensoringAwareHorizon(rows, asOfInput, horizonHours) {
  const asOf = validateAsOf(asOfInput)
  if (!safePositive(horizonHours)) throw Error('saturn_final_payment_horizon_invalid')
  const horizonSeconds = horizonHours * 3_600
  if (!Number.isSafeInteger(horizonSeconds)) throw Error('saturn_final_payment_horizon_invalid')
  let paidByHorizonCertain = 0
  let unpaidAtHorizonCertain = 0
  let paymentTimeIntervalCensored = 0
  let rightCensoredBeforeHorizon = 0
  for (const row of rows) {
    if (
      !safePositive(row.requestTimestamp) ||
      row.requestTimestamp > asOf.timestamp ||
      (row.finalPayment &&
        (!safePositive(row.finalPayment.blockNumber) ||
          !Number.isSafeInteger(row.finalPayment.durationLowerSeconds) ||
          !Number.isSafeInteger(row.finalPayment.durationUpperSeconds) ||
          row.finalPayment.durationLowerSeconds < 0 ||
          row.finalPayment.durationUpperSeconds < row.finalPayment.durationLowerSeconds))
    )
      throw Error('saturn_final_payment_horizon_row_invalid')
    const paymentVisible = row.finalPayment && visibleAt(row.finalPayment.blockNumber, asOf)
    if (paymentVisible) {
      const upper = Math.min(
        row.finalPayment.durationUpperSeconds,
        asOf.timestamp - row.requestTimestamp,
      )
      const lower = row.finalPayment.durationLowerSeconds
      if (upper < lower) throw Error('saturn_final_payment_horizon_bounds_invalid')
      if (upper <= horizonSeconds) paidByHorizonCertain++
      else if (lower > horizonSeconds) unpaidAtHorizonCertain++
      else paymentTimeIntervalCensored++
    } else if (asOf.timestamp - row.requestTimestamp >= horizonSeconds) {
      unpaidAtHorizonCertain++
    } else {
      rightCensoredBeforeHorizon++
    }
  }
  const subjects = rows.length
  return {
    horizonHours,
    subjects,
    paidByHorizonCertain,
    unpaidAtHorizonCertain,
    paymentTimeIntervalCensored,
    rightCensoredBeforeHorizon,
    historicalPaymentFractionBounds: {
      lower: ratio(paidByHorizonCertain, subjects),
      upper: ratio(subjects - unpaidAtHorizonCertain, subjects),
    },
    historicalSurvivalFractionBounds: {
      lower: ratio(unpaidAtHorizonCertain, subjects),
      upper: ratio(subjects - paidByHorizonCertain, subjects),
    },
  }
}

function scoreExactStageHorizon(rows, asOfInput, horizonHours) {
  const asOf = validateAsOf(asOfInput)
  const horizonSeconds = horizonHours * 3_600
  let completedByHorizon = 0
  let notCompletedByHorizon = 0
  let rightCensoredBeforeHorizon = 0
  for (const row of rows) {
    const visible = row.processing && visibleAt(row.processing.blockNumber, asOf)
    if (visible && row.processing.durationSeconds <= horizonSeconds) completedByHorizon++
    else if (asOf.timestamp - row.requestTimestamp >= horizonSeconds) notCompletedByHorizon++
    else rightCensoredBeforeHorizon++
  }
  const evaluable = completedByHorizon + notCompletedByHorizon
  return {
    horizonHours,
    subjects: rows.length,
    evaluable,
    completedByHorizon,
    notCompletedByHorizon,
    rightCensoredBeforeHorizon,
    observedCompletionRate: ratio(completedByHorizon, evaluable),
  }
}

function stageSummary(rows, asOf) {
  const visibleProcessing = rows
    .filter((row) => row.processing && visibleAt(row.processing.blockNumber, asOf))
    .map((row) => row.processing.durationSeconds)
  const visiblePayments = rows
    .filter((row) => row.finalPayment && visibleAt(row.finalPayment.blockNumber, asOf))
    .map((row) => ({
      lowerSeconds: row.finalPayment.durationLowerSeconds,
      upperSeconds: Math.min(
        row.finalPayment.durationUpperSeconds,
        asOf.timestamp - row.requestTimestamp,
      ),
    }))
  const visiblePostProcessing = rows
    .filter((row) => row.finalPayment && visibleAt(row.finalPayment.blockNumber, asOf))
    .map((row) => ({
      lowerSeconds: row.finalPayment.afterProcessingLowerSeconds,
      upperSeconds: Math.min(
        row.finalPayment.afterProcessingUpperSeconds,
        asOf.timestamp - row.requestTimestamp - row.processing.durationSeconds,
      ),
    }))
  return {
    asOf: {
      blockNumber: asOf.blockNumber,
      blockRule: asOf.blockRule,
      atUtc: utc(asOf.timestamp),
    },
    subjects: rows.length,
    requestToProcessing: {
      visibleCompletions: visibleProcessing.length,
      exactDurationSeconds: exactDurationSummary(visibleProcessing),
      horizons: HORIZON_HOURS.map((hours) => scoreExactStageHorizon(rows, asOf, hours)),
    },
    requestToFinalHolderPayment: {
      paymentAsset: 'USDat',
      visibleVerifiedPayments: visiblePayments.length,
      intervalDurationSeconds: intervalDurationSummary(visiblePayments),
      horizons: HORIZON_HOURS.map((hours) => scoreCensoringAwareHorizon(rows, asOf, hours)),
    },
    processingToFinalHolderPayment: {
      visibleVerifiedPayments: visiblePostProcessing.length,
      intervalDurationSeconds: intervalDurationSummary(visiblePostProcessing),
    },
  }
}

function orderedHeaders(episodes, boundary) {
  const byBlock = new Map()
  for (const header of [
    ...episodes.headers,
    { ...boundary.beforeHeader, sha256: boundary.sha256 },
    { ...boundary.afterHeader, sha256: boundary.sha256 },
  ]) {
    if (
      !safePositive(header.number) ||
      !safePositive(header.timestamp) ||
      !HASH.test(header.hash ?? '')
    )
      throw Error('saturn_final_payment_header_invalid')
    const prior = byBlock.get(header.number)
    if (prior && (prior.hash !== header.hash || prior.timestamp !== header.timestamp))
      throw Error('saturn_final_payment_header_conflict')
    byBlock.set(header.number, header)
  }
  const headers = [...byBlock.values()].sort((left, right) => left.number - right.number)
  for (let index = 1; index < headers.length; index++) {
    if (headers[index].timestamp <= headers[index - 1].timestamp)
      throw Error('saturn_final_payment_header_order_invalid')
  }
  return headers
}

function paymentBounds(episode, headers) {
  const lower = headers.filter((header) => header.number <= episode.claimedBlock).at(-1)
  const upper = headers.find((header) => header.number >= episode.claimedBlock)
  if (
    !lower ||
    !upper ||
    lower.number < episode.processedBlock ||
    lower.timestamp < episode.requestTimestamp + episode.waitSeconds ||
    upper.timestamp < lower.timestamp
  )
    throw Error('saturn_final_payment_bounds_missing')
  const durationLowerSeconds = lower.timestamp - episode.requestTimestamp
  const durationUpperSeconds = upper.timestamp - episode.requestTimestamp
  return {
    durationLowerSeconds,
    durationUpperSeconds,
    afterProcessingLowerSeconds: durationLowerSeconds - episode.waitSeconds,
    afterProcessingUpperSeconds: durationUpperSeconds - episode.waitSeconds,
    lowerAnchor: {
      blockNumber: lower.number,
      atUtc: utc(lower.timestamp),
      evidenceSha256: lower.sha256,
    },
    upperAnchor: {
      blockNumber: upper.number,
      atUtc: utc(upper.timestamp),
      evidenceSha256: upper.sha256,
    },
  }
}

function observedCohortQueueAtRequests(events, episodeById) {
  const active = new Map()
  const result = new Map()
  const ordered = [...events.logs].sort((left, right) =>
    before(eventPosition(left), eventPosition(right)) ? -1 : 1,
  )
  for (const log of ordered) {
    const id = ticketId(log)
    if (log.kind === 'requested' && episodeById.has(id)) {
      const episode = episodeById.get(id)
      const shares = word(log.data, 0)
      if (shares.toString() !== episode.sharesRaw || result.has(id))
        throw Error('saturn_final_payment_request_identity_invalid')
      result.set(id, {
        scope: 'earlier_open_observed_cohort_snapshot_not_service_order',
        earlierOpenCohortTickets: active.size,
        earlierOpenCohortSharesRaw: [...active.values()]
          .reduce((sum, value) => sum + value, 0n)
          .toString(),
      })
      active.set(id, shares)
    } else if ((log.kind === 'processed' || log.kind === 'cancelled') && active.has(id)) {
      active.delete(id)
    }
  }
  if (result.size !== episodeById.size) throw Error('saturn_final_payment_request_queue_incomplete')
  return result
}

function verifiedPayments(events, payouts, episodeById) {
  const claims = new Map(
    events.logs.filter((log) => log.kind === 'claimed').map((log) => [ticketId(log), log]),
  )
  const result = new Map()
  for (const transaction of payouts.transactions) {
    if (!HASH.test(transaction.transactionHash) || !Array.isArray(transaction.payouts))
      throw Error('saturn_final_payment_receipt_invalid')
    const paidByHolder = new Map()
    for (const payout of transaction.payouts) {
      const holder = payout.to?.toLowerCase()
      const episode = episodeById.get(payout.ticketId)
      const claim = claims.get(payout.ticketId)
      if (
        !episode ||
        result.has(payout.ticketId) ||
        !claim ||
        claim.transactionHash !== transaction.transactionHash ||
        claim.logIndex !== payout.claimLogIndex ||
        claim.blockNumber !== episode.claimedBlock ||
        address(claim.topics[2]) !== holder ||
        holder !== episode.claimedHolder ||
        holder !== episode.currentHolder ||
        payout.amountRaw !== episode.usdatOwedRaw ||
        BigInt(claim.data).toString() !== payout.amountRaw ||
        !ADDRESS.test(holder ?? '') ||
        !DECIMAL.test(payout.amountRaw ?? '')
      )
        throw Error('saturn_final_payment_holder_or_amount_mismatch')
      if (!paidByHolder.has(holder)) paidByHolder.set(holder, [])
      paidByHolder.get(holder).push(payout)
    }
    for (const [holder, holderPayouts] of paidByHolder) {
      const transfers = transaction.settlementTransfers.filter(
        (transfer) => transfer.to?.toLowerCase() === holder,
      )
      const paymentTotal = holderPayouts.reduce((sum, payout) => sum + BigInt(payout.amountRaw), 0n)
      const transferTotal = transfers.reduce(
        (sum, transfer) => sum + BigInt(transfer.amountRaw),
        0n,
      )
      if (paymentTotal !== transferTotal || transfers.length === 0)
        throw Error('saturn_final_payment_transfer_mismatch')
      for (const payout of holderPayouts) {
        const claim = claims.get(payout.ticketId)
        result.set(payout.ticketId, {
          transactionHash: transaction.transactionHash,
          receiptEvidenceSha256: transaction.sha256,
          blockNumber: claim.blockNumber,
          blockHash: claim.blockHash,
          claimLogIndex: claim.logIndex,
          holder,
          amountRaw: payout.amountRaw,
          settlementEvidence:
            holderPayouts.length === 1 && transfers.length === 1
              ? 'exact_single_ticket_holder_transfer'
              : 'exact_transaction_holder_aggregate_transfer',
          transactionHolderTicketCount: holderPayouts.length,
          transactionHolderSettlementRaw: transferTotal.toString(),
        })
      }
    }
  }
  if (result.size !== payouts.claimedTickets) throw Error('saturn_final_payment_count_mismatch')
  return result
}

function cutoffQueueContext(pending, cutoffHeader) {
  const pendingSharesRaw = pending.tickets
    .reduce((sum, ticket) => sum + BigInt(ticket.sharesRaw), 0n)
    .toString()
  const pendingNetUsdatQuoteRaw = pending.tickets
    .reduce((sum, ticket) => sum + BigInt(ticket.netUsdatQuoteRaw), 0n)
    .toString()
  if (
    pending.summary.pending !== pending.tickets.length ||
    pending.cutoffBlock !== cutoffHeader.number
  )
    throw Error('saturn_final_payment_pending_context_invalid')
  return {
    blockNumber: pending.cutoffBlock,
    blockHash: pending.cutoffHash,
    atUtc: utc(cutoffHeader.timestamp),
    exactCohortPendingTickets: pending.tickets.length,
    pendingSharesRaw,
    pendingNetUsdatQuoteRaw,
    quoteEligibleUsdatRaw: pending.summary.quoteEligibleUsdatRaw,
    belowCurrentMinimumTickets: pending.summary.belowCurrentMin,
    vaultUsdatBalanceRaw: pending.deployment.vaultUsdatBalanceRaw,
    queuePaused: pending.deployment.queuePaused,
    vaultPaused: pending.deployment.vaultPaused,
    marketMode: pending.deployment.marketMode,
    evidenceSha256: pending.sha256,
  }
}

/** Build the diagnostic only from already verified, in-memory source rows. */
export function buildSaturnFinalPaymentBacktest({ events, episodes, payouts, pending, boundary }) {
  if (
    events?.sha256 !== episodes?.sourceSha256 ||
    payouts?.sourceEventSha256 !== events.sha256 ||
    payouts?.sourceEpisodeSha256 !== episodes.sha256 ||
    pending?.sourceEpisodeSha256 !== episodes.sha256 ||
    boundary?.sourceEpisodeSha256 !== episodes.sha256 ||
    boundary?.sourcePendingSha256 !== pending.sha256 ||
    episodes?.toBlock !== TO ||
    !Array.isArray(episodes.episodes) ||
    !Array.isArray(payouts.transactions)
  )
    throw Error('saturn_final_payment_sources_invalid')
  const episodeById = new Map(episodes.episodes.map((episode) => [episode.ticketId, episode]))
  if (episodeById.size !== episodes.episodes.length)
    throw Error('saturn_final_payment_duplicate_ticket')
  const headers = orderedHeaders(episodes, boundary)
  const cutoffHeader = headers.find((header) => header.number === TO)
  if (!cutoffHeader) throw Error('saturn_final_payment_cutoff_missing')
  const queues = observedCohortQueueAtRequests(events, episodeById)
  const payments = verifiedPayments(events, payouts, episodeById)
  const subjects = episodes.episodes.map((episode) => {
    const payment = payments.get(episode.ticketId) ?? null
    if ((episode.status === 'claimed') !== Boolean(payment))
      throw Error('saturn_final_payment_episode_status_mismatch')
    const processing = episode.waitCensored
      ? null
      : {
          blockNumber: episode.processedBlock,
          durationSeconds: episode.waitSeconds,
          usdatOwedRaw: episode.usdatOwedRaw,
        }
    const finalPayment = payment
      ? {
          ...payment,
          ...paymentBounds(episode, headers),
        }
      : null
    const requestRegime = episode.requestBlock < boundary.firstNewBlock ? 'queue_v1' : 'queue_v2'
    return {
      ticketId: episode.ticketId,
      requestBlock: episode.requestBlock,
      requestTimestamp: episode.requestTimestamp,
      requestedAtUtc: utc(episode.requestTimestamp),
      requestHolder: episode.requestHolder,
      finalHolder: episode.currentHolder,
      holderTransfers: episode.holderTransfers,
      requestSharesRaw: episode.sharesRaw,
      requestRegime,
      crossedSavedRegimeBoundary:
        episode.requestBlock < boundary.firstNewBlock &&
        (episode.claimedBlock ?? episode.processedBlock ?? TO) >= boundary.firstNewBlock,
      observedEarlierOpenCohortAtRequest: queues.get(episode.ticketId),
      processing,
      finalPayment,
      censoredAtCutoff: finalPayment === null,
    }
  })
  const ordered = [...subjects].sort(
    (left, right) =>
      left.requestTimestamp - right.requestTimestamp ||
      left.requestBlock - right.requestBlock ||
      (BigInt(left.ticketId) < BigInt(right.ticketId) ? -1 : 1),
  )
  const midpoint = Math.floor(ordered.length / 2)
  const development = ordered.slice(0, midpoint)
  const holdout = ordered.slice(midpoint)
  const firstHoldout = holdout[0]
  if (
    development.length === 0 ||
    holdout.length === 0 ||
    development.at(-1).requestTimestamp >= firstHoldout.requestTimestamp
  )
    throw Error('saturn_final_payment_split_invalid')
  const developmentAsOf = {
    blockNumber: firstHoldout.requestBlock,
    blockRule: 'exclusive',
    timestamp: firstHoldout.requestTimestamp - 1,
  }
  const finalAsOf = {
    blockNumber: TO,
    blockRule: 'inclusive',
    timestamp: cutoffHeader.timestamp,
  }
  const paymentRows = subjects.filter((row) => row.finalPayment)
  const queueDepths = subjects.map(
    (row) => row.observedEarlierOpenCohortAtRequest.earlierOpenCohortTickets,
  )
  const queueShares = subjects.map(
    (row) => row.observedEarlierOpenCohortAtRequest.earlierOpenCohortSharesRaw,
  )
  const developmentVisiblePayments = development.filter(
    (row) => row.finalPayment && visibleAt(row.finalPayment.blockNumber, developmentAsOf),
  ).length
  return {
    study: 'saturn_final_holder_payment_duration_backtest_v1',
    scope: {
      start: 'ticket_request',
      processingStage: 'operator_processing_to_fixed_usdat_owed',
      paymentStage: 'verified_queue_to_exact_ticket_holder_usdat_transfer',
      paymentAsset: 'USDat',
      routeFinalAusdPaymentAssessed: false,
    },
    sources: {
      eventCohortSha256: events.sha256,
      episodeCohortSha256: episodes.sha256,
      finalPaymentReceiptCohortSha256: payouts.sha256,
      cutoffPendingTermsSha256: pending.sha256,
      implementationBoundarySha256: boundary.sha256,
    },
    cohort: {
      requests: subjects.length,
      holders: new Set(subjects.map((row) => row.requestHolder)).size,
      verifiedFinalHolderPayments: paymentRows.length,
      finalPaymentTransactions: payouts.transactions.length,
      exactHolderMatches: paymentRows.filter((row) => row.finalPayment.holder === row.finalHolder)
        .length,
      holderTransfers: subjects.reduce((sum, row) => sum + row.holderTransfers, 0),
      requestSharesRaw: rawAmountSummary(subjects.map((row) => row.requestSharesRaw)),
      paidUsdatRaw: rawAmountSummary(paymentRows.map((row) => row.finalPayment.amountRaw)),
      observedEarlierOpenCohortAtRequest: {
        tickets: exactDurationSummary(queueDepths),
        sharesRaw: rawAmountSummary(queueShares),
        limitation:
          'chronologically earlier open cohort only; not FIFO or service priority, and requests open before the frozen event window are absent',
      },
    },
    cutoffQueueContext: cutoffQueueContext(pending, cutoffHeader),
    savedImplementationBoundary: {
      lastQueueV1Block: boundary.lastOldBlock,
      firstQueueV2Block: boundary.firstNewBlock,
      queueV1EndedAtUtc: utc(boundary.beforeHeader.timestamp),
      queueV2BeganAtUtc: utc(boundary.afterHeader.timestamp),
      requestsByRegime: {
        queueV1: subjects.filter((row) => row.requestRegime === 'queue_v1').length,
        queueV2: subjects.filter((row) => row.requestRegime === 'queue_v2').length,
        crossedBoundaryBeforeObservedEnd: subjects.filter((row) => row.crossedSavedRegimeBoundary)
          .length,
      },
    },
    fullCohortAtCutoff: stageSummary(subjects, finalAsOf),
    chronologicalSplit: {
      method: 'first_half_requests_development_second_half_requests_holdout',
      splitRequestBlock: firstHoldout.requestBlock,
      splitAtUtc: utc(firstHoldout.requestTimestamp),
      developmentAsOfUtc: utc(developmentAsOf.timestamp),
      development: {
        ...stageSummary(development, developmentAsOf),
        verifiedPaymentsLearnedAfterSplitExcluded:
          development.filter((row) => row.finalPayment).length - developmentVisiblePayments,
        queueV2Requests: development.filter((row) => row.requestRegime === 'queue_v2').length,
      },
      holdout: {
        ...stageSummary(holdout, finalAsOf),
        queueV2Requests: holdout.filter((row) => row.requestRegime === 'queue_v2').length,
      },
      boundaryKnownAtDevelopmentAsOf: boundary.firstNewBlock < developmentAsOf.blockNumber,
    },
    validation: {
      status: 'not_validated',
      forecastValidated: false,
      reasons: [
        'retrospective cohort and chronological split',
        'payment timestamps are interval-censored because sealed receipts omit block timestamps',
        'holdout crosses a saved queue implementation boundary',
        'request-to-payment includes holder claim timing after operator processing',
        'verified USDat payment is not final AUSD route completion',
        'request-time queue pressure is a cohort-local lower bound',
      ],
    },
    subjects,
  }
}

export async function readVerifiedSaturnFinalPaymentBacktest() {
  // Every reader below is an offline verifier of an existing sealed artifact.
  const [events, episodes, payouts, pending, boundary] = await Promise.all([
    verifyQueueEvents(),
    verifyEpisodes(),
    verifyPayouts(),
    verifyPending(),
    verifyBoundary(),
  ])
  return buildSaturnFinalPaymentBacktest({ events, episodes, payouts, pending, boundary })
}

function summaryOnly(report) {
  const { subjects: _subjects, ...summary } = report
  return summary
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const mode = process.argv[2]
    if (process.argv.length !== 3 || !['--summary', '--subjects'].includes(mode))
      throw Error('usage: --summary|--subjects')
    const report = await readVerifiedSaturnFinalPaymentBacktest()
    process.stdout.write(canonical(mode === '--subjects' ? report : summaryOnly(report)) + '\n')
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n')
    process.exitCode = 1
  }
}
