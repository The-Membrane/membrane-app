import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import card from '../../components/Carry/ExitPressureCard.tsx'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import forecast from '../../pages/api/carry/forecast.ts'
import capacity from '../../lib/carry/holderExitCapacity.ts'
const routeKey = 'USDC → USD3 [USDC]',
  destination = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  owner = '0x' + 'b'.repeat(40),
  q = '1000000'
const root = 'data/research/venue-signals/local-carry-cash-v1'
let receipt
for (const name of readdirSync(root)
  .filter((n) => /^\d{12}\.json$/.test(n))
  .sort()
  .reverse()) {
  const r = JSON.parse(readFileSync(root + '/' + name, 'utf8'))
  if (r.collectionMode === 'current') {
    receipt = r
    break
  }
}
assert.ok(receipt)
// A dated unit fixture clock from genuine sealed evidence; no live runtime claim.
const now = Math.max(Date.parse(receipt.firstLocalReceiptAt), Date.parse(receipt.blockAt)) + 1000
assert.ok(now - Date.parse(receipt.blockAt) <= 1800000)
const payloads = new Map()
async function actualPayload(horizonHours) {
  if (payloads.has(horizonHours)) return payloads.get(horizonHours)
  const oldNow = Date.now,
    oldFetch = globalThis.fetch,
    oldEnv = process.env.NODE_ENV
  Date.now = () => now
  globalThis.fetch = () => {
    throw Error('offline test forbids RPC')
  }
  process.env.NODE_ENV = 'development'
  let body, code
  try {
    await forecast.carryForecastRequest(
      {
        method: 'GET',
        query: {
          routeKey,
          destination,
          amountUnits: '1',
          horizonHours: String(horizonHours),
          includeLiveCurrent: '0',
        },
        socket: { remoteAddress: '127.0.0.1' },
      },
      {
        setHeader() {},
        status(n) {
          code = n
          return this
        },
        json(v) {
          body = v
          return this
        },
      },
      async () => ({ status: 'unavailable' }),
      async () => ({ status: 'unavailable' }),
    )
  } finally {
    Date.now = oldNow
    globalThis.fetch = oldFetch
    if (oldEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = oldEnv
  }
  assert.equal(code, 200)
  assert.equal(body.conditionalSampledCashPathProjection.status, 'estimated')
  payloads.set(horizonHours, body)
  return body
}
function props(body, H = 24, full = '3000000', nativeLimit) {
  const c = body.sampledCashPaths.current
  const current = workbench.withBoundSampledCashCurrentMetadata(
    {
      routeKey,
      destination,
      assetAddress: asset,
      assetDecimals: 6,
      assetSymbol: 'USDC',
      cashRaw: c.cashRaw,
      block: c.block,
      blockHash: c.blockHash,
      observedAt: c.blockAt,
      freshness: 'fresh',
      label: 'Vault cash',
    },
    c,
  )
  const source = {
    chainId: 1,
    blockNumber: Number(c.block),
    blockHash: c.blockHash,
    blockTime: c.blockAt,
    finalized: true,
  }
  const a = {
    status: 'partial',
    routeKey,
    destinationAddress: destination,
    owner,
    request: { assetsRaw: q, assetAddress: asset, horizonHours: H },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        assetAddress: asset,
        amountRaw: q,
        relatedToRequest: true,
        status: 'reverted',
      },
    ],
    finalPayout: { status: 'unassessed', assetAddress: asset, amountRaw: null },
  }
  const facts = {
    entitlementRaw: full,
    quotedMaxWithdrawRaw: '2000000',
    quotedMaxWithdrawStatus: 'quoted',
    effectiveLimitRaw: null,
    withdrawalsPaused: null,
    ...(nativeLimit === undefined
      ? {}
      : {
          usd3NativeCapacity: {
            owner,
            method: 'availableWithdrawLimit(address)',
            asset,
            assetDecimals: 6,
            unit: 'raw_usdc_6',
            capacityRaw: nativeLimit,
            resultStatus: 'quoted',
            source,
            runtimeProfile: null,
          },
        }),
  }
  const quote = capacity.buildHolderExitCapacityQuote(a, facts, now)
  assert.ok(quote)
  const agreement = capacity.agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    now,
  )
  assert.ok(agreement)
  const p = {
    routeKey,
    destination,
    requestedAmount: '1',
    requestedRaw: q,
    requestedAssetAddress: asset,
    requestedAssetDecimals: 6,
    requestedAssetSymbol: 'USDC',
    requestedHolderAddress: owner,
    horizonHours: H,
    asOfMs: now,
    currentCash: current,
    conditionalSampledCashPathProjection: body.conditionalSampledCashPathProjection,
    holderCapacityAgreement: agreement,
    holderAssessment: null,
  }
  const pin = workbench.matchingHolderForecastSourceReference(
    null,
    p,
    current,
    body.conditionalSampledCashPathProjection,
  )
  assert.deepEqual(pin, {
    blockNumber: Number(c.block),
    blockHash: c.blockHash,
    blockTime: c.blockAt,
  })
  p.holderTimeProcessIssue = workbench.holderTimeProcessIssueFromResponse(
    { error: 'holder_exit_assessment_unavailable', capacityAgreement: agreement },
    503,
    p,
    current,
    body.conditionalSampledCashPathProjection,
    pin,
  )
  assert.ok(p.holderTimeProcessIssue)
  assert.equal(p.holderTimeProcessIssue.issuedAtMs, now)
  return p
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(card.ExitPressureCard, p)),
  )
