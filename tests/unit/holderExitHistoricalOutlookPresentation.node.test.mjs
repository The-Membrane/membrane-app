import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'

import outlookModule from '../../components/Carry/HolderExitHistoricalOutlook.tsx'

const {
  HolderExitHistoricalOutlookPresentation,
  HolderExitTestedBoundsPresentation,
  formatTestedRawAmount,
  historicalExitAssetSymbol,
  historicalOutlookSelectionKey,
  historicalOutlookView,
  parseHolderExitTestedBoundsResponse,
  parseHistoricalOutlookResponse,
  selectedHistoricalOutlookView,
} = outlookModule

const routeKey = 'USDC → VaultV2 [USDC]'
const destination = `0x${'a'.repeat(40)}`
const asset = `0x${'c'.repeat(40)}`

function response(overrides = {}) {
  return {
    status: 'available',
    routeKey,
    destination,
    requestedRaw: '10000000000',
    routeGroup: {
      mechanism: 'atomic',
      exactSubjects: 33,
      scope: 'exact_destination_route',
      historicalOutlook: 'eligible_exact_endpoint_history',
    },
    evidence: {
      evidenceId: 'morpho_fixed_10k_holder_call_ledger',
      evidenceClass: 'historical_endpoint',
      title: 'Fixed $10k holder call history',
      headline: '39 baseline-success episodes; 1 observed loss, 1 recovery, and 38 right-censored.',
      endpoint: 'fixed_10k_exact_holder_withdrawal_call_at_sampled_horizon',
      proxyLabel: null,
      samples: [
        { label: 'Episodes', value: '39' },
        { label: 'Observed losses', value: '1' },
      ],
      method: 'holder_vault_anchor_episode',
      window: {
        fromUtc: null,
        throughUtc: null,
        fromBlock: '25400000',
        throughBlock: '26000000',
      },
    },
    provenance: {
      source: 'local_historical_artifacts',
      claimClass: 'retrospective_historical_outlook',
      manifestSha256: 'f'.repeat(64),
      mechanismVersion: 'holder-exit-mechanisms-v1',
      routeGroups: 26,
      exactSubjects: 68,
      frozenCohortRouteGroups: 25,
      frozenCohortExactSubjects: 67,
      supplementalRouteGroups: 1,
      supplementalExactSubjects: 1,
      exactEndpointHistoryRouteGroups: 18,
      proxyOnlyHistoryRouteGroups: 8,
      abstainingRouteGroups: 0,
    },
    ...overrides,
  }
}

function render(view) {
  return renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      null,
      React.createElement(HolderExitHistoricalOutlookPresentation, { view }),
    ),
  )
}

