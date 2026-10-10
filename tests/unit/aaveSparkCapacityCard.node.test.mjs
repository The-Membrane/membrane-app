import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import cardModule from '../../components/Carry/ExitPressureCard.tsx'
import adapter from '../../lib/carry/aaveSparkCapacityProjection.ts'
import flow from '../../lib/carry/historicalCompetingFlowEstimate.ts'
import gross from '../../lib/carry/conditionalGrossFlowHeadroom.ts'
import daily from '../../lib/carry/conditionalSampledCashPathProjection.ts'
import timeline from '../../lib/carry/localHistoricalSampledCashTimeline.ts'
import constants from '../../lib/carry/directSupplyMarketConstants.ts'
const hash = (s) => createHash('sha256').update(s).digest('hex')
const now = Date.parse('2026-10-08T12:00:00.000Z')
const summary = JSON.parse(
  readFileSync('data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json', 'utf8'),
)
const root = 'data/research/venue-signals/local-carry-cash-v1'
const observations = readdirSync(root)
  .filter((n) => /^\d{12}\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(root + '/' + n, 'utf8')))
  .map((r) => ({
    collectionMode: r.collectionMode,
    anchorAt: r.anchorAt,
    firstLocalReceiptAt: r.firstLocalReceiptAt,
    receiptSha256: r.sha256,
    manifestSha256: r.manifestSha256,
    source: { block: r.block, blockAt: r.blockAt, blockHash: r.blockHash },
    subjects: r.rows,
  }))
function props({ spark = false, local = false, cash = '10000000000000', horizon = 24 } = {}) {
  const m = spark
    ? constants.DIRECT_SUPPLY_MARKETS.sparkLendUsdt
    : constants.DIRECT_SUPPLY_MARKETS.aaveV3Usdc
  const s = {
    chainId: 1,
    routeKey: m.routeKey,
    destination: m.destination.toLowerCase(),
    asset: m.underlying.toLowerCase(),
    assetDecimals: 6,
    cashRaw: cash,
    blockNumber: 26190000,
    blockHash: '0x' + 'a'.repeat(64),
    blockTime: new Date(now - 60000).toISOString(),
    readAt: new Date(now - 1000).toISOString(),
    finalized: true,
    sourceKind: local ? 'manifest_bound_ledger' : 'live_read_only_two_origin_finalized',
  }
  const requestedRaw = '1000000'
  let evidence, kind
  if (spark || local) {
    const t = timeline.localHistoricalSampledCashTimeline(observations, {
      route_key: s.routeKey,
      destination: s.destination,
      asset: s.asset,
    })
    assert.equal(t.status, 'sampled_timeline')
    const history = daily.conditionalSampledCashHistoryFromVerifiedTimeline(observations, t)
    if (local) {
      s.manifestSha256 = history.witness.manifestSha256 ?? observations[0].manifestSha256
      s.receiptSha256 = observations.at(-1).receiptSha256
    }
    const { blockNumber, finalized, ...rest } = s
    evidence = daily.buildConditionalSampledCashPathProjection(
      {
        history,
        currentSource: { ...rest, block: String(blockNumber) },
        request: { requestedRaw, asOf: new Date(now).toISOString() },
      },
      hash,
    )
    assert.equal(evidence.status, 'estimated')
    kind = 'sampled_daily_paths'
  } else {
    const { sourceKind, ...currentSource } = s
    evidence = gross.buildConditionalGrossFlowHeadroom(
      {
        currentSource,
        request: { requestedRaw, asOf: new Date(now).toISOString() },
        historicalFlow: flow.buildHistoricalCompetingFlowEstimate(summary, hash),
      },
      hash,
    )
    assert.equal(evidence.status, 'estimated')
    kind = 'aave_joint_windows'
  }
  const projection = adapter.buildAaveSparkCapacityProjection(
    {
      currentSource: s,
      requestedRaw,
      horizonHours: horizon,
      asOfMs: now,
      reserveAgreement: null,
      pathEvidence: { kind, value: evidence },
    },
    hash,
  )
  assert.ok(projection)
  return {
    routeKey: s.routeKey,
    destination: s.destination,
    requestedAmount: '1',
    requestedRaw,
    requestedAssetSymbol: spark ? 'USDT' : 'USDC',
    requestedAssetAddress: s.asset,
    requestedAssetDecimals: 6,
    horizonHours: horizon,
    asOfMs: now,
    currentCash: {
      routeKey: s.routeKey,
      destination: s.destination,
      cashRaw: s.cashRaw,
      assetAddress: s.asset,
      assetDecimals: 6,
      assetSymbol: spark ? 'USDT' : 'USDC',
      observedAt: s.blockTime,
      block: String(s.blockNumber),
      blockHash: s.blockHash,
      freshness: 'fresh',
      label: 'Reserve cash',
      sourceKind: s.sourceKind,
      ...(local
        ? {
            firstLocalReceiptAt: s.readAt,
            manifestSha256: s.manifestSha256,
            receiptSha256: s.receiptSha256,
          }
        : { readAtUtc: s.readAt }),
    },
    aaveSparkCapacitySource: s,
    aaveSparkCapacityProjection: projection,
    conditionalGrossFlowHeadroom: kind === 'aave_joint_windows' ? evidence : null,
    conditionalSampledCashPathProjection: kind === 'sampled_daily_paths' ? evidence : null,
    prospectiveCashModel: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    holderAssessment: null,
    expectedEventEnrollment: null,
    eventContext: null,
    historicalOutlook: null,
  }
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(cardModule.ExitPressureCard, p)),
  )