function assertNoFundingHeadline(html) {
  assert.ok(!html.includes('Projected funding headroom'))
  assert.ok(!html.includes('Projected exit headroom'))
  assert.ok(!html.includes('Projected cash headroom'))
  assert.ok(!html.includes('Projected headroom'))
}
function selectedCurrentCapacity(p) {
  return capacity.selectedHolderExitCapacity(p.holderCapacityAgreement, {
    routeKey,
    destination,
    owner: p.requestedHolderAddress,
    requestedRaw: p.requestedRaw,
    asset,
    assetDecimals: 6,
    currentSource: p.holderCapacityAgreement.quote.source,
    asOfMs: p.asOfMs,
  })
}
test('USD3 H1/H24/H48/H168 idle history preserves cash diagnostics without funding or generic fallback bands', async () => {
  for (const H of [1, 24, 48, 168]) {
    const p = props(await actualPayload(H), H, '1000000000000000000000000000000')
    const cash = card.selectedUsd3CashForCard(
      p.conditionalSampledCashPathProjection,
      p,
      p.currentCash,
    )
    assert.ok(cash)
    assert.equal(cash.cashMeasure, 'aggregate_underlying_balance_endpoint_proxy_not_max_withdraw')
    const html = render(p)
    assertNoFundingHeadline(html)
    assert.ok(html.includes('Vault cash'))
    assert.ok(html.includes(`${card.formatExitPressureRaw(p.currentCash.cashRaw, 6)} USDC`))
    assert.ok(selectedCurrentCapacity(p))
  }
})
test('current native withdrawal limit remains qualified separately from idle cash and cannot create a historical band', async () => {
  for (const limit of ['1950000000000', '5290000000000']) {
    const p = props(await actualPayload(48), 48, '3000000', limit)
    p.requestedAssetSymbol = 'USD3'
    const selected = selectedCurrentCapacity(p)
    assert.ok(selected)
    assert.equal(selected.quote.usd3NativeCapacity.capacityRaw, limit)
    assert.equal(selected.quote.usd3NativeCapacity.method, 'availableWithdrawLimit(address)')
    assert.equal(selected.quote.entitlementRaw, '3000000')
    const html = render(p)
    assertNoFundingHeadline(html)
    assert.ok(html.includes('Vault cash'))
    assert.ok(html.includes(`${card.formatExitPressureRaw(p.currentCash.cashRaw, 6)} USDC`))
    assert.equal(p.currentCash.cashRaw, (await actualPayload(48)).sampledCashPaths.current.cashRaw)
  }
})
test('independent E insufficiency does not turn idle diagnostics into a negative funding forecast', async () => {
  const p = props(await actualPayload(24), 24, '500000')
  assert.equal(selectedCurrentCapacity(p).quote.entitlementRaw, '500000')
  const html = render(p)
  assertNoFundingHeadline(html)
  assert.ok(html.includes('Vault cash'))
})
test('wrong owner/source/entitlement, stale current and wrong decimals never promote holder funding', async () => {
  const base = props(await actualPayload(24))
  for (const mutate of [
    (p) => (p.requestedHolderAddress = '0x' + 'c'.repeat(40)),
    (p) => (p.holderCapacityAgreement.quote.source.blockHash = '0x' + 'c'.repeat(64)),
    (p) => (p.holderCapacityAgreement.origins[1].quote.entitlementRaw = '1'),
    (p) => (p.currentCash.freshness = 'stale'),
    (p) => (p.requestedAssetDecimals = 18),
    (p) => (p.asOfMs += 1800001),
  ]) {
    const p = structuredClone(base)
    mutate(p)
    assert.ok(!render(p).includes('aria-label="Projected funding headroom"'))
  }
})

