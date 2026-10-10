// Read-only reserve-cash shadow scenarios. These do not simulate a holder withdrawal.
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createVerifiedJoinSession,
  STUDY as JOIN_STUDY,
  CONTINUATION_STUDY as JOIN_CONTINUATION_STUDY,
} from './aave-usdc-cash-direct-flow-join.mjs'

export const STUDY = 'aave-usdc-flow-shadow-forecast-v1'
export const STITCH_STUDY = 'aave-usdc-cash-direct-flow-verified-stitch-v1'
const RAW = /^(0|[1-9][0-9]*)$/
const HASH = /^0x[0-9a-f]{64}$/
const fail = (okay, code) => {
  if (!okay) throw new Error(code)
}
const raw = (value) => {
  fail(typeof value === 'string' && RAW.test(value), 'shadow_invalid_raw_amount')
  return BigInt(value)
}
const clamp = (value) => (value < 0n ? 0n : value)
const min = (a, b) => (a < b ? a : b)
const abs = (value) => (value < 0n ? -value : value)
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function percentile(values, numerator, denominator = 100) {
  fail(values.length > 0, 'shadow_empty_sample')
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor(((sorted.length - 1) * numerator) / denominator)]
}

function verifiedShape(joined) {
  fail(
    (joined?.study === JOIN_STUDY ||
      joined?.study === JOIN_CONTINUATION_STUDY ||
      joined?.study === STITCH_STUDY) &&
      joined.forecast === false,
    'shadow_unverified_join',
  )
  fail(Array.isArray(joined.slices) && joined.slices.length > 0, 'shadow_empty_join')
  let next = joined.fromBlock
  let cash = null
  let boundaryHash = null
  const slices = joined.slices.map((row) => {
    fail(
      Number.isSafeInteger(row.fromExclusive) &&
        Number.isSafeInteger(row.toInclusive) &&
        row.fromExclusive === next &&
        row.toInclusive > next &&
        HASH.test(row.fromHash) &&
        HASH.test(row.toHash) &&
        (boundaryHash === null || boundaryHash === row.fromHash),
      'shadow_noncontiguous_slices',
    )
    const opening = raw(row.cashBeforeRaw)
    const closing = raw(row.cashAfterRaw)
    const incoming = raw(row.grossReserveInRaw)
    const outgoing = raw(row.grossReserveOutRaw)
    const supplierIn = raw(row.grossSupplierSupplyRaw)
    const supplierOut = raw(row.grossSupplierWithdrawalRaw)
    const otherIn = raw(row.otherReserveInRaw)
    const otherOut = raw(row.otherReserveOutRaw)
    const minimum = raw(row.minEndOfBlockCashRaw)
    fail(
      Number.isSafeInteger(row.minEndOfBlockCashAtBlock) &&
        row.minEndOfBlockCashAtBlock >= row.fromExclusive &&
        row.minEndOfBlockCashAtBlock <= row.toInclusive &&
        minimum <= opening &&
        minimum <= closing &&
        (minimum === opening || row.minEndOfBlockCashAtBlock > row.fromExclusive),
      'shadow_invalid_block_trough',
    )
    fail(
      opening + incoming - outgoing === closing &&
        supplierIn + otherIn === incoming &&
        supplierOut + otherOut === outgoing &&
        (cash === null || cash === opening),
      'shadow_cash_identity',
    )
    next = row.toInclusive
    cash = closing
    boundaryHash = row.toHash
    return {
      from: row.fromExclusive,
      to: row.toInclusive,
      opening,
      closing,
      incoming,
      outgoing,
      minimum,
      minimumAtBlock: row.minEndOfBlockCashAtBlock,
    }
  })
  fail(next === joined.toBlock, 'shadow_join_endpoint_mismatch')
  return slices
}

