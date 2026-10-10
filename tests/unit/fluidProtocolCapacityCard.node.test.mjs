import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import cardModule from '../../components/Carry/ExitPressureCard.tsx'
import fluidModule from '../../lib/carry/fluidProtocolCapacityProjection.ts'
const { ExitPressureCard } = cardModule,
  { buildFluidProtocolCapacityProjection } = fluidModule
const receipt = JSON.parse(
  readFileSync(
    'data/research/venue-signals/fluid-protocol-capacity-current-usdc-2026-10-07T11-15.json',
    'utf8',
  ),
)
const hash = (s) => createHash('sha256').update(s).digest('hex'),
  now = Date.parse('2026-10-07T11:24:00.000Z')
function props() {
  const id = receipt.subject,
    source = receipt.source,
    readAt = '2026-10-07T11:23:00.000Z'
  const projection = buildFluidProtocolCapacityProjection(
    {
      currentProngs: receipt.prongs,
      currentReadAtUtc: readAt,
      requestedRaw: '1000000000',
      horizonHours: 24,
      asOfMs: now,
    },
    hash,
  )
  assert.ok(projection)
  return {
    routeKey: id.routeKey,
    destination: id.destination,
    requestedAmount: '1000',
    requestedRaw: '1000000000',
    requestedAssetSymbol: 'USDC',
    requestedAssetAddress: id.asset,
    requestedAssetDecimals: 6,
    horizonHours: 24,
    asOfMs: now,
    currentCash: {
      routeKey: id.routeKey,
      destination: id.destination,
      cashRaw: '0',
      assetAddress: id.asset,
      assetDecimals: 6,
      assetSymbol: 'USDC',
      observedAt: source.blockTime,
      block: String(source.blockNumber),
      blockHash: source.blockHash,
      freshness: 'fresh',
      label: 'Vault cash',
      sourceKind: 'live_read_only_two_origin_finalized',
      readAtUtc: receipt.capturedAt,
    },
    fluidProtocolCapacityProjection: projection,
    fluidProtocolCapacityProngs: { currentProngs: receipt.prongs, readAtUtc: readAt },
    holderAssessment: null,
    prospectiveCashModel: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    expectedEventEnrollment: null,
    eventContext: null,
    historicalOutlook: null,
  }
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(ExitPressureCard, p)),
  )
test('single donor displays protocol headroom and genuine3h target, no holder/current execution claim', () => {
  const html = render(props())
  assert.ok(html.includes('aria-label="Projected protocol headroom"'))
  assert.ok(html.includes('1 episode'))
  assert.ok(html.includes('10-07 13:57:47'))
  assert.ok(!html.includes('P10'))
  assert.ok(!html.includes('Projected exit headroom'))
  assert.ok(!html.includes('holder checked at source'))
})
test('independent current identity/Q/source/prongs/expiry reject protocol row separately', () => {
  for (const mutate of [
    (p) => (p.currentCash.assetAddress = '0x' + '1'.repeat(40)),
    (p) => (p.currentCash.destination = '0x' + '1'.repeat(40)),
    (p) => (p.currentCash.assetDecimals = 18),
    (p) => (p.currentCash.blockHash = '0x' + '1'.repeat(64)),
    (p) => (p.currentCash.sourceKind = 'manifest_bound_two_origin_ledger'),
    (p) => (p.requestedRaw = '1'),
    (p) => (p.fluidProtocolCapacityProngs = null),
    (p) => (p.asOfMs = Date.parse(receipt.source.blockTime) + 1800001),
  ]) {
    const p = structuredClone(props())
    mutate(p)
    assert.ok(!render(p).includes('aria-label="Projected protocol headroom"'))
  }
})