function testedBoundsResponse(overrides = {}) {
  return {
    status: 'available',
    routeKey,
    destination,
    asset,
    stageScope: 'direct_morpho_vaultv2_withdraw_eth_call',
    subjectStatus: 'historical_tested_bounds',
    requestedHorizonHours: 24,
    requestedRaw: '500000000',
    exactQAtHorizon: {
      assertion: 'historical_exact_q_primary_assays',
      recordedPrimaryCells: 2,
      uniqueIssueClustersUpperBound: 1,
      correlatedRowsNonIndependent: true,
      transitions: {
        callableToCallable: 1,
        callableToImpaired: 0,
        impairedToImpaired: 0,
        impairedToCallable: 0,
      },
      censorReasons: { capture_window_missed: 1 },
    },
    qLadderRelation: {
      assertion: 'historical_monotone_tested_ladder_relation',
      eligibleCohorts: 3,
      uniqueIssueClustersUpperBound: 2,
      correlatedRowsNonIndependent: true,
      counts: {
        withinCallableLowerBound: 2,
        atOrAboveImpairedTier: 0,
        betweenTestedTiers: 0,
        aboveTestedCeiling: 1,
        belowImpairedFloor: 0,
      },
    },
    testedAmountAtHorizon: {
      assertion: 'historical_tested_callable_lower_bounds',
      horizonHours: 24,
      unit: 'asset_raw',
      orderStatistic: 'min_lower_median_max',
      descriptiveSample: true,
      populationQuantile: false,
      minRawLowerBound: '400000000',
      medianRawLowerBound: '500000000',
      maxRawLowerBound: '600000000',
      eligibleCohortCount: 3,
      measuredCellCount: 6,
      noCallableCohortCount: 0,
      aboveTestCeilingUnknownCohortCount: 3,
    },
    amountReason: null,
    sampledState: {
      assertion: 'historical_sampled_state_only',
      attemptedTrajectoryCount: 4,
      measuredTrajectoryCount: 4,
      differentStateWindowCount: 1,
      differentStateWithoutWindowCount: 1,
      sameStateAtLastSampleCount: 2,
      lastSameStateSampleCheckpointCounts: [
        { hours: 1, count: 1 },
        { hours: 24, count: 1 },
      ],
      maxLastSameStateSampleHours: 24,
      observations: [
        {
          baselineState: 'simulated_callable',
          lastSameStateSampleHours: 24,
          lastSameStateObservedAtUtc: '2026-10-03T14:15:16.000Z',
          differentStateObservedAtUtc: null,
          firstObservedDifferentStateWindow: null,
          sameStateAtLastSample: true,
        },
        {
          baselineState: 'simulated_callable',
          lastSameStateSampleHours: 1,
          lastSameStateObservedAtUtc: '2026-10-03T01:00:00.000Z',
          differentStateObservedAtUtc: null,
          firstObservedDifferentStateWindow: null,
          sameStateAtLastSample: true,
        },
        {
          baselineState: 'simulated_callable',
          lastSameStateSampleHours: null,
          lastSameStateObservedAtUtc: null,
          differentStateObservedAtUtc: '2026-10-03T01:00:00.000Z',
          firstObservedDifferentStateWindow: {
            afterObservedAtUtc: '2026-10-03T00:00:00.000Z',
            byObservedAtUtc: '2026-10-03T01:00:00.000Z',
            lastSameStatePlannedHorizonHours: null,
            differentStatePlannedHorizonHours: 1,
          },
          sameStateAtLastSample: false,
        },
        {
          baselineState: 'simulated_callable',
          lastSameStateSampleHours: null,
          lastSameStateObservedAtUtc: null,
          differentStateObservedAtUtc: '2026-10-03T01:00:00.000Z',
          firstObservedDifferentStateWindow: null,
          sameStateAtLastSample: false,
        },
      ],
      durationProjection: null,
    },
    stateReason: null,
    durationProjection: null,
    provenance: {
      source: 'local_sealed_panel_reader',
      sourceVerification: 'offline_sealed_replay',
      sourceVerificationBasis: 'forwarded_producer_assertion',
      scope: 'historical_tested_amount_bounds',
      claimClass: 'historical_tested_callable_lower_bounds',
      manifestSha256: 'd'.repeat(64),
      historicalDataThroughUtc: '2026-10-03T14:15:16.000Z',
      historicalDataThroughClockBasis: 'saved_local_panel_clocks',
      historicalDataThroughIndependentlyWitnessed: false,
      routeGroups: 25,
      exactSubjects: 67,
      rawRows: 5170,
    },
    ...overrides,
  }
}

function renderTestedBounds(evidence, assetDecimals = 6, assetSymbol = 'USDC') {
  return renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      null,
      React.createElement(HolderExitTestedBoundsPresentation, {
        evidence,
        assetDecimals,
        assetSymbol,
      }),
    ),
  )
}

function withoutInjectedStyles(html) {
  return html.replaceAll(/<style[\s\S]*?<\/style>/g, '')
}

test('server-renders a compact skeleton before the local evidence read', () => {
  const html = render({ status: 'loading' })
  assert.match(html, /Historical outlook/)
  assert.match(html, /Loading historical outlook/)
})