/** Joins independently replayed, overlapping verified windows without inventing a slice. */
export function stitchVerifiedJoinChunks(chunks) {
  fail(Array.isArray(chunks) && chunks.length > 0, 'shadow_empty_join_chunks')
  const slices = []
  const chunkDigests = []
  const byStart = new Map()
  let currentBlock = null
  for (const chunk of chunks) {
    fail(
      chunk?.study === JOIN_STUDY || chunk?.study === JOIN_CONTINUATION_STUDY,
      'shadow_invalid_chunk_study',
    )
    verifiedShape(chunk)
    fail(
      currentBlock === null || (chunk.fromBlock <= currentBlock && chunk.toBlock > currentBlock),
      'shadow_chunk_gap_or_no_extension',
    )
    for (const slice of chunk.slices) {
      if (slice.toInclusive <= currentBlock) {
        fail(
          JSON.stringify(byStart.get(slice.fromExclusive)) === JSON.stringify(slice),
          'shadow_chunk_overlap_mismatch',
        )
      } else {
        fail(currentBlock === null || slice.fromExclusive === currentBlock, 'shadow_chunk_gap')
        slices.push(slice)
        byStart.set(slice.fromExclusive, slice)
        currentBlock = slice.toInclusive
      }
    }
    chunkDigests.push(digest(chunk))
  }
  return {
    study: STITCH_STUDY,
    forecast: false,
    fromBlock: chunks[0].fromBlock,
    toBlock: currentBlock,
    slices,
    verifiedChunkDigests: chunkDigests,
  }
}

/** Full local archive replay; each constituent chunk is pinned by the verified join session. */
export function replayFullArchiveJoin(session = createVerifiedJoinSession()) {
  const endpoints = session.pinEndpoints()
  fail(endpoints.length > 0, 'shadow_empty_archive_endpoints')
  const selected = []
  for (let index = 126; index < endpoints.length - 1; index += 127) selected.push(endpoints[index])
  selected.push(endpoints.at(-1))
  return stitchVerifiedJoinChunks(selected.map((endpoint) => session.at(endpoint)))
}

function exactWindows(slices, horizonBlocks) {
  const boundary = new Map([[slices[0].from, { cash: slices[0].opening, index: 0 }]])
  slices.forEach((slice, index) =>
    boundary.set(slice.to, { cash: slice.closing, index: index + 1 }),
  )
  const windows = []
  for (const [originBlock, start] of boundary) {
    const target = boundary.get(originBlock + horizonBlocks)
    if (!target) continue
    const run = slices.slice(start.index, target.index)
    const incoming = run.reduce((sum, row) => sum + row.incoming, 0n)
    const outgoing = run.reduce((sum, row) => sum + row.outgoing, 0n)
    let observedMinimum = start.cash
    let observedMinimumAtBlock = originBlock
    for (const row of run) {
      if (row.minimum < observedMinimum) {
        observedMinimum = row.minimum
        observedMinimumAtBlock = row.minimumAtBlock
      }
    }
    fail(start.cash + incoming - outgoing === target.cash, 'shadow_window_cash_identity')
    windows.push({
      originBlock,
      targetBlock: originBlock + horizonBlocks,
      sourceCash: start.cash,
      targetCash: target.cash,
      incoming,
      outgoing,
      observedMinimum,
      observedMinimumAtBlock,
      drawdown: start.cash - observedMinimum,
    })
  }
  return windows
}

function nonoverlapping(windows) {
  const selected = []
  let previousTarget = -1
  for (const window of windows) {
    if (window.originBlock < previousTarget) continue
    selected.push(window)
    previousTarget = window.targetBlock
  }
  return selected
}

