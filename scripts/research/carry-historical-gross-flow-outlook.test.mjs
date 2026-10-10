import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import {
  buildHistoricalGrossFlowReport,
  directFlowDirection as directFlowDirectionFromDocuments,
  directFlowDirectionFromVerified as directFlowDirection,
  morphoRecordedRangeFromVerified,
  readOfflineHistoricalGrossFlow,
  secondaryRouteFlowFromVerified,
} from './carry-historical-gross-flow-outlook.mjs'
import grossFlowApi from '../../pages/api/carry/historical-gross-flow.ts'
import frozenPinsModule from '../../lib/carry/frozenGrossFlowPins.ts'

const { parseGrossFlowQuery, selectGrossFlowSubject, validatedGrossFlowResponse } = grossFlowApi
const frozenPins = frozenPinsModule.default

const DAY = 86_400_000
const SHA = 'a'.repeat(64)
const TX = `0x${'1'.repeat(64)}`
const docs = [{ sha256: SHA }]
const digest = (value) => createHash('sha256').update(value).digest('hex')

function resign(manifest) {
  manifest.subjects.sort(
    (a, b) => a.route_key.localeCompare(b.route_key) || a.destination.localeCompare(b.destination),
  )
  manifest.payload = JSON.stringify(manifest.subjects)
  manifest.sha256 = digest(manifest.payload)
  return manifest
}

function coverage(marketKey, days, ambiguous = false) {
  return {
    marketKey,
    startMs: 0,
    endMs: days * DAY,
    intervals: [
      {
        startMs: 0,
        endMs: days * DAY,
        finalized: true,
        receiptsComplete: !ambiguous,
        ambiguousReceipts: ambiguous ? 1 : 0,
      },
    ],
  }
}

function morphoFixture(subject) {
  const enrollment = {
    sha256: frozenPins.morpho.enrollmentSha256,
    block: '100',
    observedAt: '2026-01-01T00:00:00.000Z',
  }
  const records = [
    {
      study: 'carry-morpho-v2-exact-vault-gross-flow-v1',
      kind: 'range',
      sequence: 1,
      previousSha256: enrollment.sha256,
      enrollmentSha256: enrollment.sha256,
      vault: subject.destination,
      asset: subject.asset,
      fromBlock: '101',
      toBlock: '110',
      toObservedAt: '2026-01-02T12:00:00.000Z',
      providerCompleteness: 'not_independently_proven',
      holderPayout: 'not_measured',
      sha256: 'b'.repeat(64),
      events: [
        { event_kind: 'deposit', flow_class: 'deposit_observed', assets_raw: '100' },
        {
          event_kind: 'withdraw',
          flow_class: 'external_receiver_unreconciled',
          assets_raw: '40',
        },
        {
          event_kind: 'withdraw',
          flow_class: 'internal_force_deallocate',
          assets_raw: '30',
        },
      ],
    },
  ]
  return {
    subject: {
      vault: subject.destination,
      asset: subject.asset,
      routeKeys: [subject.route_key],
    },
    enrollment,
    records,
  }
}

function secondaryRouteFixture(pin) {
  const records = []
  const daySeconds = DAY / 1_000
  for (let index = 0; index < 4; index++) {
    const sha256 = index === 0 ? pin.genesisSha256 : String(index + 1).repeat(64)
    const leg = pin.legs[0]
    records.push({
      study: 'venue-route-flow-v3',
      venue: pin.venue,
      sequence: index + 1,
      previousSha256: records.at(-1)?.sha256 ?? null,
      sha256,
      fromBlock: String(1 + index * 10),
      toBlock: String(10 + index * 10),
      anchor: { timestamp: index * daySeconds },
      end: { timestamp: (index + 1) * daySeconds },
      before: [
        {
          address: leg.market,
          outputToken: leg.outputAsset,
          outputDecimals: leg.outputDecimals,
        },
      ],
      after: [
        {
          address: leg.market,
          outputToken: leg.outputAsset,
          outputDecimals: leg.outputDecimals,
        },
      ],
      events: [
        {
          marketIndex: 0,
          market: leg.market,
          outputToken: leg.outputAsset,
          outputDecimals: leg.outputDecimals,
          scope: leg.scope,
          direction: leg.exitDirection,
          outputRaw: String(index + 1),
          blockTime: index === 3 ? (index + 1) * daySeconds : index * daySeconds + 3_600,
          block: String(index + 1),
        },
        {
          marketIndex: 0,
          market: leg.market,
          outputToken: leg.outputAsset,
          outputDecimals: leg.outputDecimals,
          scope: leg.scope,
          direction: leg.entryDirection,
          outputRaw: String(4 - index),
          blockTime: index * daySeconds + 7_200,
          block: String(index + 1),
        },
      ],
    })
  }
  return { venue: { name: pin.venue }, records }
}