const present = (html) => html.includes('aria-label="Projected protocol headroom"')
test('Aave uses one protocol range with actual short donor bracket and signed deficits', () => {
  for (const cash of ['10000000000000', '1']) {
    const p = props({ cash }),
      html = render(p),
      h = p.aaveSparkCapacityProjection.horizons[0]
    assert.ok(present(html))
    assert.ok(html.includes(h.target.earliestAt.slice(5, 19).replace('T', ' ')))
    assert.ok(html.includes(h.target.latestAt.slice(5, 19).replace('T', ' ')))
    assert.ok(!html.includes('Projected exit headroom'))
    assert.ok(!html.includes('P10'))
    assert.equal((html.match(/aria-label="Projected protocol headroom"/g) || []).length, 1)
    if (cash === '1')
      assert.ok(
        html.includes(cardModule.formatExitPressureSignedRaw(h.requestedHeadroom.p10Raw, 6)),
      )
  }
})
test('Spark daily and sealed-source Aave retain actual first sampled target at every query horizon', () => {
  for (const options of [
    { horizon: 1 },
    { spark: true, horizon: 1 },
    { spark: true, horizon: 168 },
    { local: true },
  ]) {
    const p = props(options),
      html = render(p)
    assert.ok(present(html))
    assert.ok(
      html.includes(
        p.aaveSparkCapacityProjection.horizons[0].target.earliestAt.slice(5, 19).replace('T', ' '),
      ),
    )
    assert.ok(html.includes(options.spark ? 'USDT' : 'USDC'))
  }
})
test('independent source/Q/units/freshness/summary mismatches omit only new row', () => {
  for (const mutate of [
    (p) => (p.requestedRaw = '2000000'),
    (p) => (p.currentCash.cashRaw = '7'),
    (p) => (p.currentCash.blockHash = '0x' + 'b'.repeat(64)),
    (p) => (p.aaveSparkCapacitySource.blockHash = '0x' + 'b'.repeat(64)),
    (p) => (p.aaveSparkCapacitySource.assetDecimals = 18),
    (p) => (p.aaveSparkCapacitySource.readAt = new Date(now + 1).toISOString()),
    (p) => (p.asOfMs = now + 1800001),
    (p) => (p.aaveSparkCapacityProjection.horizons[0].requestedHeadroom.p10Raw = '7'),
    (p) => (p.aaveSparkCapacitySource = null),
    (p) => (p.aaveSparkCapacityProjection.scope = 'entitlement_clipped_conditional_scenario'),
  ]) {
    const p = props()
    mutate(p)
    assert.ok(!present(render(p)))
  }
  const p = props({ local: true })
  delete p.conditionalSampledCashPathProjection
  assert.ok(!present(render(p)))
  const fallback = props()
  fallback.aaveSparkCapacityProjection = null
  assert.ok(render(fallback).includes('Projected headroom'))
})

