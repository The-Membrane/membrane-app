import assert from 'node:assert/strict'
import test from 'node:test'

import sampledModule from '../../lib/carry/historicalSampledCashPaths.ts'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'

const {
  conditionalExitPressureEvidence,
  isLiveConditionalProjectionEligible,
  loadRouteEventContext,
  loadRouteForecastWithLiveCurrent,
  matchingRouteForecastResponse,
} = workbench

const destination = `0x${'a'.repeat(40)}`
const asset = `0x${'c'.repeat(40)}`
const blockHash = `0x${'d'.repeat(64)}`
const question = {
  routeKey: 'USDC → supply on Aave V3',
  destination,
  amountUnits: '100000',
  horizonHours: 24,
  payoutAsset: asset,
}

function commonImpact() {
  return {
    schemaVersion: 1,
    identity: { routeKey: question.routeKey, destination, asset, assetDecimals: 6 },
    question: { requestedRaw: '100000000000', horizonHours: 24 },
    claimClass: 'route_proxy',
    holderExecutableExit: false,
    prospectiveValidated: false,
    forecastValidated: false,
    probabilityQExecutable: {
      status: 'unavailable',
      reason: 'prospective_holder_outcomes_missing',
    },
    duration: {
      status: 'unavailable',
      reason: 'endpoint_history_has_no_crossing_or_recovery_time',
    },
    expectedCompetingFlow: {
      status: 'unavailable',
      reason: 'already_embedded_in_net_cash_endpoints',
    },
    newsImpact: { status: 'unavailable', reason: 'no_causal_news_event_model' },
  }
}

function historicalBacktest() {
  return {
    ...commonImpact(),
    status: 'historical_backtest',
    analysisKind: 'retrospective_backtest',
    reference: {
      basis: 'historical_tail_endpoint',
      at: '2026-09-01T00:00:00.000Z',
      cashRaw: '500000000000',
      marginAfterQRaw: '400000000000',
      state: 'cash_covers_q',
    },
    absoluteQBacktest: {
      status: 'historical_backtest',
      reason: null,
      claim: 'aggregate_endpoint_cash_proxy_only',
      historicalBacktestOnly: true,
      prospectiveValidated: false,
      holderExecutableExit: false,
      requestedRaw: '100000000000',
      counts: { total: 60, fit: 20, calibration: 20, holdout: 20 },
      outcomes: {
        fitBelowQ: { numerator: 1, denominator: 20 },
        calibrationBelowQ: { numerator: 1, denominator: 20 },
        holdoutBelowQ: { numerator: 1, denominator: 20 },
      },
      scoring: {
        method: 'fit_absolute_q_breach_frequency',
        calibrationBrier: { numerator: '1', denominator: 20 },
        calibrationPersistenceBrier: { numerator: '2', denominator: 20 },
        holdoutBrier: { numerator: '1', denominator: 20 },
        holdoutPersistenceBrier: { numerator: '2', denominator: 20 },
        calibrationStable: true,
        calibrationBeatsPersistence: true,
        holdoutBeatsPersistence: true,
      },
      retrospectiveSignal: { status: 'supported', reason: null },
    },
    cashBand: { status: 'unavailable', reason: 'no_skill_over_persistence' },
    alert: { status: 'unavailable', reason: 'retrospective_only' },
  }
}

function conditionalProjection() {
  return {
    ...commonImpact(),
    status: 'research_projection',
    analysisKind: 'conditional_live_projection',
    reference: {
      basis: 'scenario_current_endpoint',
      at: '2026-10-05T12:00:00.000Z',
      cashRaw: '500000000000',
      marginAfterQRaw: '400000000000',
      state: 'cash_covers_q',
    },
    absoluteQBacktest: null,
    cashBand: {
      status: 'available',
      evidence: 'historical_conditional_projection',
      modelKind: 'endpoint_net_cash_band',
      flowTreatment: 'all_aggregate_flow_already_included',
      method: 'learned_delta',
      targetAt: '2026-10-06T12:00:00.000Z',
      capacityRaw: {
        low: '80000000000',
        point: '120000000000',
        high: '160000000000',
      },
      marginAfterQRaw: {
        low: '-20000000000',
        point: '20000000000',
        high: '60000000000',
      },
      projectedState: 'band_crosses_q',
      direction: 'shrinking',
      holdout: {
        fit: 20,
        calibration: 20,
        selection: 10,
        selectionCovered: 9,
        holdout: 10,
        covered: 8,
        coveragePassed: true,
        pointBeatsPersistence: true,
        modelMae: { numeratorRaw: '10', denominator: 10 },
        persistenceMae: { numeratorRaw: '20', denominator: 10 },
      },
    },
    alert: { status: 'estimated', kind: 'projected_shrink' },
  }
}