test('shows one destination-scoped exact evidence block, provenance, and collapsed method', () => {
  const parsed = parseHistoricalOutlookResponse(response(), routeKey, destination)
  assert.notEqual(parsed, null)
  const html = render(historicalOutlookView(parsed))
  assert.match(html, /Exact endpoint history/)
  assert.match(html, /Fixed \$10k holder call history/)
  assert.match(html, /Exact destination evidence · 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/)
  assert.match(html, /tracked 26 route groups \/ 68 exact subjects/)
  assert.match(html, /frozen August core 25 groups \/ 67 subjects/)
  assert.match(html, /supplemental 1 group \/ 1 subject/)
  assert.match(html, /manifest ffffffffff/)
  assert.match(html, /<details\b/)
  assert.match(html, /Samples &amp; method/)
  assert.doesNotMatch(html, /probability/i)
  assert.doesNotMatch(html, /forecast unavailable/i)
  assert.doesNotMatch(html, /validated forecast/i)
})

test('marks a proxy with its limitation and uses a quiet abstention state', () => {
  const proxy = response({
    routeGroup: {
      mechanism: 'staged',
      exactSubjects: 1,
      scope: 'exact_destination_route',
      historicalOutlook: 'eligible_proxy_history',
    },
    evidence: {
      evidenceId: 'saturn_queue_processing_regime_check',
      evidenceClass: 'historical_proxy',
      title: 'Queue processing regime',
      headline: '18 of 71 later tickets processed within 24h.',
      endpoint: 'request_to_operator_processing_within_24h',
      proxyLabel: 'intermediate_queue_stage_not_final_asset_exit',
      samples: [{ label: 'Later evaluable', value: '71' }],
      method: 'queue_ticket',
      window: {
        fromUtc: null,
        throughUtc: '2026-10-02T21:23:35.000Z',
        fromBlock: null,
        throughBlock: null,
      },
    },
  })
  const proxyHtml = render(historicalOutlookView(proxy))
  assert.match(proxyHtml, /Proxy history/)
  assert.match(proxyHtml, /intermediate queue stage not final asset exit/)
  assert.doesNotMatch(proxyHtml, /Route group evidence/)

  const abstainHtml = render({ status: 'abstain', reason: 'thin_history' })
  assert.match(abstainHtml, /History is too thin for this route\./)
  assert.doesNotMatch(abstainHtml, /forecast unavailable/i)
})

test('rejects another destination or a mismatched evidence class', () => {
  assert.equal(parseHistoricalOutlookResponse(response(), routeKey, `0x${'b'.repeat(40)}`), null)
  assert.equal(
    parseHistoricalOutlookResponse(
      response({ evidence: { ...response().evidence, evidenceClass: 'historical_proxy' } }),
      routeKey,
      destination,
    ),
    null,
  )
})

test('rejects stale or inconsistent tracked-registry provenance', () => {
  assert.equal(
    parseHistoricalOutlookResponse(
      response({
        provenance: {
          ...response().provenance,
          routeGroups: 25,
          exactSubjects: 67,
        },
      }),
      routeKey,
      destination,
    ),
    null,
  )
  assert.equal(
    parseHistoricalOutlookResponse(
      response({
        provenance: {
          ...response().provenance,
          supplementalExactSubjects: 2,
        },
      }),
      routeKey,
      destination,
    ),
    null,
  )
  assert.equal(
    parseHistoricalOutlookResponse(
      response({
        provenance: {
          ...response().provenance,
          exactEndpointHistoryRouteGroups: 17,
        },
      }),
      routeKey,
      destination,
    ),
    null,
  )
})