/** Compact retrospective archive statistics; join provenance is caller responsibility. */
export function buildHistoricalFlowSummary({ joined, horizonBlocks = 256 }) {
  fail(Number.isSafeInteger(horizonBlocks) && horizonBlocks > 0, 'shadow_invalid_horizon')
  const slices = verifiedShape(joined)
  const exact = exactWindows(slices, horizonBlocks)
  const selected = nonoverlapping(exact)
  const distribution = (values) =>
    values.length
      ? {
          minimum: percentile(values, 0).toString(),
          lower: percentile(values, 10).toString(),
          median: percentile(values, 50).toString(),
          upper: percentile(values, 90).toString(),
          maximum: percentile(values, 100).toString(),
        }
      : null
  const extrema = (values, low) =>
    values.length ? percentile(values, low ? 0 : 100).toString() : null
  const endpointDelta = (window) => window.targetCash - window.sourceCash
  const troughDelta = (window) => window.observedMinimum - window.sourceCash
  const pairedWindows = selected.map((window) => ({
    originBlock: window.originBlock,
    targetBlock: window.targetBlock,
    sourceCashRaw: window.sourceCash.toString(),
    targetCashRaw: window.targetCash.toString(),
    grossReserveInRaw: window.incoming.toString(),
    grossReserveOutRaw: window.outgoing.toString(),
    endpointCashDeltaRaw: endpointDelta(window).toString(),
    troughCashRaw: window.observedMinimum.toString(),
    troughCashDeltaRaw: troughDelta(window).toString(),
    troughBlock: window.observedMinimumAtBlock,
  }))
  return {
    schema: 'carry_historical_paired_flow_summary_v1',
    study: 'aave-usdc-historical-flow-summary-v1',
    source: {
      joinedStudy: joined.study,
      fromBlock: slices[0].from,
      toBlock: slices.at(-1).to,
      joinContentSha256: digest(joined),
    },
    sourceVerification: 'join_shape_only',
    horizonBlocks,
    exactHorizonWindows: exact.length,
    nonoverlappingWindowCount: selected.length,
    distributionScope: 'nonoverlapping_exact_windows',
    pairedWindows,
    pairedWindowsSha256: digest(pairedWindows),
    nonoverlappingDistributions: {
      grossReserveInRaw: distribution(selected.map((window) => window.incoming)),
      grossReserveOutRaw: distribution(selected.map((window) => window.outgoing)),
      endpointCashDeltaRaw: distribution(selected.map(endpointDelta)),
      troughCashDeltaRaw: distribution(selected.map(troughDelta)),
    },
    exactWindowExtrema: {
      maxGrossReserveInRaw: extrema(
        exact.map((window) => window.incoming),
        false,
      ),
      maxGrossReserveOutRaw: extrema(
        exact.map((window) => window.outgoing),
        false,
      ),
      minEndpointCashDeltaRaw: extrema(exact.map(endpointDelta), true),
      minTroughCashDeltaRaw: extrema(exact.map(troughDelta), true),
    },
    interpretation: 'retrospective_unscaled_historical_replay',
    validation: 'not_validated',
    holderExecutableExit: false,
    withinHorizonDurationEstimated: false,
    flowMeasure: 'gross_reserve_in_and_out_including_supplier_and_other_flows',
  }
}