function response(conditional) {
  return {
    routeKey: question.routeKey,
    destination,
    source: 'prospective_finalized_observations',
    forecast: {
      claim: 'aggregate_cash_proxy_only',
      amountUnits: 100000,
      horizonHours: 24,
    },
    localHistoricalScenario: conditional
      ? {
          status: 'historical_conditional_cash_scenario',
          claim: 'aggregate_underlying_cash_proxy_only',
          method: 'learned_delta',
          prospectiveValidated: false,
          holderExecutableExit: false,
          sourceKind: 'local_sha_replayed_finalized_rpc',
          currentSourceKind: 'live_read_only_two_origin_finalized',
          currentBlockAt: '2026-10-05T12:00:00.000Z',
          currentBlock: '26123032',
          currentBlockHash: blockHash,
          targetAt: '2026-10-06T12:00:00.000Z',
          currentCashRaw: '500000000000',
          // These intentionally differ. exitImpact.conditionalProjection owns the band.
          pointRaw: '1',
          bandLowRaw: '2',
          bandHighRaw: '3',
          assetDecimals: 6,
          pairs: 60,
          fit: 20,
          calibration: 20,
          selection: 10,
          selectionCovered: 9,
          holdout: 10,
          holdoutCovered: 8,
          holdoutPointBeatsPersistence: true,
          holdoutModelMae: { numeratorRaw: '10', denominator: 10 },
          holdoutPersistenceMae: { numeratorRaw: '20', denominator: 10 },
        }
      : { status: 'unavailable', reason: 'no_fresh_current_cash' },
    exitImpact: {
      historicalBacktest: historicalBacktest(),
      historicalBacktestUnavailableReason: null,
      conditionalProjection: conditional,
    },
    baselineEvidence: { status: 'not_enrolled', enrolledHorizonsHours: [1, 24] },
    prospectiveCashModel: {
      status: 'unavailable',
      routeKey: question.routeKey,
      destination,
      asset,
      horizonHours: 24,
      claim: 'aggregate_cash_proxy_only',
      holderExecutableExit: false,
      prospectiveValidated: false,
      schedule: null,
      outcome: null,
      interval: null,
      source: null,
      latestActiveIssue: null,
      reason: 'prospective_ledger_unavailable',
    },
    validation: {
      holderExit: 'unavailable',
      conditionDuration: 'unavailable',
      predictiveAlert: 'unavailable',
    },
  }
}

test('delivers archive history before issuing the explicit live-current request', async () => {
  const archive = response(null)
  const live = response(conditionalProjection())
  let releaseLive = null
  const calls = []
  const fetcher = async (url) => {
    calls.push(url)
    if (!url.includes('includeLiveCurrent=1')) return { ok: true, json: async () => archive }
    return await new Promise((resolve) => {
      releaseLive = resolve
    })
  }
  const delivered = []
  const pending = loadRouteForecastWithLiveCurrent(
    question,
    new AbortController().signal,
    (value) => delivered.push(value),
    fetcher,
  )

  while (calls.length < 2) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(delivered, [archive])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].includes('includeLiveCurrent'), false)
  assert.equal(calls[1].includes('includeLiveCurrent=1'), true)

  releaseLive({ ok: true, json: async () => live })
  assert.equal(await pending, live)
})

for (const horizonHours of [24, 48, 168]) {
  test(`keeps an exact typed ${horizonHours}-hour abstention archive-only`, async () => {
    const selectedQuestion = { ...question, horizonHours }
    const abstention = response(null)
    abstention.forecast.horizonHours = horizonHours
    abstention.prospectiveCashModel.horizonHours = horizonHours === 24 ? 24 : null
    abstention.exitImpact.historicalBacktest = null
    abstention.exitImpact.historicalBacktestUnavailableReason = 'asset_identity_mismatch'
    const calls = []
    const delivered = []

    const live = await loadRouteForecastWithLiveCurrent(
      selectedQuestion,
      new AbortController().signal,
      (value) => delivered.push(value),
      async (url) => {
        calls.push(url)
        return { ok: true, json: async () => abstention }
      },
    )

    assert.equal(live, null)
    assert.equal(calls.length, 1)
    const params = new URL(calls[0], 'https://membrane.local').searchParams
    assert.equal(params.get('horizonHours'), String(horizonHours))
    assert.equal(params.has('includeLiveCurrent'), false)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].forecast.horizonHours, horizonHours)
    assert.deepEqual(delivered[0].exitImpact, abstention.exitImpact)
    assert.equal(delivered[0].prospectiveCashModel.status, 'unavailable')
    assert.equal(delivered[0].prospectiveCashModel.horizonHours, horizonHours === 24 ? 24 : null)
    assert.equal(
      delivered[0].exitImpact.historicalBacktestUnavailableReason,
      'asset_identity_mismatch',
    )
  })
}

