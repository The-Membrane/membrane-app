import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  FLUID_HOLDER_STUDY_INPUTS,
  classifyFluidHistoricalBucket,
  loadFluidUsdtHolderHistoryStudy,
  replayFluidUsdtHolderHistoryStudy,
} from '../../scripts/research/fluid-usdt-holder-history-study.mjs'

let attempts = 0
const savedFetch = globalThis.fetch
globalThis.fetch = async () => {
  attempts++
  throw Error('offline_global_fetch_trap')
}
test.after(() => {
  globalThis.fetch = savedFetch
})
const texts = Object.fromEntries(
  FLUID_HOLDER_STUDY_INPUTS.map((spec) => [spec.key, readFileSync(spec.path, 'utf8')]),
)
const study = loadFluidUsdtHolderHistoryStudy()
const resealText = (value) => {
  const { sha256, ...body } = value
  return (
    JSON.stringify({
      ...body,
      sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    }) + '\n'
  )
}

// Real saved bytes are replayed once. Mutation controls are rejected by external pins before replay.
test('actual saved pair yields four exact buckets and the frozen derived study with zero fetch attempts', () => {
  const artifact = JSON.parse(
    readFileSync(
      'data/research/venue-signals/fluid-usdt-holder-history-study-2026-10-07.json',
      'utf8',
    ),
  )
  assert.deepEqual(study, artifact)
  const { sha256, ...body } = artifact
  assert.equal(createHash('sha256').update(JSON.stringify(body)).digest('hex'), sha256)
  assert.equal(study.points.length, 2)
  assert.equal(study.points.flatMap((point) => point.buckets).length, 4)
  assert.deepEqual(study.replayedPhysicalStarts, { fullPosition: 24, conversion: 94 })
  assert.equal(attempts, 0)
})

test('genuine full-position E covers only the small bucket and never substitutes selected Q or maxWithdraw', () => {
  assert.deepEqual(
    study.points.map((point) => point.nativePosition.fullPositionEntitlementRaw),
    ['1014574', '1014581'],
  )
  for (const point of study.points) {
    assert.equal(point.nativePosition.holderSharesRaw, '967573479322309282')
    assert.equal(point.nativePosition.entitlementBasis, 'preview_redeem_full_position')
    assert.equal(point.nativePosition.assetDecimals, 6)
    assert.equal(point.nativePosition.twoOriginAgreement, true)
    assert.equal(point.buckets[0].fundingEligibility.status, 'full_position_covers_input')
    assert.equal(point.buckets[1].fundingEligibility.status, 'full_position_does_not_cover_input')
    assert.equal(point.buckets[1].fundingEligibility.headroomRaw, null)
  }
  assert.deepEqual(
    study.points.map((point) => point.buckets[1].fundingEligibility.deficitRaw),
    ['9998985426', '9998985419'],
  )
})

test('entitlement coverage expresses funding eligibility without claiming native cash or withdrawal delivery', () => {
  assert.deepEqual(
    study.sampledRange.exactBuckets.map((row) => row.entitlementCoversInputAtBothSources),
    [true, false],
  )
  for (const row of study.sampledRange.exactBuckets) {
    assert.equal(Object.hasOwn(row, 'fundedAtBothSources'), false)
    assert.equal(row.nativeDeliveredAssetsRangeRaw, null)
  }
  for (const bucket of study.points.flatMap((point) => point.buckets)) {
    assert.equal(Object.hasOwn(bucket, 'funding'), false)
    assert.equal(Object.hasOwn(bucket, 'fundingEligibility'), true)
    assert.equal(bucket.fundingEligibility.basis, 'preview_redeem_full_position')
    assert.equal(bucket.nativeWithdrawal.deliveredAssetsRaw, null)
    assert.equal(bucket.nativeWithdrawal.twoOriginRawAgreement, false)
    assert.equal(bucket.composedHolderDelivery, 'unassessed')
  }
})

test('exact quotes remain separate with their real fee tier, not scaled to holder entitlement', () => {
  assert.deepEqual(
    study.points.map((point) => point.buckets[0].conversion.quotedUsdtOutRaw),
    ['10146', '10146'],
  )
  assert.deepEqual(
    study.points.map((point) => point.buckets[1].conversion.quotedUsdtOutRaw),
    ['10002552325', '10002522655'],
  )
  for (const row of study.points.flatMap((point) => point.buckets)) {
    assert.equal(row.conversion.twoOriginAgreement, true)
    assert.equal(row.conversion.poolFeeUnits, 100)
    assert.equal(row.conversion.feeDenominator, 1000000)
    assert.equal(row.conversion.chargedFeeRaw, null)
    assert.equal(row.conversion.outputDecimals, 6)
  }
  assert.deepEqual(
    study.sampledRange.exactBuckets.map((row) => row.conditionalQuotedUsdtOutRaw),
    [
      { minRaw: '10146', maxRaw: '10146' },
      { minRaw: '10002522655', maxRaw: '10002552325' },
    ],
  )
})

