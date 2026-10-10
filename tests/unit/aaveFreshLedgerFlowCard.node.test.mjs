import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import card from '../../components/Carry/ExitPressureCard.tsx'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import gross from '../../lib/carry/conditionalGrossFlowHeadroom.ts'
import flow from '../../lib/carry/historicalCompetingFlowEstimate.ts'
import sampled from '../../lib/carry/conditionalSampledCashPathProjection.ts'
import timeline from '../../lib/carry/localHistoricalSampledCashTimeline.ts'
const hash = (s) => createHash('sha256').update(s).digest('hex')
const root = 'data/research/venue-signals/local-carry-cash-v1'
const records = readdirSync(root)
  .filter((n) => /^\d{12}\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(`${root}/${n}`, 'utf8')))
const observations = records.map((r) => ({
  collectionMode: r.collectionMode,
  anchorAt: r.anchorAt,
  firstLocalReceiptAt: r.firstLocalReceiptAt,
  receiptSha256: r.sha256,
  manifestSha256: r.manifestSha256,
  source: { block: r.block, blockAt: r.blockAt, blockHash: r.blockHash },
  subjects: r.rows,
}))
const receipt = records
  .filter((r) => r.collectionMode === 'current')
  .sort((a, b) => b.blockAt.localeCompare(a.blockAt))[0]
const id = flow.AAVE_COMPETING_FLOW_IDENTITY,
  now = Date.parse(receipt.firstLocalReceiptAt)
