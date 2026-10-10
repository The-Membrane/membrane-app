import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import projection from '../../lib/carry/conditionalSampledCashPathProjection.ts'
import timelines from '../../lib/carry/localHistoricalSampledCashTimeline.ts'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'
const {
  registeredConditionalSampledCashIdentity,
  conditionalSampledCashHistoryFromVerifiedTimeline,
  buildConditionalSampledCashPathProjection,
} = projection
const { isLiveConditionalProjectionEligible, loadRouteForecastWithLiveCurrent } = workbench
const routeKey = 'USDC → VaultV2 [USDC]'
const destination = '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96'
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const question = {
  routeKey,
  destination,
  amountUnits: '1',
  horizonHours: 24,
  payoutAsset: asset,
  payoutAssetDecimals: 6,
}
const response = (q = question) => ({
  routeKey: q.routeKey,
  destination: q.destination,
  source: 'prospective_finalized_observations',
  forecast: {
    claim: 'aggregate_cash_proxy_only',
    amountUnits: Number(q.amountUnits),
    horizonHours: q.horizonHours,
  },
  exitImpact: {
    historicalBacktest: null,
    historicalBacktestUnavailableReason: 'insufficient_long_history',
    conditionalProjection: null,
  },
  localHistoricalScenario: { status: 'unavailable', reason: 'no_fresh_current_cash' },
  conditionalSampledCashPathProjection: { status: 'unavailable', reason: 'source_stale' },
})

test('trusted identity is exact, case-normalized, cloned and independent of response availability', () => {
  const id = registeredConditionalSampledCashIdentity(
    routeKey,
    destination.toUpperCase().replace('0X', '0x'),
  )
  assert.deepEqual(id, { routeKey, destination, asset, assetDecimals: 6 })
  id.assetDecimals = 18
  assert.equal(registeredConditionalSampledCashIdentity(routeKey, destination).assetDecimals, 6)
  for (const [r, d] of [
    [routeKey + ' ', destination],
    ['other', destination],
    [routeKey, '0x123'],
    [routeKey, {}],
  ])
    assert.equal(registeredConditionalSampledCashIdentity(r, d), null)
})

test('actual 109-point postdeployment history supports 15 episodes without old backtest context', () => {
  const root = 'data/research/venue-signals/local-carry-cash-v1'
  const observations = readdirSync(root)
    .filter((n) => /^\d{12}\.json$/.test(n))
    .map((n) => JSON.parse(readFileSync(`${root}/${n}`, 'utf8')))
    .map((r) => ({
      collectionMode: r.collectionMode,
      anchorAt: r.anchorAt,
      firstLocalReceiptAt: r.firstLocalReceiptAt,
      receiptSha256: r.sha256,
      manifestSha256: r.manifestSha256,
      source: { block: r.block, blockHash: r.blockHash, blockAt: r.blockAt },
      subjects: r.rows,
    }))
  const timeline = timelines.localHistoricalSampledCashTimeline(observations, {
    route_key: routeKey,
    destination,
    asset,
  })
  assert.equal(timeline.status, 'sampled_timeline')
  const history = conditionalSampledCashHistoryFromVerifiedTimeline(observations, timeline)
  assert.equal(history.points.length, 109)
  const now = Date.parse('2026-10-08T12:00:00.000Z')
  const value = buildConditionalSampledCashPathProjection(
    {
      history,
      currentSource: {
        ...history.identity,
        chainId: 1,
        cashRaw: '100000000',
        block: '26190000',
        blockHash: `0x${'a'.repeat(64)}`,
        blockTime: new Date(now - 1000).toISOString(),
        readAt: new Date(now).toISOString(),
        sourceKind: 'live_read_only_two_origin_finalized',
      },
      request: { requestedRaw: '1000000', asOf: new Date(now).toISOString() },
    },
    (s) => createHash('sha256').update(s).digest('hex'),
  )
  assert.equal(value.status, 'estimated')
  assert.equal(value.scenarios.length, 15)
  assert.equal(isLiveConditionalProjectionEligible(response(), question), true)
})

test('expired or absent projections still permit exactly one bounded refresh without old backtest', async () => {
  for (const reason of ['source_stale', 'current_cash_unavailable']) {
    const archive = response()
    archive.conditionalSampledCashPathProjection.reason = reason
    const calls = []
    const delivered = []
    const live = await loadRouteForecastWithLiveCurrent(
      question,
      new AbortController().signal,
      (v) => delivered.push(v),
      async (url) => {
        calls.push(url)
        return { ok: true, json: async () => archive }
      },
    )
    assert.equal(calls.length, 2)
    assert.equal(calls[0].includes('includeLiveCurrent'), false)
    assert.equal(calls[1].includes('includeLiveCurrent=1'), true)
    assert.equal(delivered.length, 1)
    assert.ok(live)
  }
})
for (const [label, change] of Object.entries({
  foreignAsset: { payoutAsset: `0x${'a'.repeat(40)}` },
  foreignUnits: { payoutAssetDecimals: 18 },
  absentUnits: { payoutAssetDecimals: undefined },
  foreignRoute: { routeKey: 'other' },
  foreignDestination: { destination: `0x${'b'.repeat(40)}` },
  zeroQ: { amountUnits: '0' },
  invalidQ: { amountUnits: '1e6' },
  tooPreciseQ: { amountUnits: '0.0000001' },
  overflowQ: { amountUnits: (1n << 256n).toString() },
  unsupportedHorizon: { horizonHours: 12 },
}))
  test(`${label} remains archive-only without an independently matching native question`, async () => {
    const q = { ...question, ...change }
    const calls = []
    assert.equal(isLiveConditionalProjectionEligible(response(q), q), false)
    assert.equal(
      await loadRouteForecastWithLiveCurrent(
        q,
        new AbortController().signal,
        () => {},
        async (url) => {
          calls.push(url)
          return { ok: true, json: async () => response(q) }
        },
      ),
      null,
    )
    assert.equal(calls.length, 1)
  })
test('a registered native identity cannot bypass units through a legacy backtest payload', () => {
  const v = response()
  v.exitImpact.historicalBacktest = {
    status: 'historical_backtest',
    analysisKind: 'retrospective_backtest',
    identity: { routeKey, destination, asset, assetDecimals: 6 },
    question: { requestedRaw: '1000000', horizonHours: 24 },
    claimClass: 'route_proxy',
    holderExecutableExit: false,
    prospectiveValidated: false,
    forecastValidated: false,
  }
  assert.equal(
    isLiveConditionalProjectionEligible(v, { ...question, payoutAssetDecimals: 18 }),
    false,
  )
})
test('top-level typed unavailable keeps existing no-refresh behavior', async () => {
  const calls = []
  const result = await loadRouteForecastWithLiveCurrent(
    question,
    new AbortController().signal,
    () => {},
    async (url) => {
      calls.push(url)
      return { ok: true, json: async () => ({ status: 'unavailable', reason: 'missing_history' }) }
    },
  )
  assert.equal(result, null)
  assert.equal(calls.length, 1)
})