test('tested bounds parser rejects mismatched identity, horizon, or provenance', () => {
  const valid = testedBoundsResponse()
  assert.notEqual(
    parseHolderExitTestedBoundsResponse(valid, routeKey, destination, asset, 24),
    null,
  )
  assert.equal(
    parseHolderExitTestedBoundsResponse(valid, `${routeKey} changed`, destination, asset, 24),
    null,
  )
  assert.equal(
    parseHolderExitTestedBoundsResponse(valid, routeKey, `0x${'b'.repeat(40)}`, asset, 24),
    null,
  )
  assert.equal(
    parseHolderExitTestedBoundsResponse(valid, routeKey, destination, `0x${'e'.repeat(40)}`, 24),
    null,
  )
  assert.equal(parseHolderExitTestedBoundsResponse(valid, routeKey, destination, asset, 1), null)
  assert.equal(
    parseHolderExitTestedBoundsResponse(
      {
        ...valid,
        provenance: { ...valid.provenance, sourceVerificationBasis: 'self_asserted' },
      },
      routeKey,
      destination,
      asset,
      24,
    ),
    null,
  )
  assert.equal(
    parseHolderExitTestedBoundsResponse(
      {
        ...valid,
        provenance: { ...valid.provenance, routeGroups: 26, exactSubjects: 68 },
      },
      routeKey,
      destination,
      asset,
      24,
    ),
    null,
  )
})

test('formats raw integer amounts without Number precision loss', () => {
  assert.equal(
    formatTestedRawAmount('1234567890123456789012345', 18),
    '1,234,567.890123456789012345',
  )
  assert.equal(formatTestedRawAmount('42', 6), '0.000042')
  assert.equal(formatTestedRawAmount('1000000', 6), '1')
  assert.equal(formatTestedRawAmount('01', 6), null)
})

test('derives the historical amount symbol from the exact bracketed route asset', () => {
  assert.equal(historicalExitAssetSymbol('PYUSD → StakingVault [wYLDS]'), 'wYLDS')
  assert.equal(historicalExitAssetSymbol('AUSD → Staked USDat [USDat]'), 'USDat')
  assert.equal(
    historicalExitAssetSymbol('USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'),
    'PT-srUSDe-22OCT2026',
  )
  assert.equal(historicalExitAssetSymbol('USDT → FluidBridgeAggregatorProxy [USDC]'), 'USDC')
  assert.equal(historicalExitAssetSymbol('GHO → Unbracketed venue'), 'GHO')
})

test('historical selection keys hide a previous route, destination, or refresh view', () => {
  const selectedKey = historicalOutlookSelectionKey(routeKey, destination.toUpperCase(), 3)
  assert.equal(selectedKey, historicalOutlookSelectionKey(routeKey, destination, 3))
  assert.notEqual(selectedKey, historicalOutlookSelectionKey(`${routeKey} changed`, destination, 3))
  assert.notEqual(selectedKey, historicalOutlookSelectionKey(routeKey, `0x${'b'.repeat(40)}`, 3))
  assert.notEqual(selectedKey, historicalOutlookSelectionKey(routeKey, destination, 4))
  assert.notEqual(
    historicalOutlookSelectionKey(routeKey, destination, 3, '10000000000'),
    historicalOutlookSelectionKey(routeKey, destination, 3, '9999999999'),
  )
  assert.equal(
    parseHistoricalOutlookResponse(response(), routeKey, destination, '9999999999'),
    null,
  )

  const priorResponse = parseHistoricalOutlookResponse(response(), routeKey, destination)
  assert.notEqual(priorResponse, null)
  const priorView = historicalOutlookView(priorResponse)
  const prior = {
    selectionKey: historicalOutlookSelectionKey(routeKey, destination, 2),
    view: priorView,
  }
  assert.deepEqual(selectedHistoricalOutlookView(prior, selectedKey), { status: 'loading' })
  assert.equal(selectedHistoricalOutlookView(prior, prior.selectionKey), priorView)
})