for (const horizonHours of [48, 168]) {
  test(`renews a supported native ${horizonHours}-hour forecast with live-current enrichment`, async () => {
    const selectedQuestion = {
      ...question,
      routeKey: 'USDC → supply on Compound v3',
      destination: '0xc3d688b66703497daa19211eedff47f25384cdc3',
      payoutAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      payoutAssetDecimals: 6,
      horizonHours,
    }
    const archive = response(null)
    archive.routeKey = selectedQuestion.routeKey
    archive.destination = selectedQuestion.destination
    archive.forecast.horizonHours = horizonHours
    archive.exitImpact.historicalBacktest = null
    archive.exitImpact.historicalBacktestUnavailableReason = 'asset_identity_mismatch'
    archive.prospectiveCashModel.routeKey = selectedQuestion.routeKey
    archive.prospectiveCashModel.destination = selectedQuestion.destination
    archive.prospectiveCashModel.asset = selectedQuestion.payoutAsset
    archive.prospectiveCashModel.horizonHours = null
    const calls = []
    const delivered = []

    const live = await loadRouteForecastWithLiveCurrent(
      selectedQuestion,
      new AbortController().signal,
      (value) => delivered.push(value),
      async (url) => {
        assert.equal(delivered.length, calls.length === 0 ? 0 : 1)
        calls.push(url)
        return { ok: true, json: async () => archive }
      },
    )

    assert.equal(calls.length, 2)
    for (const url of calls) {
      const params = new URL(url, 'https://membrane.local').searchParams
      assert.equal(params.get('routeKey'), selectedQuestion.routeKey)
      assert.equal(params.get('destination'), selectedQuestion.destination)
      assert.equal(params.get('amountUnits'), selectedQuestion.amountUnits)
      assert.equal(params.get('horizonHours'), String(horizonHours))
    }
    assert.equal(
      new URL(calls[0], 'https://membrane.local').searchParams.has('includeLiveCurrent'),
      false,
    )
    assert.equal(
      new URL(calls[1], 'https://membrane.local').searchParams.get('includeLiveCurrent'),
      '1',
    )
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].forecast.horizonHours, horizonHours)
    assert.ok(live)
    assert.equal(live.forecast.horizonHours, horizonHours)
    assert.equal(live.exitImpact.historicalBacktest, null)
    assert.equal(live.exitImpact.conditionalProjection, null)
  })
}

test('native live renewal accepts bounded integer horizons and rejects payout-question drift', () => {
  const selectedQuestion = {
    ...question,
    routeKey: 'USDC → supply on Compound v3',
    destination: '0xc3d688b66703497daa19211eedff47f25384cdc3',
    payoutAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    payoutAssetDecimals: 6,
    horizonHours: 48,
  }
  const archive = response(null)
  for (const horizonHours of [1, 2, 3, 24, 48, 168, 336, 720, 8760]) {
    assert.equal(
      isLiveConditionalProjectionEligible(archive, { ...selectedQuestion, horizonHours }),
      true,
    )
  }
  for (const drifted of [
    { ...selectedQuestion, horizonHours: 0 },
    { ...selectedQuestion, horizonHours: -1 },
    { ...selectedQuestion, horizonHours: 1.5 },
    { ...selectedQuestion, horizonHours: 8761 },
    { ...selectedQuestion, horizonHours: Number.NaN },
    { ...selectedQuestion, horizonHours: '24' },
    { ...selectedQuestion, payoutAsset: asset },
    { ...selectedQuestion, payoutAssetDecimals: 18 },
    { ...selectedQuestion, amountUnits: 'invalid' },
  ]) {
    assert.equal(isLiveConditionalProjectionEligible(archive, drifted), false)
  }
})