/** Retrospective gross-flow stress. Caller must source joined via replayFullArchiveJoin. */
export function buildHistoricalGrossFlowStress({
  joined,
  horizonBlocks = 256,
  currentCashRaw,
  requestedRaw,
}) {
  fail(Number.isSafeInteger(horizonBlocks) && horizonBlocks > 0, 'shadow_invalid_horizon')
  const currentCash = raw(currentCashRaw)
  const requested = raw(requestedRaw)
  fail(requested > 0n, 'shadow_invalid_request')
  const slices = verifiedShape(joined)
  const exact = exactWindows(slices, horizonBlocks)
  const windows = nonoverlapping(exact)
  const distribution = (values) =>
    values.length
      ? {
          lower: percentile(values, 10).toString(),
          median: percentile(values, 50).toString(),
          upper: percentile(values, 90).toString(),
          minimum: percentile(values, 0).toString(),
          maximum: percentile(values, 100).toString(),
        }
      : null
  const replay = (window) => {
    const translatedEndpoint = currentCash + window.targetCash - window.sourceCash
    const translatedTrough = currentCash + window.observedMinimum - window.sourceCash
    const endpointCash = clamp(translatedEndpoint)
    const troughCash = clamp(translatedTrough)
    return {
      originBlock: window.originBlock,
      targetBlock: window.targetBlock,
      observedTroughAtBlock: window.observedMinimumAtBlock,
      grossReserveInRaw: window.incoming.toString(),
      grossReserveOutRaw: window.outgoing.toString(),
      endpointCashDeltaRaw: (window.targetCash - window.sourceCash).toString(),
      troughCashDeltaRaw: (window.observedMinimum - window.sourceCash).toString(),
      endpointReplayDeficitRaw: clamp(-translatedEndpoint).toString(),
      troughReplayDeficitRaw: clamp(-translatedTrough).toString(),
      infeasibleReplay: translatedTrough < 0n,
      endpointMarginToRequestedRaw: (endpointCash - requested).toString(),
      troughMarginToRequestedRaw: (troughCash - requested).toString(),
    }
  }
  const samples = windows.map(replay)
  const exactReplays = exact.map(replay)
  const maxRaw = (values) =>
    values.length ? values.reduce((max, value) => (value > max ? value : max)).toString() : null
  const minRaw = (values) =>
    values.length
      ? values.reduce((minimum, value) => (value < minimum ? value : minimum)).toString()
      : null
  return {
    study: 'aave-usdc-historical-gross-flow-stress-v1',
    source: {
      joinedStudy: joined.study,
      fromBlock: slices[0].from,
      toBlock: slices.at(-1).to,
      joinContentSha256: digest(joined),
    },
    horizonBlocks,
    currentCashRaw,
    requestedRaw,
    exactHorizonWindows: exact.length,
    nonoverlappingWindowCount: samples.length,
    distributionScope: 'nonoverlapping_exact_windows',
    grossReserveInRaw: distribution(windows.map((window) => window.incoming)),
    grossReserveOutRaw: distribution(windows.map((window) => window.outgoing)),
    endpointMarginToRequestedRaw: distribution(
      samples.map((sample) => BigInt(sample.endpointMarginToRequestedRaw)),
    ),
    troughMarginToRequestedRaw: distribution(
      samples.map((sample) => BigInt(sample.troughMarginToRequestedRaw)),
    ),
    exactWindowExtrema: {
      maxGrossReserveInRaw: maxRaw(exact.map((window) => window.incoming)),
      maxGrossReserveOutRaw: maxRaw(exact.map((window) => window.outgoing)),
      minEndpointMarginToRequestedRaw: minRaw(
        exactReplays.map((sample) => BigInt(sample.endpointMarginToRequestedRaw)),
      ),
      minTroughMarginToRequestedRaw: minRaw(
        exactReplays.map((sample) => BigInt(sample.troughMarginToRequestedRaw)),
      ),
      maxTroughReplayDeficitRaw: maxRaw(
        exactReplays.map((sample) => BigInt(sample.troughReplayDeficitRaw)),
      ),
    },
    samples,
    sourceVerification: 'join_shape_only',
    interpretation: 'retrospective_unscaled_historical_replay',
    validation: 'not_validated',
    holderExecutableExit: false,
    withinHorizonDurationEstimated: false,
    withinHorizonDuration: null,
    flowMeasure: 'gross_reserve_in_and_out_including_supplier_and_other_flows',
  }
}

function model(training, sourceCash, claim) {
  fail(training.length > 0, 'shadow_empty_training')
  const ins = training.map((row) => row.incoming)
  const outs = training.map((row) => row.outgoing)
  const inLow = percentile(ins, 10)
  const inPoint = percentile(ins, 50)
  const inHigh = percentile(ins, 90)
  const outLow = percentile(outs, 10)
  const outPoint = percentile(outs, 50)
  const outHigh = percentile(outs, 90)
  // Each window's trough change is <= its endpoint net change. Matched order
  // statistics preserve that inequality; independent in/out marginals do not.
  const netChanges = training.map((row) => row.incoming - row.outgoing)
  const troughChanges = training.map((row) => -row.drawdown)
  const netLow = percentile(netChanges, 10)
  const netPoint = percentile(netChanges, 50)
  const netHigh = percentile(netChanges, 90)
  const troughChangeLow = percentile(troughChanges, 10)
  const troughChangePoint = percentile(troughChanges, 50)
  const troughChangeHigh = percentile(troughChanges, 90)
  const cashLow = clamp(sourceCash + netLow)
  const cashPoint = clamp(sourceCash + netPoint)
  const cashHigh = clamp(sourceCash + netHigh)
  const troughLow = clamp(sourceCash + troughChangeLow)
  const troughPoint = clamp(sourceCash + troughChangePoint)
  const troughHigh = clamp(sourceCash + troughChangeHigh)
  fail(cashLow <= cashPoint && cashPoint <= cashHigh, 'shadow_band_order')
  fail(troughLow <= troughPoint && troughPoint <= troughHigh, 'shadow_trough_band_order')
  fail(
    troughLow <= cashLow &&
      troughPoint <= cashPoint &&
      troughHigh <= cashHigh &&
      troughHigh <= sourceCash,
    'shadow_pathwise_band_order',
  )
  return {
    grossReserveInRaw: { lower: inLow, point: inPoint, upper: inHigh },
    grossReserveOutRaw: { lower: outLow, point: outPoint, upper: outHigh },
    maxObservedReserveOutRaw: outs.reduce((max, value) => (value > max ? value : max), 0n),
    cashRaw: { lower: cashLow, point: cashPoint, upper: cashHigh },
    drawdownRaw: {
      lower: -troughChangeHigh,
      point: -troughChangePoint,
      upper: -troughChangeLow,
    },
    troughCashRaw: { lower: troughLow, point: troughPoint, upper: troughHigh },
    cashLimitedExitRaw: {
      lower: min(claim, cashLow),
      point: min(claim, cashPoint),
      upper: min(claim, cashHigh),
    },
    cashLimitedTroughExitRaw: {
      lower: min(claim, troughLow),
      point: min(claim, troughPoint),
      upper: min(claim, troughHigh),
    },
  }
}