test('renders compact tested bounds, sampled facts, and collapsed source labels', () => {
  const parsed = parseHolderExitTestedBoundsResponse(
    testedBoundsResponse(),
    routeKey,
    destination,
    asset,
    24,
  )
  assert.notEqual(parsed, null)
  const html = withoutInjectedStyles(renderTestedBounds(parsed))
  assert.match(html, /HISTORICAL TEST · 500 USDC · \+24H/)
  assert.match(html, /EXACT Q AT EXACT H \/ PRIMARY ASSAYS/)
  assert.match(html, /CORRELATED ROWS \/ NON-INDEPENDENT/)
  assert.match(html, /Lowest tested/)
  assert.doesNotMatch(html, /Conservative floor/)
  assert.match(html, /≥ 400 USDC/)
  assert.match(html, /Highest tested/)
  assert.match(html, /≥ 600 USDC/)
  assert.match(html, /COHORTS \/ 3 · MEASURED CELLS \/ 6/)
  assert.match(html, /TEST LIMIT \/ 3 COHORTS/)
  assert.match(html, /Latest same-state checkpoint/)
  assert.match(html, /\+24H/)
  assert.match(html, /Same state at last sample/)
  assert.match(html, />2 \/ 4</)
  assert.match(html, /First different-state sample windows/)
  assert.match(html, /Different state · no bounded window/)
  assert.match(html, /FIRST DIFFERENT-STATE SAMPLE/)
  assert.match(html, /SAME STATE AT LAST SAMPLE/)
  assert.match(html, /DIFFERENT STATE SAMPLED \/ NO BOUNDED WINDOW/)
  assert.doesNotMatch(html, /FIRST CHANGE|RIGHT-CENSORED/)
  assert.match(html, /<details\b/)
  assert.match(html, /SAVED LOCAL REPLAY \/ 2026-10-03 14:15 UTC/)
  assert.match(html, /VERIFICATION BASIS \/ FORWARDED PRODUCER ASSERTION/)
  assert.match(html, /CLOCK \/ SAVED LOCAL PANEL CLOCKS/)
  assert.match(html, /INDEPENDENTLY WITNESSED \/ NO/)
  assert.match(html, /STAGE \/ direct morpho vaultv2 withdraw eth call/)
  assert.doesNotMatch(html, /forecast unavailable/i)
  assert.doesNotMatch(html, /capacity/i)
  assert.match(html, /NO DURATION ESTIMATE/)
  assert.doesNotMatch(html, /validated forecast/i)
})

test('renders cohorts with no callable tested tier as a measured historical fact', () => {
  const base = testedBoundsResponse()
  const parsed = parseHolderExitTestedBoundsResponse(
    testedBoundsResponse({
      testedAmountAtHorizon: {
        ...base.testedAmountAtHorizon,
        minRawLowerBound: '0',
        noCallableCohortCount: 1,
      },
    }),
    routeKey,
    destination,
    asset,
    24,
  )
  assert.notEqual(parsed, null)
  const html = withoutInjectedStyles(renderTestedBounds(parsed))
  assert.match(html, /NO CALLABLE TESTED TIER \/ 1 COHORTS/)
})

test('renders sampled facts without an asset amount and stays silent without evidence', () => {
  const sampledOnly = testedBoundsResponse({
    testedAmountAtHorizon: null,
    amountReason: 'unit_not_comparable',
  })
  const parsed = parseHolderExitTestedBoundsResponse(sampledOnly, routeKey, destination, asset, 24)
  assert.notEqual(parsed, null)
  const html = withoutInjectedStyles(renderTestedBounds(parsed, 18, 'apxUSD'))
  assert.match(html, /Same state at last sample/)
  assert.doesNotMatch(html, /Lowest tested/)
  assert.doesNotMatch(html, /Highest tested/)
  assert.doesNotMatch(withoutInjectedStyles(renderTestedBounds(null)), /holder-exit-tested-bounds/)

  const noEvidence = testedBoundsResponse({
    testedAmountAtHorizon: null,
    amountReason: 'no_exact_horizon',
    sampledState: null,
    stateReason: 'no_measured_samples',
    exactQAtHorizon: null,
    qLadderRelation: null,
  })
  const parsedEmpty = parseHolderExitTestedBoundsResponse(
    noEvidence,
    routeKey,
    destination,
    asset,
    24,
  )
  assert.notEqual(parsedEmpty, null)
  assert.doesNotMatch(
    withoutInjectedStyles(renderTestedBounds(parsedEmpty)),
    /holder-exit-tested-bounds/,
  )
})