test('later rendering retains the idle diagnostic and never issues a funding target or band', async () => {
  const p = props(await actualPayload(48), 48)
  const originalIssue = structuredClone(p.holderTimeProcessIssue)
  assertNoFundingHeadline(render(p))
  const later = structuredClone(p)
  later.asOfMs += 60000
  assertNoFundingHeadline(render(later))
  assert.ok(render(later).includes('Vault cash'))
  assert.deepEqual(later.holderTimeProcessIssue, originalIssue)
  later.asOfMs = Date.parse(p.currentCash.observedAt) + 1800001
  assertNoFundingHeadline(render(later))
})
test('a forged legacy idle funding headline cannot render through the sampled-cash input', async () => {
  const p = props(await actualPayload(24))
  const diagnostic = structuredClone(p.currentCash)
  p.conditionalSampledCashPathProjection = {
    status: 'conditional_usd3_holder_capacity_projection',
    scope: 'entitlement_clipped_cash_coverage_only',
    fullPositionEntitlementRaw: '3000000',
    horizons: [
      {
        capacity: { minimumRaw: '0', maximumRaw: '0' },
        userHeadroom: { p10Raw: '-1000000', p90Raw: '-1000000' },
      },
    ],
    holderExecutableExit: false,
    forecastValidated: false,
  }
  assert.equal(
    card.selectedUsd3CashForCard(p.conditionalSampledCashPathProjection, p, p.currentCash),
    null,
  )
  assertNoFundingHeadline(render(p))
  assert.ok(render(p).includes('Vault cash'))
  assert.deepEqual(p.currentCash, diagnostic)
})
test('missing or mismatched issued owner/Q/H/source or future issue suppresses USD3 funding', async () => {
  const base = props(await actualPayload(24))
  for (const mutate of [
    (p) => (p.holderTimeProcessIssue = null),
    (p) => (p.holderTimeProcessIssue.owner = '0x' + 'c'.repeat(40)),
    (p) => (p.holderTimeProcessIssue.requestedRaw = '2000000'),
    (p) => (p.holderTimeProcessIssue.horizonHours = 48),
    (p) => (p.holderTimeProcessIssue.block = '1'),
    (p) => (p.holderTimeProcessIssue.blockHash = '0x' + 'c'.repeat(64)),
    (p) => (p.holderTimeProcessIssue.issuedAtMs = p.asOfMs + 60000),
    (p) => (p.horizonHours = 48),
    (p) => (p.requestedRaw = '2000000'),
  ]) {
    const p = structuredClone(base)
    mutate(p)
    assert.ok(!render(p).includes('aria-label="Projected funding headroom"'))
  }
})
