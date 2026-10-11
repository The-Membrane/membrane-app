import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import sampled from '../../lib/carry/conditionalSampledCashPathProjection.ts'
import timeline from '../../lib/carry/localHistoricalSampledCashTimeline.ts'
import holder from '../../lib/carry/conditionalHolderSampledCashProjection.ts'
import card from '../../components/Carry/ExitPressureCard.tsx'
import wb from '../../components/Carry/ForecastWorkbench.tsx'
const hash = (s) => createHash('sha256').update(s).digest('hex')
const now = Date.parse('2026-10-08T12:00:00.000Z'),
  owner = `0x${'b'.repeat(40)}`
const observations = ['local-carry-cash-v1', 'local-carry-supplemental-aave-usde-cash-v1'].flatMap(
  (name) => {
    const root = `data/research/venue-signals/${name}`
    return readdirSync(root)
      .filter((n) => /^\d{12}\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(`${root}/${n}`, 'utf8')))
      .map((r) => ({
        collectionMode: r.collectionMode,
        anchorAt: r.anchorAt,
        firstLocalReceiptAt: r.firstLocalReceiptAt,
        receiptSha256: r.sha256,
        manifestSha256: r.manifestSha256 ?? r.rows[0].subjectManifestSha256,
        source: { block: r.block, blockHash: r.blockHash, blockAt: r.blockAt },
        subjects: r.rows,
      }))
  },
)
const candidates = new Map()
for (const observation of observations)
  for (const row of observation.subjects) {
    const spec = holder.resolveConditionalHolderSampledCashSubject(row.routeKey, row.destination)
    if (spec) candidates.set(`${row.routeKey}\0${row.destination}`, spec)
  }
function fixture(
  spec = candidates.get('USDC → VaultV2 [USDC]\0' + '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96'),
  cashRaw = '1000000000000000000000000000000',
  q,
) {
  const id = sampled.registeredConditionalSampledCashIdentity(
    spec.routeKey,
    spec.destinationAddress,
  )
  const selected = observations.filter((o) =>
    o.subjects.some((r) => r.routeKey === id.routeKey && r.destination === id.destination),
  )
  const t = timeline.localHistoricalSampledCashTimeline(selected, {
    route_key: id.routeKey,
    destination: id.destination,
    asset: id.asset,
  })
  assert.equal(t.status, 'sampled_timeline')
  const history = sampled.conditionalSampledCashHistoryFromVerifiedTimeline(selected, t)
  const source = {
    ...id,
    chainId: 1,
    cashRaw,
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(now - 1000).toISOString(),
    readAt: new Date(now).toISOString(),
    sourceKind: 'live_read_only_two_origin_finalized',
  }
  const expected = {
    currentSource: source,
    owner,
    requestedRaw: q ?? (10n ** BigInt(id.assetDecimals)).toString(),
    horizonHours: 24,
    asOfMs: now,
  }
  const cashProjection = sampled.buildConditionalSampledCashPathProjection(
    {
      history,
      currentSource: source,
      request: { requestedRaw: expected.requestedRaw, asOf: new Date(now).toISOString() },
    },
    hash,
  )
  assert.equal(cashProjection.status, 'estimated')
  const assessment = {
    status: 'assessed',
    routeKey: id.routeKey,
    destinationAddress: id.destination,
    owner,
    request: { assetsRaw: expected.requestedRaw, assetAddress: id.asset, horizonHours: 24 },
    source: {
      chainId: 1,
      blockNumber: Number(source.block),
      blockHash: source.blockHash,
      blockTime: source.blockTime,
      originValidation: 'two_provider',
    },
    stages: [
      {
        name: 'withdrawal',
        status: 'simulated',
        relatedToRequest: true,
        assetAddress: id.asset,
        amountRaw: expected.requestedRaw,
      },
    ],
    finalPayout: { status: 'simulated', assetAddress: id.asset, amountRaw: expected.requestedRaw },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
  const question = {
    routeKey: id.routeKey,
    destinationAddress: id.destination,
    owner,
    finalAssetAddress: id.asset,
    finalAssetDecimals: id.assetDecimals,
    assetsRaw: expected.requestedRaw,
  }
  const executionAgreement = {
    question,
    routeAndContractIdentityVerified: true,
    inputAndFinalAssetAddressesVerified: true,
    simulations: ['one.example', 'two.example'].map((originHost) => ({
      question: { ...question },
      originHost,
      source: { ...assessment.source, finalized: true },
      kind: 'full_route_execution',
      execution: 'single_call',
      fullRouteExecutionVerified: true,
      requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
      finalAssetAmountRaw: expected.requestedRaw,
      status: 'simulated',
    })),
  }
  return { value: { cashProjection, assessment, executionAgreement }, expected }
}
const select = (f) =>
  holder.selectedConditionalHolderSampledCashProjection(f.value, f.expected, hash)
function props(f) {
  const s = f.expected.currentSource
  return {
    routeKey: s.routeKey,
    destination: s.destination,
    requestedRaw: f.expected.requestedRaw,
    requestedAssetSymbol: s.assetDecimals === 6 ? 'USDC' : 'TOKEN',
    requestedAssetAddress: s.asset,
    requestedAssetDecimals: s.assetDecimals,
    requestedHolderAddress: owner,
    horizonHours: 24,
    asOfMs: now,
    currentCash: {
      routeKey: s.routeKey,
      destination: s.destination,
      cashRaw: s.cashRaw,
      assetAddress: s.asset,
      assetDecimals: s.assetDecimals,
      assetSymbol: 'USDC',
      observedAt: s.blockTime,
      block: s.block,
      blockHash: s.blockHash,
      freshness: 'fresh',
      label: 'Vault cash',
      sourceKind: s.sourceKind,
      readAtUtc: s.readAt,
    },
    conditionalSampledCashPathProjection: f.value.cashProjection,
    holderAssessment: { ...f.value.assessment, executionAgreement: f.value.executionAgreement },
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    prospectiveCashModel: null,
    historicalScenario: null,
    eventContext: null,
    historicalOutlook: null,
  }
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(card.ExitPressureCard, p)),
  ).replace(/<style[\s\S]*?<\/style>/g, '')