test('declared source headers require actual fresh clock witnesses', () => {
  for (const mutate of [
    (p) => delete p.currentCash.readAtUtc,
    (p) => (p.currentCash.readAtUtc = [receipt.capturedAt]),
    (p) => (p.currentCash.readAtUtc = new Date(now + 1).toISOString()),
    (p) => (p.currentCash.freshness = 'stale'),
    (p) => {
      p.currentCash.sourceKind = 'manifest_bound_ledger'
      delete p.currentCash.readAtUtc
    },
    (p) => {
      p.currentCash.sourceKind = 'manifest_bound_ledger'
      p.currentCash.firstLocalReceiptAt = receipt.capturedAt
      p.currentCash.manifestSha256 = 'a'.repeat(64)
      p.currentCash.receiptSha256 = 'b'.repeat(64)
    },
  ]) {
    const p = structuredClone(props())
    mutate(p)
    assert.ok(!render(p).includes('aria-label="Projected protocol headroom"'))
  }
})

const capacityImports = await import('../../lib/carry/holderExitCapacity.ts')
const capacityModule = capacityImports.default ?? capacityImports
const workbenchImports = await import('../../components/Carry/ForecastWorkbench.tsx')
const workbench = { ...workbenchImports.default, ...workbenchImports }
const owner = '0x' + 'b'.repeat(40)
function addHolder(p, E = '1500000000') {
  const s = receipt.source,
    id = receipt.subject
  const quote = capacityModule.buildHolderExitCapacityQuote(
    {
      status: 'assessed',
      routeKey: p.routeKey,
      destinationAddress: p.destination,
      owner,
      request: { assetsRaw: p.requestedRaw, assetAddress: id.asset, horizonHours: p.horizonHours },
      source: { ...s, originValidation: 'two_provider' },
      stages: [
        {
          name: 'withdrawal',
          assetAddress: id.asset,
          amountRaw: p.requestedRaw,
          relatedToRequest: true,
          status: 'reverted',
        },
      ],
      finalPayout: { status: 'unassessed', assetAddress: id.asset, amountRaw: null },
    },
    {
      entitlementRaw: E,
      quotedMaxWithdrawRaw: '1',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    p.asOfMs,
  )
  assert.ok(quote)
  p.holderCapacityAgreement = capacityModule.agreeHolderExitCapacityQuotes(
    { host: 'eth-mainnet.g.alchemy.com', quote },
    { host: 'rpc.ankr.com', quote },
    p.asOfMs,
  )
  p.requestedHolderAddress = owner
  return p
}
test('Fluid holder entitlement clips joint protocol prongs before Q once despite Q execution unknown', () => {
  for (const E of ['1500000000', '500000000']) {
    const p = addHolder(props(), E),
      before = structuredClone(p),
      html = render(p)
    assert.ok(html.includes('aria-label="Projected exit headroom"'))
    assert.ok(!html.includes('aria-label="Projected protocol headroom"'))
    assert.ok(
      html.includes(
        cardModule.formatExitPressureSignedRaw((BigInt(E) - BigInt(p.requestedRaw)).toString(), 6),
      ),
    )
    assert.deepEqual(p, before)
  }
})
test('Fluid wrong owner or capacity evidence retains protocol fallback; anyH source pin is exact', () => {
  const p = addHolder(props())
  p.requestedHolderAddress = '0x' + 'c'.repeat(40)
  assert.ok(render(p).includes('aria-label="Projected protocol headroom"'))
  const q = props()
  q.horizonHours = 1
  q.fluidProtocolCapacityProjection = buildFluidProtocolCapacityProjection(
    {
      currentProngs: receipt.prongs,
      currentReadAtUtc: q.fluidProtocolCapacityProngs.readAtUtc,
      requestedRaw: q.requestedRaw,
      horizonHours: 1,
      asOfMs: q.asOfMs,
    },
    hash,
  )
  const question = {
    routeKey: q.routeKey,
    destination: q.destination,
    requestedRaw: q.requestedRaw,
    requestedAssetAddress: q.requestedAssetAddress,
    requestedAssetDecimals: 6,
    horizonHours: 1,
    asOfMs: q.asOfMs,
  }
  assert.deepEqual(
    workbench.matchingHolderForecastSourceReference(null, question, q.currentCash, null, q),
    {
      blockNumber: receipt.source.blockNumber,
      blockHash: receipt.source.blockHash,
      blockTime: receipt.source.blockTime,
    },
  )
})