function serializeModel(value) {
  return {
    grossReserveInRaw: Object.fromEntries(
      Object.entries(value.grossReserveInRaw).map(([k, v]) => [k, v.toString()]),
    ),
    grossReserveOutRaw: Object.fromEntries(
      Object.entries(value.grossReserveOutRaw).map(([k, v]) => [k, v.toString()]),
    ),
    maxObservedReserveOutRaw: value.maxObservedReserveOutRaw.toString(),
    cashRaw: Object.fromEntries(Object.entries(value.cashRaw).map(([k, v]) => [k, v.toString()])),
    drawdownRaw: Object.fromEntries(
      Object.entries(value.drawdownRaw).map(([k, v]) => [k, v.toString()]),
    ),
    troughCashRaw: Object.fromEntries(
      Object.entries(value.troughCashRaw).map(([k, v]) => [k, v.toString()]),
    ),
    cashLimitedExitRaw: Object.fromEntries(
      Object.entries(value.cashLimitedExitRaw).map(([k, v]) => [k, v.toString()]),
    ),
    cashLimitedTroughExitRaw: Object.fromEntries(
      Object.entries(value.cashLimitedTroughExitRaw).map(([k, v]) => [k, v.toString()]),
    ),
  }
}

function score(windows, fit, claim) {
  let covered = 0
  let pointError = 0n
  let persistenceError = 0n
  let troughCovered = 0
  let troughPointError = 0n
  let troughPersistenceError = 0n
  let grossInCovered = 0
  let grossOutCovered = 0
  const records = []
  for (const window of windows) {
    // Fit ends before calibration and holdout. The origin cash is known at origin.
    const scenario = model(fit, window.sourceCash, claim)
    const projected = scenario.cashRaw
    const projectedTrough = scenario.troughCashRaw
    const projectedIn = scenario.grossReserveInRaw
    const projectedOut = scenario.grossReserveOutRaw
    if (window.incoming >= projectedIn.lower && window.incoming <= projectedIn.upper)
      grossInCovered++
    if (window.outgoing >= projectedOut.lower && window.outgoing <= projectedOut.upper)
      grossOutCovered++
    if (window.targetCash >= projected.lower && window.targetCash <= projected.upper) covered++
    pointError += abs(window.targetCash - projected.point)
    persistenceError += abs(window.targetCash - window.sourceCash)
    if (
      window.observedMinimum >= projectedTrough.lower &&
      window.observedMinimum <= projectedTrough.upper
    )
      troughCovered++
    troughPointError += abs(window.observedMinimum - projectedTrough.point)
    troughPersistenceError += abs(window.observedMinimum - window.sourceCash)
    records.push({
      originBlock: window.originBlock,
      targetBlock: window.targetBlock,
      sourceCashRaw: window.sourceCash.toString(),
      predictedCashRaw: projected.point.toString(),
      predictedCashLowerRaw: projected.lower.toString(),
      predictedCashUpperRaw: projected.upper.toString(),
      observedCashRaw: window.targetCash.toString(),
      observedGrossReserveInRaw: window.incoming.toString(),
      observedGrossReserveOutRaw: window.outgoing.toString(),
      grossReserveInWithinBand:
        window.incoming >= projectedIn.lower && window.incoming <= projectedIn.upper,
      grossReserveOutWithinBand:
        window.outgoing >= projectedOut.lower && window.outgoing <= projectedOut.upper,
      withinBand: window.targetCash >= projected.lower && window.targetCash <= projected.upper,
      predictedTroughCashRaw: projectedTrough.point.toString(),
      predictedTroughLowerRaw: projectedTrough.lower.toString(),
      predictedTroughUpperRaw: projectedTrough.upper.toString(),
      observedTroughCashRaw: window.observedMinimum.toString(),
      observedTroughAtBlock: window.observedMinimumAtBlock,
      troughWithinBand:
        window.observedMinimum >= projectedTrough.lower &&
        window.observedMinimum <= projectedTrough.upper,
    })
  }
  return {
    count: windows.length,
    covered,
    pointAbsoluteErrorRaw: pointError.toString(),
    persistenceAbsoluteErrorRaw: persistenceError.toString(),
    trough: {
      covered: troughCovered,
      pointAbsoluteErrorRaw: troughPointError.toString(),
      persistenceAbsoluteErrorRaw: troughPersistenceError.toString(),
    },
    grossFlow: { inCovered: grossInCovered, outCovered: grossOutCovered },
    records,
  }
}