test('all 25 frozen groups and 67 subjects appear even with no gross-flow source', async () => {
  const manifest = await buildSubjectManifest()
  const report = buildHistoricalGrossFlowReport({ manifest, horizonHours: 24 })
  assert.equal(report.coverage.routeGroups, 25)
  assert.equal(report.coverage.exactSubjects, 67)
  assert.equal(report.subjects.length, 67)
  assert.ok(
    report.subjects.every(
      (row) =>
        row.inflow.state === 'unavailable' &&
        row.outflow.state === 'unavailable' &&
        row.observedMaximumWithinRecordedCoverage === undefined,
    ),
  )
  assert.ok(
    report.subjects.every(
      (row) => row.holderExecutableCapacity === false && row.forecastValidated === false,
    ),
  )
  assert.equal(report.schema, 'carry-historical-gross-flow-outlook-v3')
  assert.equal(report.limits.expectedFlowAvailable, false)
  assert.equal(report.coverage.morphoRecordedRangeSubjects, 0)
  assert.equal(report.coverage.secondaryRouteFlowSubjects, 0)
})

test('Morpho receipts add exact recorded-range totals without inventing horizon statistics', async () => {
  const manifest = await buildSubjectManifest()
  const subject = manifest.subjects.find((row) => row.route_key === 'USDC → VaultV2 [USDC]')
  const fixture = morphoFixture(subject)
  const context = morphoRecordedRangeFromVerified({
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    enrollment: fixture.enrollment,
    records: fixture.records,
    horizonHours: 24,
  })
  assert.equal(context.grossDeposit.recordedTotalWithinCoverage.amountRaw, '100')
  assert.equal(context.grossExternalReceiverWithdraw.recordedTotalWithinCoverage.amountRaw, '40')
  assert.equal(context.excludedInternalWithdrawals.amountRaw, '30')
  assert.equal(context.grossDeposit.observedMaximumWithinRecordedCoverage, null)
  assert.equal(
    context.grossDeposit.historicalFlowDistribution.reason,
    'per_event_timestamps_not_recorded',
  )
  assert.equal(context.holderPayoutMeasured, false)
  const report = buildHistoricalGrossFlowReport({
    manifest,
    morpho: { entries: [fixture] },
    horizonHours: 24,
  })
  assert.equal(report.coverage.morphoRecordedRangeSubjects, 1)
  const query = {
    routeKey: subject.route_key,
    destination: subject.destination,
    horizonHours: 24,
  }
  assert.equal(
    selectGrossFlowSubject(report, query).morphoRecordedRange.state,
    'single_provider_recorded_range',
  )
  const changed = structuredClone(report)
  changed.subjects.find(
    (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
  ).morphoRecordedRange.grossDeposit.recordedTotalWithinCoverage.amountRaw = '101'
  assert.throws(() => selectGrossFlowSubject(changed, query), /gross_flow_subject_invalid/)
  assert.throws(
    () =>
      morphoRecordedRangeFromVerified({
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: subject.asset,
        enrollment: { ...fixture.enrollment, sha256: SHA },
        records: fixture.records,
        horizonHours: 24,
      }),
    /gross_flow_morpho_source_invalid/,
  )
})

test('secondary route flow stays in output-token units and single-provider history', async () => {
  const manifest = await buildSubjectManifest()
  const pin = frozenPins.secondaryRouteFlows.sUSDe
  const fixture = secondaryRouteFixture(pin)
  const context = secondaryRouteFlowFromVerified({ pin, ...fixture, horizonHours: 24 })
  assert.equal(context.subjectUnderlyingGrossFlowMeasured, false)
  assert.equal(context.holderAttributionAvailable, false)
  assert.equal(context.legs[0].outputAsset, pin.legs[0].outputAsset)
  assert.equal(context.legs[0].outputSymbol, 'DOLA')
  assert.equal(frozenPins.secondaryRouteFlows.sUSDS.legs[0].outputSymbol, 'USDC')
  assert.deepEqual(context.legs[0].grossExit.recordedTotalWithinCoverage, {
    amountRaw: '10',
    eventCount: 4,
  })
  assert.equal(context.legs[0].grossExit.observedMaximumWithinRecordedCoverage.amountRaw, '4')
  assert.equal(context.legs[0].grossExit.observedMaximumWithinRecordedCoverage.endMs, 4 * DAY)
  assert.equal(
    context.legs[0].grossExit.historicalFlowDistribution.status,
    'historical_descriptive_single_provider',
  )
  const long = secondaryRouteFlowFromVerified({ pin, ...fixture, horizonHours: 168 })
  assert.equal(long.legs[0].grossExit.observedMaximumWithinRecordedCoverage, null)
  assert.equal(
    long.legs[0].grossExit.historicalFlowDistribution.reason,
    'coverage_shorter_than_horizon',
  )
  const report = buildHistoricalGrossFlowReport({
    manifest,
    secondaryRouteFlows: { entries: [fixture] },
    horizonHours: 24,
  })
  assert.equal(report.coverage.secondaryRouteFlowSubjects, 1)
  assert.equal(report.coverage.corroboratedGrossInflowSubjects, 0)
  assert.equal(report.coverage.corroboratedGrossOutflowSubjects, 0)
  const query = { routeKey: pin.routeKey, destination: pin.destination, horizonHours: 24 }
  assert.equal(selectGrossFlowSubject(report, query).secondaryRouteFlow.venue, 'sUSDe')
  const changed = structuredClone(report)
  changed.subjects.find(
    (row) => row.routeKey === pin.routeKey,
  ).secondaryRouteFlow.legs[0].grossExit.recordedTotalWithinCoverage.amountRaw = '11'
  assert.throws(() => selectGrossFlowSubject(changed, query), /gross_flow_subject_invalid/)
  const changedSymbol = structuredClone(report)
  changedSymbol.subjects.find(
    (row) => row.routeKey === pin.routeKey,
  ).secondaryRouteFlow.legs[0].outputSymbol = 'USDC'
  assert.throws(() => selectGrossFlowSubject(changedSymbol, query), /gross_flow_subject_invalid/)
  assert.throws(
    () =>
      secondaryRouteFlowFromVerified({
        pin,
        venue: fixture.venue,
        records: [{ ...fixture.records[0], sha256: SHA }, ...fixture.records.slice(1)],
        horizonHours: 24,
      }),
    /gross_flow_secondary_route_source_invalid/,
  )
  for (const marketIndex of [-1, pin.legs.length]) {
    const unknownLeg = structuredClone(fixture)
    unknownLeg.records[0].events[0].marketIndex = marketIndex
    assert.throws(
      () => secondaryRouteFlowFromVerified({ pin, ...unknownLeg, horizonHours: 24 }),
      /gross_flow_secondary_route_event_index_invalid/,
    )
  }
})

test('exact API selection rejects unknown routes and prevents cross-destination bleed', async () => {
  const manifest = await buildSubjectManifest()
  const report = buildHistoricalGrossFlowReport({ manifest, horizonHours: 24 })
  const two = report.subjects.filter((row) => row.routeKey === 'USDC → VaultV2 [USDC]')
  assert.ok(two.length > 1)
  const first = selectGrossFlowSubject(report, {
    routeKey: two[0].routeKey,
    destination: two[0].destination,
    horizonHours: 24,
  })
  const second = selectGrossFlowSubject(report, {
    routeKey: two[1].routeKey,
    destination: two[1].destination,
    horizonHours: 24,
  })
  assert.equal(first.destination, two[0].destination)
  assert.equal(second.destination, two[1].destination)
  assert.notEqual(first.destination, second.destination)
  const response = validatedGrossFlowResponse(report, {
    routeKey: two[0].routeKey,
    destination: two[0].destination,
    horizonHours: 24,
  })
  assert.equal(response.identitySetSha256, frozenPins.identitySetSha256)
  const forged = structuredClone(report)
  forged.identitySetSha256 = SHA
  assert.throws(
    () =>
      validatedGrossFlowResponse(forged, {
        routeKey: two[0].routeKey,
        destination: two[0].destination,
        horizonHours: 24,
      }),
    /gross_flow_report_invalid/,
  )
  assert.equal(
    selectGrossFlowSubject(report, {
      routeKey: 'unknown venue',
      destination: two[0].destination,
      horizonHours: 24,
    }),
    null,
  )
  assert.equal(
    selectGrossFlowSubject(report, {
      routeKey: two[0].routeKey,
      destination: '0x' + 'f'.repeat(40),
      horizonHours: 24,
    }),
    null,
  )
  assert.equal(
    parseGrossFlowQuery({
      routeKey: two[0].routeKey,
      destination: two[0].destination,
      horizonHours: '2',
    }),
    null,
  )
})

test('incomplete window has no observed maximum or historical distribution', () => {
  const subject = directFlowDirection({
    marketKey: 'aaveV3Usdc',
    flowKind: 'supply',
    documents: docs,
    verified: { coverage: coverage('aaveV3Usdc', 0.5), supplies: [] },
    horizonHours: 24,
  })
  assert.equal(subject.state, 'partial_corroborated_range')
  assert.equal(subject.observedMaximumWithinRecordedCoverage, null)
  assert.equal(subject.historicalFlowDistribution.status, 'unavailable')
  const incomplete = directFlowDirection({
    marketKey: 'aaveV3Usdc',
    flowKind: 'supply',
    documents: docs,
    verified: { coverage: coverage('aaveV3Usdc', 2, true), supplies: [] },
    horizonHours: 24,
  })
  assert.equal(incomplete.state, 'partial_corroborated_range')
  assert.equal(incomplete.reason, 'coverage_not_complete')
  assert.equal(incomplete.observedMaximumWithinRecordedCoverage, null)
})

test('three corroborated disjoint intervals permit a descriptive distribution; one does not', () => {
  const one = directFlowDirection({
    marketKey: 'aaveV3Usdc',
    flowKind: 'supply',
    documents: docs,
    verified: { coverage: coverage('aaveV3Usdc', 1), supplies: [] },
    horizonHours: 24,
  })
  assert.equal(one.state, 'two_provider_corroborated_sample')
  assert.equal(one.observedMaximumWithinRecordedCoverage.amountRaw, '0')
  assert.equal(one.zeroMeaning, 'zero_matching_events_returned_within_recorded_coverage')
  assert.equal(
    one.source.completenessBasis,
    'two_public_rpc_origins_agree_not_absolute_completeness',
  )
  assert.equal(one.historicalFlowDistribution.status, 'unavailable')
  const three = directFlowDirection({
    marketKey: 'aaveV3Usdc',
    flowKind: 'supply',
    documents: docs,
    verified: { coverage: coverage('aaveV3Usdc', 3), supplies: [] },
    horizonHours: 24,
  })
  assert.equal(three.historicalFlowDistribution.status, 'historical_descriptive')
  assert.equal(three.historicalFlowDistribution.intervalCount, 3)
  assert.equal(three.historicalFlowDistribution.highRaw, '0')
})

test('ambiguous Compound Withdraw event volume never becomes supplier outflow', () => {
  const withdrawal = directFlowDirection({
    marketKey: 'compoundV3Usdc',
    flowKind: 'withdraw',
    documents: docs,
    verified: {
      coverage: coverage('compoundV3Usdc', 3, true),
      withdrawals: [],
      unclassifiedWithdrawals: [
        {
          marketKey: 'compoundV3Usdc',
          reason: 'mixed_or_multiple_market_flows',
          eventAmountRaw: '42',
          blockHash: TX,
          transactionHash: TX,
          logIndex: 1,
          timestampMs: DAY,
        },
      ],
    },
    horizonHours: 24,
  })
  assert.equal(withdrawal.state, 'ambiguous_event_volume')
  assert.equal(withdrawal.observedMaximumWithinRecordedCoverage, null)
  assert.equal(withdrawal.observedEventVolumeWithinRecordedCoverage.amountRaw, '42')
  assert.equal(withdrawal.historicalFlowDistribution.status, 'unavailable')
})

test('source cannot be assigned to a different asset or destination', async () => {
  const manifest = await buildSubjectManifest()
  const original = manifest.subjects.find((row) => row.route_key === 'USDC → supply on Aave V3')
  const mutated = structuredClone(manifest)
  const index = mutated.subjects.findIndex((row) => row === original)
  assert.equal(index, -1)
  // The pinned manifest hash, route and asset verification prohibit even a
  // well-shaped replacement in the full report.
  mutated.subjects.find((row) => row.route_key === original.route_key).destination =
    '0x' + 'f'.repeat(40)
  assert.throws(
    () => buildHistoricalGrossFlowReport({ manifest: mutated, horizonHours: 24 }),
    /archive_subject_manifest_invalid/,
  )
})

test('frozen identity pin rejects well-formed vault mutation and singleton route swap', async () => {
  const original = await buildSubjectManifest()
  const vaultMutation = structuredClone(original)
  vaultMutation.subjects.find((row) => row.source_kind === 'vault').asset = '0x' + 'e'.repeat(40)
  resign(vaultMutation)
  assert.throws(
    () => buildHistoricalGrossFlowReport({ manifest: vaultMutation, horizonHours: 24 }),
    /gross_flow_frozen_identity_set_mismatch/,
  )
  const singletonSwap = structuredClone(original)
  const counts = new Map()
  for (const row of singletonSwap.subjects)
    counts.set(row.route_key, (counts.get(row.route_key) ?? 0) + 1)
  const pair = singletonSwap.subjects
    .filter((row) => row.source_kind === 'vault' && counts.get(row.route_key) === 1)
    .slice(0, 2)
  assert.equal(pair.length, 2)
  const firstRoute = pair[0].route_key
  pair[0].route_key = pair[1].route_key
  pair[1].route_key = firstRoute
  resign(singletonSwap)
  assert.throws(
    () => buildHistoricalGrossFlowReport({ manifest: singletonSwap, horizonHours: 24 }),
    /gross_flow_frozen_identity_set_mismatch/,
  )
})

test('document entrypoint verifies bytes rather than trusting detached replay', () => {
  assert.throws(
    () =>
      directFlowDirectionFromDocuments({
        marketKey: 'aaveV3Usdc',
        flowKind: 'supply',
        documents: docs,
        verified: { coverage: coverage('aaveV3Usdc', 3), supplies: [] },
        horizonHours: 24,
      }),
    /direct_segment_digest_mismatch|invalid_direct_segment/,
  )
})

test('API refutes forged source, maximum, distribution, and summary claims', async () => {
  const manifest = await buildSubjectManifest()
  const base = buildHistoricalGrossFlowReport({ manifest, horizonHours: 24 })
  const subject = base.subjects.find((row) => row.routeKey === 'USDC → supply on Aave V3')
  subject.assetDecimals = 6
  subject.inflow = directFlowDirection({
    marketKey: 'aaveV3Usdc',
    flowKind: 'supply',
    documents: docs,
    verified: { coverage: coverage('aaveV3Usdc', 3), supplies: [] },
    horizonHours: 24,
  })
  base.coverage.corroboratedGrossInflowSubjects = 1
  const query = { routeKey: subject.routeKey, destination: subject.destination, horizonHours: 24 }
  assert.equal(selectGrossFlowSubject(base, query).routeKey, subject.routeKey)
  const assertRefuted = (edit) => {
    const changed = structuredClone(base)
    edit(
      changed.subjects.find((row) => row.routeKey === subject.routeKey),
      changed,
    )
    assert.throws(() => selectGrossFlowSubject(changed, query), /gross_flow_/)
  }
  assertRefuted((row) => {
    row.inflow.source.sourceSetSha256 = SHA
  })
  assertRefuted((row) => {
    row.inflow.source.evidenceBindingSha256 = SHA
  })
  assertRefuted((row) => {
    row.inflow.source.coverageEndMs += DAY
  })
  assertRefuted((row) => {
    row.inflow.observedMaximumWithinRecordedCoverage.startMs = -DAY
  })
  assertRefuted((row) => {
    row.inflow.observedMaximumWithinRecordedCoverage.amountRaw = '1000000000000'
  })
  assertRefuted((row) => {
    row.inflow.historicalFlowDistribution.lowRaw = '1'
  })
  assertRefuted((row) => {
    row.inflow.historicalFlowDistribution.intervalCount = 4
  })
  assertRefuted((row) => {
    row.asset = '0x' + 'f'.repeat(40)
  })
  assertRefuted((row, report) => {
    report.coverage.corroboratedGrossInflowSubjects = 0
  })
  assertRefuted((row) => {
    row.aggregateCashContext = { state: 'aggregate_net_only_context' }
  })
  assertRefuted((row) => {
    row.outflow.state = 'aggregate_net_only_context'
    row.outflow.reason = 'gross_flow_not_integrated_in_this_report'
    row.outflow.historicalFlowDistribution.reason = row.outflow.reason
  })
})

test('API binds Compound ambiguity to its typed event evidence', async () => {
  const manifest = await buildSubjectManifest()
  const report = buildHistoricalGrossFlowReport({ manifest, horizonHours: 24 })
  const subject = report.subjects.find((row) => row.routeKey === 'USDC → supply on Compound v3')
  subject.assetDecimals = 6
  subject.outflow = directFlowDirection({
    marketKey: 'compoundV3Usdc',
    flowKind: 'withdraw',
    documents: docs,
    verified: {
      coverage: coverage('compoundV3Usdc', 3, true),
      withdrawals: [],
      unclassifiedWithdrawals: [
        {
          marketKey: 'compoundV3Usdc',
          reason: 'mixed_or_multiple_market_flows',
          eventAmountRaw: '42',
          blockHash: TX,
          transactionHash: TX,
          logIndex: 1,
          timestampMs: DAY,
        },
      ],
    },
    horizonHours: 24,
  })
  report.coverage.ambiguousOutflowSubjects = 1
  const query = { routeKey: subject.routeKey, destination: subject.destination, horizonHours: 24 }
  assert.equal(selectGrossFlowSubject(report, query).outflow.state, 'ambiguous_event_volume')
  const changed = structuredClone(report)
  changed.subjects.find((row) => row.routeKey === subject.routeKey).outflow.ambiguousEventCount = 0
  assert.throws(() => selectGrossFlowSubject(changed, query), /gross_flow_subject_invalid/)
})

test('failed optional source replay keeps the full manifest and typed abstention', async () => {
  const manifest = await buildSubjectManifest()
  const report = await readOfflineHistoricalGrossFlow({
    horizonHours: 24,
    readers: {
      manifest: () => manifest,
      cash: () => {
        throw Error('cash_receipt_corrupt')
      },
      documents: () => {
        throw Error('segment_digest_mismatch')
      },
      morphoSubjects: () => {
        throw Error('morpho_enrollment_corrupt')
      },
      routeVenues: () => {
        throw Error('route_config_corrupt')
      },
    },
  })
  assert.equal(report.coverage.routeGroups, 25)
  assert.equal(report.coverage.exactSubjects, 67)
  assert.deepEqual(report.cashSource, { status: 'unavailable', reason: 'cash_receipt_corrupt' })
  const aave = report.subjects.find((row) => row.routeKey === 'USDC → supply on Aave V3')
  assert.equal(aave.inflow.state, 'unavailable')
  assert.equal(aave.inflow.reason, 'source_replay_failed')
  assert.equal(aave.inflow.sourceFailureCode, 'segment_digest_mismatch')
  assert.equal(aave.outflow.observedMaximumWithinRecordedCoverage, null)
  const morpho = report.subjects.find((row) => row.routeKey === 'USDC → VaultV2 [USDC]')
  assert.equal(morpho.morphoRecordedRange.state, 'unavailable')
  assert.equal(morpho.morphoRecordedRange.reason, 'source_replay_failed')
  assert.equal(morpho.morphoRecordedRange.sourceFailureCode, 'morpho_enrollment_corrupt')
  const secondary = report.subjects.find(
    (row) => row.routeKey === frozenPins.secondaryRouteFlows.sUSDe.routeKey,
  )
  assert.equal(secondary.secondaryRouteFlow.state, 'unavailable')
  assert.equal(secondary.secondaryRouteFlow.sourceFailureCode, 'route_config_corrupt')
})