test('new acquisition availability cannot become the original October 2 forecast or a current source', () => {
  assert.equal(study.evidenceAvailableAtUtc, '2026-10-07T19:10:55.523Z')
  assert.deepEqual(
    study.points.map((point) => point.source.blockNumber),
    ['26101887', '26102143'],
  )
  assert.equal(study.sampledRange.elapsedSeconds, 3072)
  for (const point of study.points) {
    assert.ok(Date.parse(point.source.blockTime) < Date.parse(point.originalIssueAvailableAtUtc))
    assert.ok(
      Date.parse(point.originalIssueAvailableAtUtc) < Date.parse(point.conversionAvailableAtUtc),
    )
    assert.ok(
      Date.parse(point.conversionAvailableAtUtc) < Date.parse(point.fullPositionAvailableAtUtc),
    )
  }
  assert.equal(study.historicalOnly, true)
  assert.equal(study.originalIssuedForecast, false)
  assert.equal(study.liveHolderForecast, false)
  assert.equal(study.futureProjection, false)
  assert.equal(study.excludedCurrentConversionPoint, true)
})

test('a successful summarized native simulation never qualifies delivery or shrinks gap 4', () => {
  for (const point of study.points) {
    assert.equal(point.buckets[0].nativeWithdrawal.reportedSimulationStatus, 'success')
    assert.equal(
      point.buckets[0].nativeWithdrawal.status,
      'unqualified_historical_simulation_summary',
    )
    assert.deepEqual(point.buckets[0].nativeWithdrawal.missingProof, [
      'two_origin_raw_withdrawal_trace',
      'recipient_balance_delta_or_mined_transfer',
    ])
    for (const row of point.buckets) {
      assert.equal(row.nativeWithdrawal.twoOriginRawAgreement, false)
      assert.equal(row.nativeWithdrawal.deliveredAssetsRaw, null)
      assert.equal(row.composedHolderDelivery, 'unassessed')
      assert.equal(row.finalSwapExecution, 'unassessed')
      assert.equal(row.minedUsdtPayment, 'unassessed')
      assert.equal(row.bucketDeliveryDurationSeconds, null)
    }
  }
  assert.equal(study.openGapCount, 4)
  assert.equal(study.gapCountChange, 0)
  assert.equal(study.sourceImplementationEquivalence, false)
  assert.equal(study.minedPayout, false)
})

test('externally pinned original issue summaries cannot be resigned into native proof or different Q', () => {
  const issue = JSON.parse(texts.issue0001)
  issue.baseline.cases.find((row) => row.qRaw === '10145').measurement.request.assetsRaw = '1014574'
  assert.throws(
    () => replayFluidUsdtHolderHistoryStudy({ ...texts, issue0001: resealText(issue) }),
    /issue0001_file_pin/,
  )
})

test('full-E source, owner, native units, body or origin mutations reject even with a new candidate seal', () => {
  for (const mutate of [
    (value) => {
      value.availableAtUtc = '2026-10-02T03:32:46.286Z'
    },
    (value) => {
      value.plan.subject.owner = '0x' + '0'.repeat(40)
    },
    (value) => {
      value.plan.subject.assetDecimals = 18
    },
    (value) => {
      value.origins[0].host = value.origins[1].host
    },
    (value) => {
      value.plan.anchors[0].source.blockHash = value.plan.anchors[1].source.blockHash
    },
  ]) {
    const value = JSON.parse(texts.fullPosition)
    mutate(value)
    assert.throws(
      () => replayFluidUsdtHolderHistoryStudy({ ...texts, fullPosition: resealText(value) }),
      /fullPosition_file_pin/,
    )
  }
})

test('conversion size, source, fee and quote mutations cannot self-seal new or scaled evidence', () => {
  for (const mutate of [
    (value) => {
      value.plan.protocolUsdcInputRaw = '1014574'
    },
    (value) => {
      value.plan.fee = 500
    },
    (value) => {
      value.plan.anchors[0].source.blockNumber = '26102143'
    },
    (value) => {
      value.traces.find((trace) => trace.key === 'usdtQuotedRaw').response.result =
        '0x' + '0'.repeat(256)
    },
  ]) {
    const value = JSON.parse(texts.conversion)
    mutate(value)
    assert.throws(
      () => replayFluidUsdtHolderHistoryStudy({ ...texts, conversion: resealText(value) }),
      /conversion_file_pin/,
    )
  }
})

test('funding boundary uses exact unsigned native units and cannot alias the large independent quote', () => {
  assert.equal(classifyFluidHistoricalBucket('10145', '10145').status, 'full_position_covers_input')
  assert.equal(classifyFluidHistoricalBucket('10144', '10145').deficitRaw, '1')
  for (const pair of [
    ['1', '0'],
    ['-1', '1'],
    ['1.014574', '10145'],
    ['001014574', '10145'],
    ['1', 10145],
  ]) {
    assert.throws(() => classifyFluidHistoricalBucket(...pair), /funding_units/)
  }
  assert.throws(() => classifyFluidHistoricalBucket((1n << 256n).toString(), '1'), /funding_units/)
})

test('result is immutable, bounded and contains no RPC endpoint, forecast issue or execution promotion', () => {
  assert.throws(() => {
    study.points[0].nativePosition.fullPositionEntitlementRaw = '10000000000'
  }, TypeError)
  assert.ok(Buffer.byteLength(JSON.stringify(study)) + 1 <= 65536)
  assert.doesNotMatch(JSON.stringify(study), /https?:\/\//)
  assert.equal(study.originalUsdtRequestedRaw, null)
  assert.throws(
    () => replayFluidUsdtHolderHistoryStudy({ ...texts, forgedApproval: true }),
    /input_keys/,
  )
  assert.equal(attempts, 0)
})