/** Consumes only a previously verified, exact contiguous join; performs no network reads. */
export function buildShadowForecast({ joined, horizonBlocks = 256, holderClaimRaw, requestedRaw }) {
  fail(Number.isSafeInteger(horizonBlocks) && horizonBlocks > 0, 'shadow_invalid_horizon')
  const claim = raw(holderClaimRaw)
  const requested = raw(requestedRaw)
  fail(requested > 0n && requested <= claim, 'shadow_request_exceeds_claim')
  const slices = verifiedShape(joined)
  const windows = exactWindows(slices, horizonBlocks)
  const independent = nonoverlapping(windows)
  const third = Math.floor(independent.length / 3)
  const fit = independent.slice(0, third)
  const calibration = independent.slice(third, 2 * third)
  const holdout = independent.slice(2 * third)
  fail(
    !fit.length || !calibration.length || fit.at(-1).targetBlock <= calibration[0].originBlock,
    'shadow_split_leakage',
  )
  fail(
    !calibration.length ||
      !holdout.length ||
      calibration.at(-1).targetBlock <= holdout[0].originBlock,
    'shadow_split_leakage',
  )
  const currentBlock = slices.at(-1).to
  fail(Number.isSafeInteger(currentBlock + horizonBlocks), 'shadow_invalid_target_block')
  const sourceCash = slices.at(-1).closing
  // Refit the tested quantile procedure on completed, nonoverlapping windows.
  const current = independent.length >= 4 ? model(independent, sourceCash, claim) : null
  const calibrationScore = fit.length > 0 ? score(calibration, fit, claim) : null
  const holdoutScore = fit.length > 0 ? score(holdout, fit, claim) : null
  const enough = fit.length >= 20 && calibration.length >= 20 && holdout.length >= 20
  const coverage =
    enough &&
    calibrationScore.covered * 100 >= 80 * calibrationScore.count &&
    holdoutScore.covered * 100 >= 80 * holdoutScore.count &&
    calibrationScore.trough.covered * 100 >= 80 * calibrationScore.count &&
    holdoutScore.trough.covered * 100 >= 80 * holdoutScore.count
  const grossFlowCoverage =
    enough &&
    calibrationScore.grossFlow.inCovered * 100 >= 80 * calibrationScore.count &&
    calibrationScore.grossFlow.outCovered * 100 >= 80 * calibrationScore.count &&
    holdoutScore.grossFlow.inCovered * 100 >= 80 * holdoutScore.count &&
    holdoutScore.grossFlow.outCovered * 100 >= 80 * holdoutScore.count
  const skill =
    enough &&
    BigInt(holdoutScore.pointAbsoluteErrorRaw) < BigInt(holdoutScore.persistenceAbsoluteErrorRaw) &&
    BigInt(holdoutScore.trough.pointAbsoluteErrorRaw) <
      BigInt(holdoutScore.trough.persistenceAbsoluteErrorRaw)
  const historicalGatePassed = Boolean(enough && coverage && grossFlowCoverage && skill)
  return {
    study: STUDY,
    source: {
      joinedStudy: joined.study,
      fromBlock: joined.fromBlock,
      currentBlock,
      sealedSlices: slices.length,
      // A content digest identifies the exact supplied join; replayJoin is the CLI trust gate.
      joinContentSha256: digest(joined),
    },
    horizonBlocks,
    targetBlock: currentBlock + horizonBlocks,
    holderClaimRaw,
    requestedRaw,
    holderExecutableExit: false,
    exitMeasure: 'cash_limited_endpoint_and_end_of_block_trough_proxies',
    withinHorizonDurationEstimated: false,
    validation: 'not_validated',
    historicalGatePassed,
    historicalGate: {
      minimumIndependentFit: 20,
      minimumIndependentCalibration: 20,
      minimumIndependentHoldout: 20,
      minimumCalibrationCoveragePercent: 80,
      minimumHoldoutCoveragePercent: 80,
      pointMustBeatPersistence: true,
      troughMinimumCalibrationCoveragePercent: 80,
      troughMinimumHoldoutCoveragePercent: 80,
      grossInAndOutMinimumCalibrationCoveragePercent: 80,
      grossInAndOutMinimumHoldoutCoveragePercent: 80,
      troughPointMustBeatPersistence: true,
      reason: !enough
        ? 'insufficient_nonoverlapping_windows'
        : !coverage
          ? 'interval_coverage_failed'
          : !grossFlowCoverage
            ? 'gross_flow_interval_coverage_failed'
            : !skill
              ? 'point_did_not_beat_persistence'
              : 'retrospective_gate_passed_prospective_validation_still_required',
    },
    completedExactHorizonWindows: windows.length,
    independentWindows: independent.length,
    split: {
      fit: fit.length,
      calibration: calibrationScore,
      holdout: holdoutScore,
      fitLastTargetBlock: fit.at(-1)?.targetBlock ?? null,
      calibrationFirstOriginBlock: calibration[0]?.originBlock ?? null,
      holdoutFirstOriginBlock: holdout[0]?.originBlock ?? null,
    },
    scenario: current
      ? {
          ...serializeModel(current),
          cashBandMethod: 'paired_window_net_change_quantiles',
          troughBandMethod: 'paired_window_minimum_change_quantiles',
          requestWithinProjectedCash: {
            lower: current.cashLimitedExitRaw.lower >= requested,
            point: current.cashLimitedExitRaw.point >= requested,
            upper: current.cashLimitedExitRaw.upper >= requested,
          },
          requestWithinProjectedTroughCash: {
            lower: current.cashLimitedTroughExitRaw.lower >= requested,
            point: current.cashLimitedTroughExitRaw.point >= requested,
            upper: current.cashLimitedTroughExitRaw.upper >= requested,
          },
          historicalWindowSupport: independent.length,
        }
      : null,
    scenarioUnavailableReason: current ? null : 'fewer_than_four_exact_horizon_windows',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  fail(
    args.length === 7 &&
      args[0] === '--verify' &&
      args[1] === '--horizon-blocks' &&
      args[3] === '--claim-raw' &&
      args[5] === '--request-raw',
    'shadow_verify_args_required',
  )
  const result = buildShadowForecast({
    joined: replayFullArchiveJoin(),
    horizonBlocks: Number(args[2]),
    holderClaimRaw: args[4],
    requestedRaw: args[6],
  })
  const compactScore = (value) => (value ? { ...value, records: undefined } : null)
  process.stdout.write(
    `${JSON.stringify({
      ...result,
      split: {
        ...result.split,
        calibration: compactScore(result.split.calibration),
        holdout: compactScore(result.split.holdout),
      },
    })}\n`,
  )
}
