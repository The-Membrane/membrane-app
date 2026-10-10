import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  buildHistoricalFlowSummary,
  buildHistoricalGrossFlowStress,
  buildShadowForecast,
  replayFullArchiveJoin,
  stitchVerifiedJoinChunks,
  STITCH_STUDY,
} from './aave-usdc-flow-shadow-forecast.mjs'
import {
  STUDY as JOIN_STUDY,
  CONTINUATION_STUDY as JOIN_CONTINUATION_STUDY,
} from './aave-usdc-cash-direct-flow-join.mjs'

function joined(flows, lengths = flows.map(() => 1), opening = 1000n) {
  let block = 100
  let cash = opening
  const slices = flows.map(({ incoming, outgoing }, index) => {
    const start = block
    block += lengths[index]
    const next = cash + BigInt(incoming) - BigInt(outgoing)
    const minimum = cash < next ? cash : next
    const row = {
      fromExclusive: start,
      toInclusive: block,
      fromHash: `0x${start.toString(16).padStart(64, '0')}`,
      toHash: `0x${block.toString(16).padStart(64, '0')}`,
      cashBeforeRaw: cash.toString(),
      cashAfterRaw: next.toString(),
      grossReserveInRaw: String(incoming),
      grossReserveOutRaw: String(outgoing),
      grossSupplierSupplyRaw: String(incoming),
      grossSupplierWithdrawalRaw: String(outgoing),
      otherReserveInRaw: '0',
      otherReserveOutRaw: '0',
      minEndOfBlockCashRaw: minimum.toString(),
      minEndOfBlockCashAtBlock: minimum === cash ? start : block,
      sources: { fixture: index },
    }
    cash = next
    return row
  })
  return { study: JOIN_STUDY, forecast: false, fromBlock: 100, toBlock: block, slices }
}

const run = (source, extra = {}) =>
  buildShadowForecast({
    joined: source,
    horizonBlocks: 1,
    holderClaimRaw: '100',
    requestedRaw: '50',
    ...extra,
  })