test('keeps tested bounds inside the historical surface when historical evidence abstains', () => {
  const parsed = parseHolderExitTestedBoundsResponse(
    testedBoundsResponse(),
    routeKey,
    destination,
    asset,
    24,
  )
  const html = renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      null,
      React.createElement(HolderExitHistoricalOutlookPresentation, {
        view: { status: 'abstain', reason: 'thin_history' },
        testedBounds: parsed,
        assetDecimals: 6,
        assetSymbol: 'USDC',
      }),
    ),
  )
  assert.match(html, /Historical outlook/)
  assert.match(html, /holder-exit-tested-bounds/)
  assert.match(html, /ENDPOINT HISTORY \/ INSUFFICIENT/)
  assert.doesNotMatch(html, /History is too thin for this route\./)
  assert.doesNotMatch(html, /Historical evidence could not be read\./)
  assert.equal((html.match(/border-top-width/g) ?? []).length >= 1, true)

  const readErrorHtml = renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      null,
      React.createElement(HolderExitHistoricalOutlookPresentation, {
        view: { status: 'abstain', reason: 'read_error' },
        testedBounds: parsed,
        assetDecimals: 6,
        assetSymbol: 'USDC',
      }),
    ),
  )
  assert.match(readErrorHtml, /ENDPOINT HISTORY \/ READ FAILED/)
  assert.doesNotMatch(readErrorHtml, /Historical evidence could not be read\./)
})

test('preserves historical abstain and read-error warnings without tested bounds', () => {
  const thinHtml = withoutInjectedStyles(render({ status: 'abstain', reason: 'thin_history' }))
  assert.match(thinHtml, /History is too thin for this route\./)

  const readErrorHtml = withoutInjectedStyles(render({ status: 'abstain', reason: 'read_error' }))
  assert.match(readErrorHtml, /Historical evidence could not be read\./)
})

test('endpoint-only staged history retains proxy evidence and scopes Q abstention to one row', () => {
  const endpointOnly = response({
    requestedRaw: null,
    routeGroup: {
      mechanism: 'staged',
      exactSubjects: 1,
      scope: 'exact_destination_route',
      historicalOutlook: 'eligible_proxy_history',
    },
    evidence: {
      ...response().evidence,
      evidenceId: 'saturn_exact_holder_usdat_payment_duration',
      evidenceClass: 'historical_proxy',
      proxyLabel: 'intermediate_usdat_payment_not_final_ausd_exit',
      title: 'Request to holder payment history',
    },
  })
  const parsed = parseHistoricalOutlookResponse(endpointOnly, routeKey, destination, null)
  assert.notEqual(parsed, null)
  const html = renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      null,
      React.createElement(HolderExitHistoricalOutlookPresentation, {
        view: historicalOutlookView(parsed),
        qAbstentionReason: 'stage_units_differ',
      }),
    ),
  )
  assert.match(html, /Request to holder payment history/)
  assert.match(html, /HISTORICAL Q \/ STAGE UNITS DIFFER/)
  assert.doesNotMatch(html, /holder-exit-tested-bounds/)
  assert.equal(parseHistoricalOutlookResponse(endpointOnly, routeKey, destination, '500'), null)
  assert.notEqual(
    historicalOutlookSelectionKey(routeKey, destination, 1, null),
    historicalOutlookSelectionKey(routeKey, destination, 1, '500'),
  )
})