for (const horizonHours of [48, 168]) {
  test(`rejects a forged legacy ${horizonHours}-hour exit-impact projection`, () => {
    const selectedQuestion = { ...question, horizonHours }
    const forged = response(conditionalProjection())
    forged.forecast.horizonHours = horizonHours
    forged.prospectiveCashModel.horizonHours = null
    forged.exitImpact.historicalBacktest = null
    forged.exitImpact.conditionalProjection.question.horizonHours = horizonHours

    assert.equal(matchingRouteForecastResponse(forged, selectedQuestion), null)
    assert.equal(
      conditionalExitPressureEvidence(forged, selectedQuestion, 'USDC', 'Market cash'),
      null,
    )
  })
}

test('preserves exact historical Q evidence when the conditional model abstains', () => {
  const abstention = response(null)
  abstention.localHistoricalScenario = {
    status: 'unavailable',
    reason: 'model_selection_failed',
  }

  const matched = matchingRouteForecastResponse(abstention, question)
  assert.equal(matched, abstention)
  assert.equal(matched.exitImpact.historicalBacktest.status, 'historical_backtest')
  assert.equal(matched.exitImpact.historicalBacktest.forecastValidated, false)
  assert.equal(matched.exitImpact.conditionalProjection, null)
  assert.equal(conditionalExitPressureEvidence(matched, question, 'USDC', 'Market cash'), null)

  const wrongQuestion = { ...question, payoutAsset: `0x${'e'.repeat(40)}` }
  assert.equal(matchingRouteForecastResponse(abstention, wrongQuestion), null)
})

test('uses the shared conditional projection band and current endpoint directly', () => {
  const live = response(conditionalProjection())
  const selected = conditionalExitPressureEvidence(live, question, 'USDC', 'Market cash')

  assert.ok(selected)
  assert.equal(selected.currentCash.cashRaw, '500000000000')
  assert.equal(selected.currentCash.assetAddress, asset)
  assert.equal(selected.currentCash.observedAt, '2026-10-05T12:00:00.000Z')
  assert.equal(selected.currentCash.block, '26123032')
  assert.equal(selected.historicalScenario.requestedRaw, '100000000000')
  assert.equal(selected.historicalScenario.pointRaw, '120000000000')
  assert.equal(selected.historicalScenario.bandLowRaw, '80000000000')
  assert.equal(selected.historicalScenario.bandHighRaw, '160000000000')
  assert.deepEqual(selected.historicalScenario.validation, {
    fit: 20,
    calibration: 20,
    holdout: 10,
    covered: 8,
    coveragePassed: true,
    pointBeatsPersistence: true,
  })
})

test('preserves historical evidence but strips failed conditional projections at the client boundary', () => {
  const learned = conditionalProjection()
  learned.cashBand.holdout.pointBeatsPersistence = false
  learned.cashBand.holdout.modelMae = { numeratorRaw: '30', denominator: 10 }
  learned.cashBand.holdout.persistenceMae = { numeratorRaw: '20', denominator: 10 }
  learned.alert = { status: 'unavailable', reason: 'untouched_test_not_qualified' }
  const learnedResponse = response(learned)
  learnedResponse.localHistoricalScenario.holdoutPointBeatsPersistence = false
  learnedResponse.localHistoricalScenario.holdoutModelMae = {
    numeratorRaw: '30',
    denominator: 10,
  }
  learnedResponse.localHistoricalScenario.holdoutPersistenceMae = {
    numeratorRaw: '20',
    denominator: 10,
  }

  const learnedMatched = matchingRouteForecastResponse(learnedResponse, question)
  assert.ok(learnedMatched)
  assert.equal(learnedMatched.exitImpact.historicalBacktest.status, 'historical_backtest')
  assert.deepEqual(
    {
      status: learnedMatched.exitImpact.conditionalProjection.status,
      reason: learnedMatched.exitImpact.conditionalProjection.reason,
      sourceReason: learnedMatched.exitImpact.conditionalProjection.sourceReason,
    },
    {
      status: 'unavailable',
      reason: 'source_unavailable',
      sourceReason: 'untouched_point_skill_failed',
    },
  )
  assert.equal('cashBand' in learnedMatched.exitImpact.conditionalProjection, false)
  assert.equal(
    conditionalExitPressureEvidence(learnedMatched, question, 'USDC', 'Market cash'),
    null,
  )

  const persistence = conditionalProjection()
  persistence.cashBand.method = 'persistence_band'
  persistence.cashBand.holdout.covered = 7
  persistence.cashBand.holdout.coveragePassed = false
  persistence.cashBand.holdout.pointBeatsPersistence = null
  persistence.cashBand.holdout.modelMae = null
  persistence.cashBand.holdout.persistenceMae = null
  persistence.alert = { status: 'unavailable', reason: 'untouched_test_not_qualified' }
  const persistenceResponse = response(persistence)
  persistenceResponse.localHistoricalScenario.method = 'persistence_band'
  persistenceResponse.localHistoricalScenario.holdoutCovered = 7
  persistenceResponse.localHistoricalScenario.holdoutPointBeatsPersistence = null
  persistenceResponse.localHistoricalScenario.holdoutModelMae = null
  persistenceResponse.localHistoricalScenario.holdoutPersistenceMae = null

  const persistenceMatched = matchingRouteForecastResponse(persistenceResponse, question)
  assert.ok(persistenceMatched)
  assert.equal(persistenceMatched.exitImpact.historicalBacktest.status, 'historical_backtest')
  assert.deepEqual(
    {
      status: persistenceMatched.exitImpact.conditionalProjection.status,
      reason: persistenceMatched.exitImpact.conditionalProjection.reason,
      sourceReason: persistenceMatched.exitImpact.conditionalProjection.sourceReason,
    },
    {
      status: 'unavailable',
      reason: 'source_unavailable',
      sourceReason: 'untouched_interval_coverage_failed',
    },
  )
  assert.equal('cashBand' in persistenceMatched.exitImpact.conditionalProjection, false)
  assert.equal(
    conditionalExitPressureEvidence(persistenceMatched, question, 'USDC', 'Market cash'),
    null,
  )
})