test('historical gross-flow replay keeps endpoint and within-window trough paired at selected Q', () => {
  const source = joined([
    { incoming: 0, outgoing: 900 },
    { incoming: 900, outgoing: 0 },
    { incoming: 0, outgoing: 200 },
    { incoming: 200, outgoing: 0 },
  ])
  source.slices[0].grossSupplierWithdrawalRaw = '100'
  source.slices[0].otherReserveOutRaw = '800'
  const result = buildHistoricalGrossFlowStress({
    joined: source,
    horizonBlocks: 2,
    currentCashRaw: '1000',
    requestedRaw: '500',
  })
  assert.equal(result.exactHorizonWindows, 3)
  assert.equal(result.nonoverlappingWindowCount, 2)
  assert.equal(result.distributionScope, 'nonoverlapping_exact_windows')
  assert.equal(result.sourceVerification, 'join_shape_only')
  assert.deepEqual(
    result.samples.map((sample) => sample.originBlock),
    [100, 102],
  )
  assert.deepEqual(
    result.samples.map((sample) => sample.endpointMarginToRequestedRaw),
    ['500', '500'],
  )
  assert.deepEqual(
    result.samples.map((sample) => sample.troughMarginToRequestedRaw),
    ['-400', '300'],
  )
  assert.deepEqual(
    result.samples.map((sample) => sample.grossReserveOutRaw),
    ['900', '200'],
  )
  assert.equal(result.grossReserveOutRaw.maximum, '900')
  assert.equal(result.troughMarginToRequestedRaw.minimum, '-400')
  assert.equal(result.validation, 'not_validated')
  assert.equal(result.holderExecutableExit, false)
  assert.equal(result.withinHorizonDuration, null)
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('exact extrema include an omitted overlapping worst window and clamp infeasible cash', () => {
  const source = joined([
    { incoming: 1000, outgoing: 0 },
    { incoming: 0, outgoing: 900 },
    { incoming: 0, outgoing: 900 },
    { incoming: 1000, outgoing: 0 },
  ])
  const result = buildHistoricalGrossFlowStress({
    joined: source,
    horizonBlocks: 2,
    currentCashRaw: '1000',
    requestedRaw: '500',
  })
  assert.deepEqual(
    result.samples.map((sample) => sample.originBlock),
    [100, 102],
  )
  assert.equal(result.grossReserveOutRaw.maximum, '900')
  assert.equal(result.exactWindowExtrema.maxGrossReserveOutRaw, '1800')
  assert.equal(result.exactWindowExtrema.minTroughMarginToRequestedRaw, '-500')
  assert.equal(result.exactWindowExtrema.maxTroughReplayDeficitRaw, '800')
  assert.equal(result.samples[1].troughMarginToRequestedRaw, '-400')
  assert.equal(result.samples[1].infeasibleReplay, false)
  const lowCash = buildHistoricalGrossFlowStress({
    joined: source,
    horizonBlocks: 2,
    currentCashRaw: '100',
    requestedRaw: '500',
  })
  assert.equal(lowCash.samples[1].infeasibleReplay, true)
  assert.equal(lowCash.samples[1].troughReplayDeficitRaw, '800')
  assert.equal(lowCash.samples[1].troughMarginToRequestedRaw, '-500')
  assert.equal(result.validation, 'not_validated')
  assert.equal(result.holderExecutableExit, false)
})

test('historical gross-flow replay rejects conflicting reserve identity and invalid Q', () => {
  const source = joined([{ incoming: 0, outgoing: 10 }])
  source.slices[0].otherReserveOutRaw = '1'
  assert.throws(
    () =>
      buildHistoricalGrossFlowStress({ joined: source, currentCashRaw: '100', requestedRaw: '1' }),
    /shadow_cash_identity/,
  )
  const valid = joined([{ incoming: 0, outgoing: 10 }])
  assert.throws(
    () =>
      buildHistoricalGrossFlowStress({ joined: valid, currentCashRaw: '100', requestedRaw: '0' }),
    /shadow_invalid_request/,
  )
})

test('compact summary keeps paired deltas and all exact-window extrema', () => {
  const source = joined([
    { incoming: 1000, outgoing: 0 },
    { incoming: 0, outgoing: 900 },
    { incoming: 0, outgoing: 900 },
    { incoming: 1000, outgoing: 0 },
  ])
  const summary = buildHistoricalFlowSummary({ joined: source, horizonBlocks: 2 })
  assert.equal(summary.sourceVerification, 'join_shape_only')
  assert.equal(summary.exactHorizonWindows, 3)
  assert.equal(summary.nonoverlappingWindowCount, 2)
  assert.equal(summary.schema, 'carry_historical_paired_flow_summary_v1')
  assert.equal(summary.pairedWindows.length, 2)
  assert.deepEqual(summary.pairedWindows[0], {
    originBlock: 100,
    targetBlock: 102,
    sourceCashRaw: '1000',
    targetCashRaw: '1100',
    grossReserveInRaw: '1000',
    grossReserveOutRaw: '900',
    endpointCashDeltaRaw: '100',
    troughCashRaw: '1000',
    troughCashDeltaRaw: '0',
    troughBlock: 100,
  })
  assert.equal(
    summary.pairedWindowsSha256,
    createHash('sha256').update(JSON.stringify(summary.pairedWindows)).digest('hex'),
  )
  assert.equal(summary.nonoverlappingDistributions.grossReserveOutRaw.maximum, '900')
  assert.equal(summary.exactWindowExtrema.maxGrossReserveOutRaw, '1800')
  assert.equal(summary.exactWindowExtrema.minTroughCashDeltaRaw, '-1800')
  assert.equal(summary.nonoverlappingDistributions.troughCashDeltaRaw.minimum, '-900')
  assert.doesNotThrow(() => JSON.stringify(summary))
})

test('holdout forecast at origin cannot see that origin’s future cash flow', () => {
  const flows = Array.from({ length: 9 }, (_, index) => ({
    incoming: index % 2 ? 5 : 0,
    outgoing: 10,
  }))
  const before = run(joined(flows))
  const changed = [...flows]
  changed[6] = { incoming: 500, outgoing: 10 }
  const after = run(joined(changed))
  assert.equal(before.split.fit, 3)
  assert.equal(before.split.holdout.records[0].originBlock, 106)
  assert.equal(before.split.fitLastTargetBlock, before.split.calibrationFirstOriginBlock)
  assert.equal(
    before.split.holdout.records[0].predictedCashRaw,
    after.split.holdout.records[0].predictedCashRaw,
  )
  assert.notEqual(
    before.split.holdout.records[0].observedCashRaw,
    after.split.holdout.records[0].observedCashRaw,
  )
  const drop = [...flows]
  drop[6] = { incoming: 0, outgoing: 500 }
  const changedTrough = run(joined(drop))
  assert.equal(
    before.split.holdout.records[0].predictedTroughCashRaw,
    changedTrough.split.holdout.records[0].predictedTroughCashRaw,
  )
  assert.notEqual(
    before.split.holdout.records[0].observedTroughCashRaw,
    changedTrough.split.holdout.records[0].observedTroughCashRaw,
  )
})

test('few windows retain a shadow scenario but refuse validation', () => {
  const result = run(joined(Array.from({ length: 6 }, () => ({ incoming: 20, outgoing: 10 }))))
  assert.equal(result.completedExactHorizonWindows, 6)
  assert.equal(result.validation, 'not_validated')
  assert.equal(result.historicalGatePassed, false)
  assert.equal(result.historicalGate.reason, 'insufficient_nonoverlapping_windows')
  assert.equal(result.holderExecutableExit, false)
  assert.equal(result.scenario.cashLimitedExitRaw.point, '100')
})

test('accepts the verified continuation join and preserves its source version', () => {
  const source = joined(Array.from({ length: 6 }, () => ({ incoming: 20, outgoing: 10 })))
  source.study = JOIN_CONTINUATION_STUDY
  const result = run(source)
  assert.equal(result.source.joinedStudy, JOIN_CONTINUATION_STUDY)
  assert.equal(result.completedExactHorizonWindows, 6)
})

test('full archive replays overlapping verified windows exactly once', () => {
  const whole = joined(Array.from({ length: 153 }, () => ({ incoming: 20, outgoing: 10 })))
  const endpoints = whole.slices.map((slice) => slice.toInclusive)
  const at = (endpoint) => {
    const index = endpoints.indexOf(endpoint)
    const slices = whole.slices.slice(Math.max(0, index - 126), index + 1)
    return {
      ...whole,
      fromBlock: slices[0].fromExclusive,
      toBlock: endpoint,
      slices,
      study: JOIN_CONTINUATION_STUDY,
    }
  }
  const stitched = replayFullArchiveJoin({ pinEndpoints: () => endpoints, at })
  assert.equal(stitched.study, STITCH_STUDY)
  assert.equal(stitched.slices.length, 153)
  assert.equal(stitched.verifiedChunkDigests.length, 2)
  assert.equal(stitched.fromBlock, whole.fromBlock)
  assert.equal(stitched.toBlock, whole.toBlock)
  assert.equal(run(stitched).independentWindows, 153)
})

test('stitch rejects a changed overlap or a missing boundary', () => {
  const whole = joined(Array.from({ length: 6 }, () => ({ incoming: 20, outgoing: 10 })))
  const first = { ...whole, toBlock: 104, slices: whole.slices.slice(0, 4) }
  const second = { ...whole, fromBlock: 103, slices: whole.slices.slice(3) }
  const changed = structuredClone(second)
  changed.slices[0].sources = { changed: true }
  assert.throws(() => stitchVerifiedJoinChunks([first, changed]), /shadow_chunk_overlap_mismatch/)
  const gap = { ...whole, fromBlock: 105, slices: whole.slices.slice(5) }
  assert.throws(() => stitchVerifiedJoinChunks([first, gap]), /shadow_chunk_gap_or_no_extension/)
})

test('competing outflow and replenishment stay separate before cash and claim caps', () => {
  const result = run(joined(Array.from({ length: 5 }, () => ({ incoming: 40, outgoing: 70 }))))
  assert.deepEqual(result.scenario.grossReserveInRaw, { lower: '40', point: '40', upper: '40' })
  assert.deepEqual(result.scenario.grossReserveOutRaw, { lower: '70', point: '70', upper: '70' })
  assert.equal(result.scenario.maxObservedReserveOutRaw, '70')
  assert.equal(result.scenario.cashLimitedExitRaw.point, '100')
  assert.equal(result.scenario.requestWithinProjectedCash.point, true)
  assert.deepEqual(result.split.calibration.grossFlow, { inCovered: 1, outCovered: 1 })
  assert.deepEqual(result.split.holdout.grossFlow, { inCovered: 3, outCovered: 3 })
})

test('gross outflow coverage is scored separately even when endpoint cash is unchanged', () => {
  const flows = [
    ...Array.from({ length: 3 }, () => ({ incoming: 10, outgoing: 10 })),
    ...Array.from({ length: 6 }, () => ({ incoming: 100, outgoing: 100 })),
  ]
  const result = run(joined(flows))
  assert.equal(result.split.calibration.covered, 3)
  assert.equal(result.split.holdout.covered, 3)
  assert.deepEqual(result.split.calibration.grossFlow, { inCovered: 0, outCovered: 0 })
  assert.deepEqual(result.split.holdout.grossFlow, { inCovered: 0, outCovered: 0 })
  assert.equal(result.split.holdout.records[0].observedGrossReserveOutRaw, '100')
  assert.equal(result.split.holdout.records[0].grossReserveOutWithinBand, false)
})

test('a horizon requires an exact sealed endpoint and never interpolates', () => {
  const source = joined(
    Array.from({ length: 5 }, () => ({ incoming: 1, outgoing: 1 })),
    [2, 2, 2, 2, 2],
  )
  const absent = run(source, { horizonBlocks: 3 })
  assert.equal(absent.completedExactHorizonWindows, 0)
  assert.equal(absent.scenario, null)
  assert.equal(absent.scenarioUnavailableReason, 'fewer_than_four_exact_horizon_windows')
  const exact = run(source, { horizonBlocks: 4 })
  assert.equal(exact.completedExactHorizonWindows, 4)
  assert.equal(exact.targetBlock, 114)
})

test('projected cash and cash-limited exit clamp at zero', () => {
  const source = joined([100, 100, 100, 100, 600].map((outgoing) => ({ incoming: 0, outgoing })))
  const result = run(source)
  assert.equal(result.scenario.cashRaw.lower, '0')
  assert.equal(result.scenario.cashRaw.point, '0')
  assert.equal(result.scenario.cashLimitedExitRaw.point, '0')
  assert.equal(result.scenario.requestWithinProjectedCash.point, false)
})

test('a drawdown survives replenishment even when endpoint cash fully recovers', () => {
  const flows = Array.from({ length: 10 }, (_, index) =>
    index % 2 === 0 ? { incoming: 0, outgoing: 900 } : { incoming: 900, outgoing: 0 },
  )
  const result = run(joined(flows), {
    horizonBlocks: 2,
    holderClaimRaw: '1000',
    requestedRaw: '500',
  })
  assert.equal(result.scenario.cashRaw.point, '1000')
  assert.equal(result.scenario.troughCashRaw.point, '100')
  assert.equal(result.scenario.drawdownRaw.point, '900')
  assert.equal(result.scenario.requestWithinProjectedCash.point, true)
  assert.equal(result.scenario.requestWithinProjectedTroughCash.point, false)
  assert.equal(result.split.holdout.records[0].observedCashRaw, '1000')
  assert.equal(result.split.holdout.records[0].observedTroughCashRaw, '100')
  assert.equal(result.split.holdout.records[0].observedTroughAtBlock, 105)
  assert.equal(result.withinHorizonDurationEstimated, false)
})

test('paired net and trough changes cannot project a trough above the endpoint', () => {
  const flows = [
    { incoming: 800, outgoing: 900 },
    { incoming: 0, outgoing: 100 },
    { incoming: 800, outgoing: 900 },
    { incoming: 0, outgoing: 100 },
  ]
  const result = run(joined(flows), { holderClaimRaw: '1000', requestedRaw: '500' })
  // Combining p10 inflow 0 with p90 outflow 900 would invent a -900 net change;
  // every actual paired window fell by only 100.
  assert.equal(result.scenario.grossReserveInRaw.lower, '0')
  assert.equal(result.scenario.grossReserveOutRaw.upper, '900')
  assert.equal(result.scenario.cashRaw.lower, '500')
  assert.equal(result.scenario.cashRaw.point, '500')
  assert.equal(result.scenario.troughCashRaw.lower, '500')
  assert.equal(result.scenario.troughCashRaw.point, '500')
  for (const bound of ['lower', 'point', 'upper']) {
    assert.ok(
      BigInt(result.scenario.troughCashRaw[bound]) <= BigInt(result.scenario.cashRaw[bound]),
    )
  }
})

test('missing or impossible within-slice trough fails closed', () => {
  const source = joined([{ incoming: 1, outgoing: 0 }])
  delete source.slices[0].minEndOfBlockCashRaw
  assert.throws(() => run(source), /shadow_invalid_raw_amount/)
  const above = joined([{ incoming: 1, outgoing: 0 }])
  above.slices[0].minEndOfBlockCashRaw = '1001'
  assert.throws(() => run(above), /shadow_invalid_block_trough/)
  const badBlock = joined([{ incoming: 1, outgoing: 0 }])
  badBlock.slices[0].minEndOfBlockCashAtBlock = 102
  assert.throws(() => run(badBlock), /shadow_invalid_block_trough/)
})

test('rejects a broken cash identity or a request above the chosen claim', () => {
  const source = joined([{ incoming: 1, outgoing: 0 }])
  source.slices[0].cashAfterRaw = '1002'
  assert.throws(() => run(source), /shadow_cash_identity/)
  assert.throws(
    () => run(joined([{ incoming: 1, outgoing: 0 }]), { requestedRaw: '101' }),
    /shadow_request_exceeds_claim/,
  )
})

test('source digest binds cash values, and current fit counts only independent windows', () => {
  const flows = Array.from({ length: 12 }, () => ({ incoming: 10, outgoing: 5 }))
  const first = run(joined(flows), { horizonBlocks: 2 })
  const changed = [...flows]
  changed[0] = { incoming: 11, outgoing: 5 }
  const second = run(joined(changed), { horizonBlocks: 2 })
  assert.notEqual(first.source.joinContentSha256, second.source.joinContentSha256)
  assert.equal(first.scenario.historicalWindowSupport, first.independentWindows)
  assert.ok(first.completedExactHorizonWindows > first.independentWindows)
})