test('all59 original atomic native subjects plus supplemental1 compose with exact native units and both bracket endpoints', () => {
  assert.equal(candidates.size, 60)
  for (const spec of candidates.values()) {
    const f = fixture(spec),
      r = select(f)
    assert.ok(r, spec.routeKey + ' ' + spec.destinationAddress)
    assert.equal(r.horizons.length, 7)
    assert.deepEqual(r.cashProjection.scenarios, f.value.cashProjection.scenarios)
    assert.ok([15, 17].includes(r.cashProjection.scenarios.length))
    assert.equal(r.holderFailureForecast, false)
    assert.ok(
      r.horizons.every(
        (h) =>
          h.mechanicalEligibility.notBeforeAt === f.expected.currentSource.blockTime &&
          h.mechanicalEligibility.windowEndInclusiveAt === null,
      ),
    )
    assert.equal(r.holderExecutableExit, false)
    assert.equal(r.cashMeasure, 'aggregate_underlying_balance_endpoint_proxy_not_max_withdraw')
    assert.ok(
      r.horizons.every(
        (h) =>
          h.mechanicalEligibility.earliest === 'conditional_by_target' &&
          h.mechanicalEligibility.latest === 'conditional_by_target',
      ),
    )
  }
})
test('negative idle-cash headroom preserves original Q-once math and never claims holder failure', () => {
  const f = fixture(undefined, '1', '1000000000000000000000000000000'),
    r = select(f)
  assert.ok(r)
  assert.equal(
    r.horizons[0].userHeadroom.p10Raw,
    f.value.cashProjection.horizons[0].userHeadroom.p10Raw,
  )
  assert.ok(r.horizons[0].userHeadroom.p10Raw.startsWith('-'))
  assert.equal(r.holderFailureForecast, false)
  const before = structuredClone(f)
  select(f)
  assert.deepEqual(f, before)
})
for (const [name, mutate] of Object.entries({
  owner: (f) => (f.expected.owner = `0x${'c'.repeat(40)}`),
  q: (f) => (f.expected.requestedRaw = '2'),
  units: (f) => (f.expected.currentSource.assetDecimals = 18),
  hash: (f) => (f.expected.currentSource.blockHash = `0x${'c'.repeat(64)}`),
  cash: (f) => (f.expected.currentSource.cashRaw = '2'),
  oldRender: (f) => (f.expected.asOfMs = now + 1800001),
  expiredTarget: (f) =>
    (f.expected.asOfMs = Date.parse(f.value.cashProjection.horizons[0].target.earliestAt)),
  horizon: (f) => (f.expected.horizonHours = 1),
  unverifiedCurrent: (f) => (f.expected.currentSource.sourceKind = 'local'),
  wrongHolder: (f) => (f.value.assessment.owner = `0x${'c'.repeat(40)}`),
  auxShares: (f) => (f.value.assessment.request.sharesRaw = '1'),
  auxTicket: (f) => (f.value.assessment.request.receiptTokenId = '1'),
  singleOrigin: (f) => (f.value.executionAgreement.simulations[1].originHost = 'one.example'),
  missingStage: (f) => (f.value.executionAgreement.simulations[0].requiredStages = []),
  forgedStage: (f) =>
    (f.value.executionAgreement.simulations[0].requiredStages[0].status = 'condition_satisfied'),
  foreignProofUnits: (f) => (f.value.executionAgreement.question.finalAssetDecimals = 18),
  incompleteExecution: (f) =>
    (f.value.executionAgreement.simulations[0].fullRouteExecutionVerified = false),
  foreignProofHash: (f) =>
    (f.value.executionAgreement.simulations[0].source.blockHash = `0x${'c'.repeat(64)}`),
  foreignFinal: (f) => (f.value.assessment.finalPayout.assetAddress = `0x${'c'.repeat(40)}`),
  proxyMathForge: (f) => (f.value.cashProjection.horizons[0].userHeadroom.p10Raw = '1'),
  unsafeBlock: (f) => (f.expected.currentSource.block = { toString: () => '26190000' }),
}))
  test(`${name} drops only holder composition`, () => {
    const f = fixture()
    mutate(f)
    assert.equal(select(f), null)
  })