test('strips unqualified model issue projections before the workbench can render their points', () => {
  const value = response(conditionalProjection())
  value.historicalModel = {
    status: 'historical_projection',
    modelKind: 'learned_delta',
    backtest: {
      holdout: 10,
      holdoutCovered: 9,
      holdoutCoveragePassed: true,
      holdoutPointBeatsPersistence: false,
      holdoutModelMae: { numeratorRaw: '30', denominator: 10 },
      holdoutPersistenceMae: { numeratorRaw: '20', denominator: 10 },
    },
  }
  value.twynePtReserveModel = {
    status: 'historical_projection',
    backtest: { holdout: 10, covered: 7 },
  }

  const matched = matchingRouteForecastResponse(value, question)
  assert.ok(matched)
  assert.deepEqual(matched.historicalModel, {
    status: 'unavailable',
    reason: 'untouched_point_skill_failed',
  })
  assert.deepEqual(matched.twynePtReserveModel, {
    status: 'unavailable',
    reason: 'untouched_interval_coverage_failed',
  })
  assert.equal(matched.exitImpact.historicalBacktest.status, 'historical_backtest')
  assert.equal(matched.exitImpact.conditionalProjection.status, 'research_projection')
})

test('rejects an enriched projection whose exact Q or payout asset drifts', () => {
  const wrongQ = response({
    ...conditionalProjection(),
    question: { requestedRaw: '100000000001', horizonHours: 24 },
  })
  const wrongAsset = response({
    ...conditionalProjection(),
    identity: {
      ...conditionalProjection().identity,
      asset: `0x${'e'.repeat(40)}`,
    },
  })

  assert.equal(matchingRouteForecastResponse(wrongQ, question), null)
  assert.equal(matchingRouteForecastResponse(wrongAsset, question), null)
})