const capacityImports = await import('../../lib/carry/holderExitCapacity.ts')
const capacityModule = capacityImports.default ?? capacityImports
const workbenchImports = await import('../../components/Carry/ForecastWorkbench.tsx')
const workbench = { ...workbenchImports.default, ...workbenchImports }
const owner = '0x' + 'b'.repeat(40)
function holderAgreement(p, entitlementRaw = '1500000') {
  const s = p.aaveSparkCapacitySource
  const quote = capacityModule.buildHolderExitCapacityQuote(
    {
      status: 'assessed',
      routeKey: p.routeKey,
      destinationAddress: p.destination,
      owner,
      request: { assetsRaw: p.requestedRaw, assetAddress: s.asset, horizonHours: p.horizonHours },
      source: {
        chainId: 1,
        blockNumber: s.blockNumber,
        blockHash: s.blockHash,
        blockTime: s.blockTime,
        originValidation: 'two_provider',
      },
      stages: [
        {
          name: 'withdrawal',
          assetAddress: s.asset,
          amountRaw: p.requestedRaw,
          relatedToRequest: true,
          status: 'reverted',
        },
      ],
      finalPayout: { status: 'unassessed', assetAddress: s.asset, amountRaw: null },
    },
    {
      entitlementRaw,
      quotedMaxWithdrawRaw: null,
      quotedMaxWithdrawStatus: 'not_read',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    p.asOfMs,
  )
  assert.ok(quote)
  const agreement = capacityModule.agreeHolderExitCapacityQuotes(
    { host: 'eth-mainnet.g.alchemy.com', quote },
    { host: 'rpc.ankr.com', quote },
    p.asOfMs,
  )
  assert.ok(agreement)
  assert.equal(agreement.quote.successfulRequestedRawLowerBound, null)
  return agreement
}
test('503 independent entitlement clips source-bound Aave/Spark paths with Q once without checked execution', () => {
  for (const options of [{}, { spark: true, horizon: 1 }, { local: true }])
    for (const E of ['1500000', '500000']) {
      const p = props(options),
        agreement = holderAgreement(p, E)
      p.requestedHolderAddress = owner
      p.holderCapacityAgreement = workbench.holderCapacityAgreementFromResponse(
        { error: 'holder_exit_assessment_unavailable', capacityAgreement: agreement },
        503,
      )
      const before = structuredClone(p),
        html = render(p)
      assert.ok(html.includes('aria-label="Projected exit headroom"'))
      assert.ok(!present(html))
      assert.ok(!html.includes('holder checked at source'))
      assert.ok(
        html.includes(
          cardModule.formatExitPressureSignedRaw(
            (BigInt(E) - BigInt(p.requestedRaw)).toString(),
            6,
          ),
        ),
      )
      assert.deepEqual(p, before)
    }
  assert.equal(workbench.holderCapacityAgreementFromResponse({ capacityAgreement: {} }, 500), null)
  assert.equal(
    workbench.holderCapacityAgreementFromResponse(
      { error: 'other_error', capacityAgreement: {} },
      503,
    ),
    null,
  )
})
test('wrong holder/Q/C2/native/entitlement/expiry and self-asserted success fall back to protocol scope', () => {
  for (const mutate of [
    (p) => (p.requestedHolderAddress = '0x' + 'c'.repeat(40)),
    (p) => (p.holderCapacityAgreement.quote.owner = '0x' + 'c'.repeat(40)),
    (p) => (p.holderCapacityAgreement.quote.requestedRaw = '2'),
    (p) => (p.holderCapacityAgreement.quote.source.blockHash = '0x' + 'c'.repeat(64)),
    (p) => (p.holderCapacityAgreement.quote.assetDecimals = 18),
    (p) => (p.holderCapacityAgreement.quote.entitlementRaw = null),
    (p) => (p.holderCapacityAgreement.origins[1].host = p.holderCapacityAgreement.origins[0].host),
    (p) => {
      for (const q of [
        p.holderCapacityAgreement.quote,
        ...p.holderCapacityAgreement.origins.map((o) => o.quote),
      ])
        q.successfulRequestedRawLowerBound = p.requestedRaw
    },
  ]) {
    const p = props()
    p.requestedHolderAddress = owner
    p.holderCapacityAgreement = holderAgreement(p)
    mutate(p)
    const html = render(p)
    assert.ok(present(html))
    assert.ok(!html.includes('aria-label="Projected exit headroom"'))
  }
  const p = props()
  p.requestedHolderAddress = owner
  p.holderCapacityAgreement = holderAgreement(p)
  p.asOfMs += 1800001
  assert.ok(!render(p).includes('aria-label="Projected exit headroom"'))
})
test('protocol source-reference pin survives non-H24 queries and rejects source/witness drift', () => {
  for (const options of [
    { horizon: 1 },
    { spark: true, horizon: 48 },
    { local: true, horizon: 168 },
  ]) {
    const p = props(options),
      question = {
        routeKey: p.routeKey,
        destination: p.destination,
        requestedRaw: p.requestedRaw,
        requestedAssetAddress: p.requestedAssetAddress,
        requestedAssetDecimals: 6,
        horizonHours: p.horizonHours,
        asOfMs: p.asOfMs,
      }
    const pin = workbench.matchingHolderForecastSourceReference(
      p.conditionalGrossFlowHeadroom,
      question,
      p.currentCash,
      p.conditionalSampledCashPathProjection,
      p,
    )
    assert.deepEqual(pin, {
      blockNumber: p.aaveSparkCapacitySource.blockNumber,
      blockHash: p.currentCash.blockHash,
      blockTime: p.currentCash.observedAt,
    })
    assert.equal(
      workbench.matchingHolderForecastSourceReference(
        p.conditionalGrossFlowHeadroom,
        { ...question, requestedRaw: '2' },
        p.currentCash,
        p.conditionalSampledCashPathProjection,
        p,
      ),
      null,
    )
  }
})