const saved = receipt.rows.find(
  (r) => r.routeKey === id.routeKey && r.destination === id.destination,
)
const summary = JSON.parse(
  readFileSync(
    new URL(
      '../../data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
)
function props() {
  const t = timeline.localHistoricalSampledCashTimeline(observations, {
    route_key: id.routeKey,
    destination: id.destination,
    asset: id.asset,
  })
  assert.equal(t.status, 'sampled_timeline')
  const history = sampled.conditionalSampledCashHistoryFromVerifiedTimeline(observations, t)
  const source = {
    ...id,
    chainId: 1,
    cashRaw: saved.cashRaw,
    block: receipt.block,
    blockHash: receipt.blockHash,
    blockTime: receipt.blockAt,
    readAt: receipt.firstLocalReceiptAt,
    sourceKind: 'manifest_bound_ledger',
    manifestSha256: receipt.manifestSha256,
    receiptSha256: receipt.sha256,
  }
  const request = { requestedRaw: '1000000', asOf: new Date(now).toISOString() }
  const daily = sampled.buildConditionalSampledCashPathProjection(
    { history, currentSource: source, request },
    hash,
  )
  assert.equal(daily.status, 'estimated')
  const projection = gross.buildConditionalGrossFlowHeadroom(
    {
      currentSource: {
        chainId: 1,
        ...id,
        cashRaw: saved.cashRaw,
        blockNumber: Number(receipt.block),
        blockHash: receipt.blockHash,
        blockTime: receipt.blockAt,
        readAt: receipt.firstLocalReceiptAt,
        finalized: true,
      },
      request,
      historicalFlow: flow.buildHistoricalCompetingFlowEstimate(summary, hash),
    },
    hash,
  )
  assert.equal(projection.status, 'estimated')
  return {
    routeKey: id.routeKey,
    destination: id.destination,
    requestedAmount: '1',
    requestedRaw: '1000000',
    requestedAssetSymbol: 'USDC',
    requestedAssetAddress: id.asset,
    requestedAssetDecimals: 6,
    horizonHours: 24,
    asOfMs: now,
    currentCash: {
      routeKey: id.routeKey,
      destination: id.destination,
      cashRaw: saved.cashRaw,
      assetAddress: id.asset,
      assetDecimals: 6,
      assetSymbol: 'USDC',
      observedAt: receipt.blockAt,
      block: receipt.block,
      blockHash: receipt.blockHash,
      freshness: 'fresh',
      label: 'Market cash',
      sourceKind: source.sourceKind,
      firstLocalReceiptAt: source.readAt,
      manifestSha256: source.manifestSha256,
      receiptSha256: source.receiptSha256,
    },
    conditionalGrossFlowHeadroom: projection,
    conditionalSampledCashPathProjection: daily,
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
const question = (p) => ({
  routeKey: p.routeKey,
  destination: p.destination,
  requestedRaw: p.requestedRaw,
  requestedAssetAddress: p.requestedAssetAddress,
  requestedAssetDecimals: p.requestedAssetDecimals,
  horizonHours: p.horizonHours,
  asOfMs: p.asOfMs,
})
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(card.ExitPressureCard, p)),
  )
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
test('fresh genuine ledger witness admits preferred Aave joint-flow range without fabricated live readAt', () => {
  const p = props(),
    text = render(p)
  assert.match(text, /Projected headroom/)
  assert.doesNotMatch(text, /Projected cash headroom|Projected exit headroom/)
  const r = p.conditionalGrossFlowHeadroom
  assert.ok(
    text.includes(
      `${card.formatExitPressureSignedRaw(r.userHeadroom.p10Raw, 6)}–${card.formatExitPressureSignedRaw(r.userHeadroom.p90Raw, 6)} USDC`,
    ),
  )
  assert.equal(p.currentCash.readAtUtc, undefined)
  assert.equal(p.currentCash.sourceKind, 'manifest_bound_ledger')
  assert.equal(r.currentSource.readAt, receipt.firstLocalReceiptAt)
})
test('holder POST source reference admits independently selected native local C2', () => {
  const p = props()
  assert.deepEqual(
    workbench.matchingHolderForecastSourceReference(
      p.conditionalGrossFlowHeadroom,
      question(p),
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    ),
    {
      blockNumber: Number(receipt.block),
      blockHash: receipt.blockHash,
      blockTime: receipt.blockAt,
    },
  )
})
for (const name of [
  'missingDailyWitness',
  'foreignManifest',
  'foreignReceipt',
  'missingReceipt',
  'retimedRead',
  'futureReceipt',
  'Q',
  'hash',
  'units',
  'alias',
  'forgedGross',
])
  test(`never trusts projection selfmetadata for ${name}`, () => {
    const p = props()
    if (name === 'missingDailyWitness') delete p.conditionalSampledCashPathProjection
    if (name === 'foreignManifest') p.currentCash.manifestSha256 = 'b'.repeat(64)
    if (name === 'foreignReceipt') p.currentCash.receiptSha256 = 'b'.repeat(64)
    if (name === 'missingReceipt') delete p.currentCash.receiptSha256
    if (name === 'retimedRead') p.currentCash.firstLocalReceiptAt = new Date(now - 1).toISOString()
    if (name === 'futureReceipt')
      p.currentCash.firstLocalReceiptAt = new Date(now + 1).toISOString()
    if (name === 'Q') p.requestedRaw = '2000000'
    if (name === 'hash') p.currentCash.blockHash = `0x${'b'.repeat(64)}`
    if (name === 'units') p.currentCash.assetDecimals = 18
    if (name === 'alias') p.currentCash.sourceKind = 'local_sha_replayed_finalized_rpc'
    if (name === 'forgedGross') p.conditionalGrossFlowHeadroom.userHeadroom.p90Raw = '1'
    const text = render(p)
    assert.doesNotMatch(text, /Projected headroom|Projected exit headroom/)
    assert.match(text, /Market cash/)
    assert.equal(
      workbench.matchingHolderForecastSourceReference(
        p.conditionalGrossFlowHeadroom,
        question(p),
        p.currentCash,
        name === 'forgedGross' ? undefined : p.conditionalSampledCashPathProjection,
      ),
      null,
    )
  })
test('native source expires at30min plus1 without a new read clock or target retiming', () => {
  const p = props()
  p.asOfMs = Date.parse(receipt.blockAt) + 1800000
  assert.match(render(p), /Projected headroom/)
  const target = p.conditionalGrossFlowHeadroom.target.earliestAt
  p.asOfMs++
  assert.doesNotMatch(render(p), /Projected headroom|Projected cash headroom/)
  assert.equal(p.conditionalGrossFlowHeadroom.target.earliestAt, target)
})
test('same-source holder proof uses genuine local receipt clock and upgrades only the existing row', () => {
  const p = props(),
    owner = `0x${'c'.repeat(40)}`,
    source = {
      chainId: 1,
      blockNumber: Number(receipt.block),
      blockHash: receipt.blockHash,
      blockTime: receipt.blockAt,
      originValidation: 'two_provider',
    }
  const q = {
    routeKey: id.routeKey,
    destinationAddress: id.destination,
    owner,
    finalAssetAddress: id.asset,
    finalAssetDecimals: 6,
    assetsRaw: '1000000',
  }
  p.requestedHolderAddress = owner
  p.holderAssessment = {
    status: 'assessed',
    routeKey: id.routeKey,
    destinationAddress: id.destination,
    owner,
    request: { assetsRaw: '1000000', assetAddress: id.asset, horizonHours: 24 },
    source,
    stages: [
      {
        name: 'withdrawal',
        status: 'simulated',
        relatedToRequest: true,
        assetAddress: id.asset,
        amountRaw: '1000000',
      },
    ],
    finalPayout: { status: 'simulated', assetAddress: id.asset, amountRaw: '1000000' },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    executionAgreement: {
      question: q,
      routeAndContractIdentityVerified: true,
      inputAndFinalAssetAddressesVerified: true,
      simulations: ['one.example', 'two.example'].map((originHost) => ({
        question: { ...q },
        originHost,
        source: { ...source, finalized: true },
        kind: 'full_route_execution',
        execution: 'single_call',
        fullRouteExecutionVerified: true,
        requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
        finalAssetAmountRaw: '1000000',
        status: 'simulated',
      })),
    },
  }
  const text = render(p)
  assert.match(text, /Projected exit headroom/)
  assert.doesNotMatch(text, /Projected cash headroom/)
  p.requestedHolderAddress = `0x${'d'.repeat(40)}`
  assert.doesNotMatch(render(p), /Projected exit headroom/)
  assert.match(render(p), /Projected headroom/)
})