test('loads route context with the exact six-field identity and rejects response drift', async () => {
  const expectedEnrollment = { status: 'not_enrolled' }
  const contextQuestion = {
    routeKey: question.routeKey,
    destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    requestedRaw: '100000000000',
    payoutAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    horizonHours: 24,
  }
  const context = {
    status: 'route_event_context',
    question: contextQuestion,
    venue: null,
    newsSource: 'aave-v3-usdc',
    association: 'contemporaneous_facts_no_causal_attribution',
    event: { status: 'not_recorded', reason: 'recorder_not_enrolled' },
    news: { status: 'source_unavailable', reason: 'source_unavailable' },
    capacity: { status: 'source_unavailable', reason: 'source_unavailable' },
    coverage: {
      routeGroups: { enrolled: 4, total: 26 },
      subjects: { enrolled: 4, total: 68 },
    },
    newsCoverage: {
      routeGroups: { enrolled: 26, total: 26 },
      subjects: { enrolled: 68, total: 68 },
    },
    newsImpact: { status: 'unavailable', reason: 'no_causal_model' },
    forecastValidated: false,
    prospectiveValidated: false,
    holderExecutableExit: false,
  }
  let requestedUrl = ''
  const selected = await loadRouteEventContext(
    contextQuestion,
    expectedEnrollment,
    new AbortController().signal,
    async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => context }
    },
  )
  const params = new URL(requestedUrl, 'http://localhost').searchParams
  assert.equal(params.get('routeKey'), contextQuestion.routeKey)
  assert.equal(params.get('destination'), contextQuestion.destination)
  assert.equal(params.get('requestedRaw'), contextQuestion.requestedRaw)
  assert.equal(params.get('payoutAsset'), contextQuestion.payoutAsset)
  assert.equal(params.get('assetDecimals'), '6')
  assert.equal(params.get('horizonHours'), '24')
  assert.equal(selected, context)

  const enrolledContext = {
    status: 'route_event_context',
    question: contextQuestion,
    venue: 'sGHO',
    newsSource: 'aave-v3-usdc',
    association: 'contemporaneous_facts_no_causal_attribution',
    event: { status: 'source_unavailable', reason: 'source_unavailable' },
    news: { status: 'source_unavailable', reason: 'source_unavailable' },
    capacity: context.capacity,
    coverage: context.coverage,
    newsCoverage: context.newsCoverage,
    newsImpact: context.newsImpact,
    forecastValidated: false,
    prospectiveValidated: false,
    holderExecutableExit: false,
  }
  const loadEnrolled = (value) =>
    loadRouteEventContext(
      contextQuestion,
      { status: 'enrolled', venue: 'sGHO' },
      new AbortController().signal,
      async () => ({ ok: true, json: async () => value }),
    )
  assert.equal(await loadEnrolled(enrolledContext), enrolledContext)
  assert.equal(await loadEnrolled({ ...enrolledContext, venue: 'sUSDe' }), null)
  assert.equal(await loadEnrolled(context), null)

  const drifted = {
    ...context,
    question: { ...contextQuestion, requestedRaw: '100000000001' },
  }
  assert.equal(
    await loadRouteEventContext(
      contextQuestion,
      expectedEnrollment,
      new AbortController().signal,
      async () => ({
        ok: true,
        json: async () => drifted,
      }),
    ),
    null,
  )
  await assert.rejects(
    loadRouteEventContext(
      contextQuestion,
      expectedEnrollment,
      new AbortController().signal,
      async () => ({
        ok: false,
        json: async () => ({ error: 'source unavailable' }),
      }),
    ),
    /route_event_context_unavailable/,
  )
})

test('client binding keeps descriptive paths through model abstention and drops stale Q/source', () => {
  const now = Date.now()
  const blockAt = new Date(now - 60000).toISOString()
  const identity = { routeKey: question.routeKey, destination, asset, assetDecimals: 6 }
  const subjectKey = `${identity.routeKey}\0${destination}\0${asset}`
  const sampledCashPaths = sampledModule.replaySampledHistoricalCashPaths({
    identity,
    requestedRaw: '100000000000',
    asOfMs: now,
    current: {
      subjectKey,
      asset,
      assetDecimals: 6,
      cashRaw: '500000000000',
      blockAt,
      block: '26123032',
      blockHash,
    },
    timelineIdentity: { subjectKey, asset, assetDecimals: 6 },
    timeline: Array.from({ length: 8 }, (_, i) => ({
      subjectKey,
      at: new Date(now - (9 - i) * 86400000).toISOString(),
      cashRaw: '500000000000',
    })),
  })
  assert.equal(sampledCashPaths.status, 'conditional_historical_sampled_cash_paths')
  const value = {
    ...response(null),
    sampledCashPaths,
    historicalModel: { status: 'unavailable', reason: 'no_skill' },
  }
  assert.equal(matchingRouteForecastResponse(value, question).sampledCashPaths, sampledCashPaths)
  const q = { ...sampledCashPaths, requestedRaw: '1' }
  assert.equal(
    matchingRouteForecastResponse({ ...value, sampledCashPaths: q }, question).sampledCashPaths,
    null,
  )
  const stale = {
    ...sampledCashPaths,
    current: { ...sampledCashPaths.current, blockAt: new Date(now - 3 * 3600000).toISOString() },
  }
  const matched = matchingRouteForecastResponse({ ...value, sampledCashPaths: stale }, question)
  assert.equal(matched.sampledCashPaths, null)
  assert.equal(matched.exitImpact.historicalBacktest.status, 'historical_backtest')
})