test('staged native and four foreign-final routes are not issued as atomic cash subjects', () => {
  for (const [r, d] of [
    ['apxUSD → ApyUSD [apxUSD]', '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'],
    ['AUSD → Staked USDat [USDat]', '0xd166337499e176bbc38a1fbd113ab144e5bd2df7'],
    ['PYUSD → StakingVault [wYLDS]', '0x19ebb35279a16207ec4ba82799cc64715065f7f6'],
    [
      'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
      '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    ],
    ['USDT → FluidBridgeAggregatorProxy [USDC]', '0x273da948aca9261043fbdb2a857bc255ecc29012'],
  ])
    assert.equal(holder.resolveConditionalHolderSampledCashSubject(r, d), null)
})
test('card strengthens existing cash row accessibly while preserving proxy wording and negative range', () => {
  const f = fixture(undefined, '1', '1000000000000000000000000000000'),
    p = props(f),
    html = render(p)
  assert.match(html, /aria-label="Projected cash headroom, holder checked at source"/)
  assert.match(html, /Projected cash headroom/)
  assert.doesNotMatch(html, /Projected exit headroom/)
  assert.match(html, /-/)
  assert.equal((html.match(/Projected cash headroom<\/span>/g) || []).length, 1)
  const invalid = structuredClone(p)
  invalid.holderAssessment.executionAgreement.simulations[1].originHost = 'one.example'
  const fallback = render(invalid)
  assert.doesNotMatch(fallback, /holder checked at source/)
  assert.match(fallback, /Projected cash headroom/)
})
test('Workbench pins supported atomic non-Aave questions to independent source and rejects staged/cross-Q data', () => {
  const f = fixture(),
    p = props(f),
    q = {
      routeKey: p.routeKey,
      destination: p.destination,
      requestedRaw: p.requestedRaw,
      requestedAssetAddress: p.requestedAssetAddress,
      requestedAssetDecimals: p.requestedAssetDecimals,
      horizonHours: 24,
      asOfMs: now,
    }
  assert.deepEqual(
    wb.matchingHolderForecastSourceReference(
      null,
      q,
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    ),
    {
      blockNumber: Number(p.currentCash.block),
      blockHash: p.currentCash.blockHash,
      blockTime: p.currentCash.observedAt,
    },
  )
  assert.equal(
    wb.matchingHolderForecastSourceReference(
      null,
      { ...q, requestedRaw: '2' },
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    ),
    null,
  )
  assert.equal(
    wb.matchingHolderForecastSourceReference(
      null,
      { ...q, routeKey: 'apxUSD → ApyUSD [apxUSD]' },
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    ),
    null,
  )
})

test('source freshness is inclusive at30minutes and expires at the next millisecond', () => {
  const f = fixture(),
    boundary = Date.parse(f.expected.currentSource.blockTime) + 1800000
  f.expected.asOfMs = boundary
  assert.ok(select(f))
  f.expected.asOfMs = boundary + 1
  assert.equal(select(f), null)
})
test('18decimal native units preserve range formatting and invalid holder leaves the daily cash row', () => {
  const spec = [...candidates.values()].find((s) => s.routeKey === 'USDS → StUsds [USDS]')
  const f = fixture(spec),
    p = props(f),
    html = render(p)
  assert.match(html, /holder checked at source/)
  assert.match(html, /Projected cash headroom/)
  p.requestedHolderAddress = `0x${'c'.repeat(40)}`
  const fallback = render(p)
  assert.doesNotMatch(fallback, /holder checked at source/)
  assert.match(fallback, /Projected cash headroom/)
})
