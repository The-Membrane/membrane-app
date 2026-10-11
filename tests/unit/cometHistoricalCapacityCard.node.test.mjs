import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import card from '../../components/Carry/ExitPressureCard.tsx'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import forecast from '../../pages/api/carry/forecast.ts'
import capacity from '../../lib/carry/holderExitCapacity.ts'
import adapter from '../../lib/carry/cometHolderCapacityProjection.ts'
const hash = (s) => createHash('sha256').update(s).digest('hex')
const routeKey = 'USDC → supply on Compound v3',
  destination = '0xc3d688b66703497daa19211eedff47f25384cdc3'
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
function props(body, H = 24) {
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
    status: 'assessed',
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
  const quote = capacity.buildHolderExitCapacityQuote(
    a,
    {
      entitlementRaw: '3000000',
      quotedMaxWithdrawRaw: null,
      quotedMaxWithdrawStatus: 'not_read',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    now,
  )
  assert.ok(quote)
  const agreement = capacity.agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    now,
  )
  assert.ok(agreement)
  return {
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
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(card.ExitPressureCard, p)),
  )
function selected(p) {
  const cash = card.selectedCometCashForCard(
    p.conditionalSampledCashPathProjection,
    p,
    p.currentCash,
  )
  assert.ok(cash)
  const source = {
    chainId: 1,
    blockNumber: Number(cash.currentSource.block),
    blockHash: cash.currentSource.blockHash,
    blockTime: cash.currentSource.blockTime,
    finalized: true,
  }
  const input = {
    cashProjection: cash,
    cometFactsAgreement: p.holderCometFactsAgreement ?? null,
    capacityAgreement: p.holderCapacityAgreement,
    binding: {
      routeKey,
      destination,
      owner: p.requestedHolderAddress,
      requestedRaw: p.requestedRaw,
      asset,
      assetDecimals: 6,
      currentSource: source,
      asOfMs: p.asOfMs,
    },
    currentSource: cash.currentSource,
    horizonHours: p.horizonHours,
    asOfMs: p.asOfMs,
  }
  const built = adapter.buildCometHolderCapacityProjection(input, hash)
  assert.ok(built)
  return adapter.selectedCometHolderCapacityProjection(built, input, hash)
}
test('actual native API responses at H1/H24/H48 drive Comet source pin and supplied-E holder range', async () => {
  for (const H of [1, 24, 48]) {
    const body = await actualPayload(H),
      p = props(body, H),
      s = selected(p),
      g = s.horizons[0],
      html = render(p)
    assert.deepEqual(
      workbench.matchingHolderForecastSourceReference(
        null,
        p,
        p.currentCash,
        body.conditionalSampledCashPathProjection,
      ),
      {
        blockNumber: Number(body.sampledCashPaths.current.block),
        blockHash: body.sampledCashPaths.current.blockHash,
        blockTime: body.sampledCashPaths.current.blockAt,
      },
    )
    assert.ok(html.includes('aria-label="Projected exit headroom"'))
    assert.ok(
      html.includes(
        card.formatExitPressureSignedRaw(g.userHeadroom.p10Raw, 6) +
          '–' +
          card.formatExitPressureSignedRaw(g.userHeadroom.p90Raw, 6) +
          ' USDC',
      ),
    )
    assert.ok(
      html.includes(
        g.target.earliestAt.slice(5, 19).replace('T', ' ') +
          '–' +
          g.target.latestAt.slice(5, 19).replace('T', ' ') +
          ' UTC',
      ),
    )
    assert.equal(s.withdrawalsPaused, null)
    assert.equal(s.holderExecutableExit, false)
    assert.equal(s.forecastValidated, false)
    assert.equal(body.aaveSparkCapacityProjection, undefined)
    for (const mutate of [
      (x) => (x.requestedRaw = '2'),
      (x) => (x.currentCash.blockHash = '0x' + 'f'.repeat(64)),
      (x) => (x.asOfMs = Date.parse(x.currentCash.observedAt) + 1800001),
    ]) {
      const wrong = structuredClone(p)
      mutate(wrong)
      assert.equal(
        workbench.matchingHolderForecastSourceReference(
          null,
          wrong,
          wrong.currentCash,
          body.conditionalSampledCashPathProjection,
        ),
        null,
      )
    }
  }
})
test('wrong owner/Q/header/native units or stale source cannot label cash as holder exit', async () => {
  const p = props(await actualPayload(48), 48)
  for (const mutate of [
    (x) => delete x.requestedHolderAddress,
    (x) => (x.requestedHolderAddress = '0x' + 'c'.repeat(40)),
    (x) => (x.requestedRaw = '2'),
    (x) => (x.currentCash.blockHash = '0x' + 'f'.repeat(64)),
    (x) => (x.requestedAssetDecimals = 18),
    (x) => (x.asOfMs = Date.parse(x.currentCash.observedAt) + 1800001),
    (x) => delete x.currentCash.receiptSha256,
  ]) {
    const wrong = structuredClone(p)
    mutate(wrong)
    assert.ok(!render(wrong).includes('aria-label="Projected exit headroom"'))
  }
  const withoutE = { ...p, holderCapacityAgreement: null }
  const html = render(withoutE)
  assert.ok(!html.includes('aria-label="Projected exit headroom"'))
  assert.ok(html.includes('Projected cash headroom'))
})
test('agreed pause gate is consumed separately while failed optional response leaves capacity independent', async () => {
  const p = props(await actualPayload(1), 1),
    cash = card.selectedCometCashForCard(p.conditionalSampledCashPathProjection, p, p.currentCash)
  const facts = {
    status: 'comet_withdraw_getter_observed',
    routeKey,
    destination,
    asset,
    assetDecimals: 6,
    source: {
      chainId: 1,
      blockNumber: Number(cash.currentSource.block),
      blockHash: cash.currentSource.blockHash,
      blockTime: cash.currentSource.blockTime,
      finalized: true,
    },
    withdrawalsPaused: true,
  }
  p.holderCometFactsAgreement = adapter.agreeCometWithdrawFacts(
    { host: 'one.example', facts },
    { host: 'two.example', facts },
    now,
  )
  assert.equal(selected(p).withdrawalsPaused, true)
  const expected = card.formatExitPressureSignedRaw('-1000000', 6)
  assert.ok(render(p).includes(expected + '–' + expected + ' USDC'))
  const response = {
    error: 'holder_exit_assessment_unavailable',
    capacityAgreement: p.holderCapacityAgreement,
    cometFactsAgreement: p.holderCometFactsAgreement,
  }
  assert.deepEqual(
    workbench.holderCapacityAgreementFromResponse(response, 503),
    p.holderCapacityAgreement,
  )
  assert.deepEqual(
    workbench.holderCometFactsAgreementFromResponse(response, 503),
    p.holderCometFactsAgreement,
  )
  assert.equal(workbench.holderCometFactsAgreementFromResponse(response, 500), null)
})
