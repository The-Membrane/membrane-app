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
import adapter from '../../lib/carry/sghoHolderCapacityProjection.ts'
const hash = (s) => createHash('sha256').update(s).digest('hex')
const routeKey = 'GHO → sGho [GHO]',
  destination = '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
const asset = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  owner = '0x' + 'b'.repeat(40),
  q = '1000000000000000000'
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
function props(body, H = 24, paused = false, full = '3000000000000000000') {
  const c = body.sampledCashPaths.current
  const current = workbench.withBoundSampledCashCurrentMetadata(
    {
      routeKey,
      destination,
      assetAddress: asset,
      assetDecimals: 18,
      assetSymbol: 'GHO',
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
    entitlementRaw: '2000000000000000000',
    quotedMaxWithdrawRaw: '2000000000000000000',
    quotedMaxWithdrawStatus: 'quoted',
    effectiveLimitRaw: paused ? '0' : '2000000000000000000',
    withdrawalsPaused: paused,
    ...(full === undefined ? {} : { fullPositionEntitlementRaw: full }),
  }
  const quote = capacity.buildHolderExitCapacityQuote(a, facts, now)
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
    requestedAssetDecimals: 18,
    requestedAssetSymbol: 'GHO',
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
function row(html) {
  const start = html.indexOf('aria-label="Projected exit headroom"')
  assert.ok(start >= 0)
  return html.slice(start, html.indexOf('CONDITIONAL', start))
}
function expectedValue(p) {
  const cash = card.selectedSghoCashForCard(
    p.conditionalSampledCashPathProjection,
    p,
    p.currentCash,
  )
  const quoted = p.holderCapacityAgreement.quote,
    E = BigInt(quoted.fullPositionEntitlementRaw)
  const sorted = cash.scenarios
    .map((path) => {
      const C = BigInt(path.capacityRaw[cash.horizons[0].observation])
      return (quoted.withdrawalsPaused ? 0n : C < E ? C : E) - BigInt(q)
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return (
    [0.1, 0.9]
      .map((f) =>
        card.formatExitPressureSignedRaw(
          sorted[Math.floor((sorted.length - 1) * f)].toString(),
          18,
        ),
      )
      .join('–') + ' GHO'
  )
}
test('actual H1 and H48 archive-only API payloads pin the same native source and retain daily targets', async () => {
  for (const H of [1, 48]) {
    const body = await actualPayload(H),
      p = props(body, H)
    const cash = card.selectedSghoCashForCard(
      p.conditionalSampledCashPathProjection,
      p,
      p.currentCash,
    )
    assert.ok(cash)
    const pin = workbench.matchingHolderForecastSourceReference(
      null,
      p,
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    )
    assert.deepEqual(pin, {
      blockNumber: Number(p.currentCash.block),
      blockHash: p.currentCash.blockHash,
      blockTime: p.currentCash.observedAt,
    })
    const input = {
      cashProjection: cash,
      capacityAgreement: p.holderCapacityAgreement,
      binding: {
        routeKey,
        destination,
        owner,
        requestedRaw: q,
        asset,
        assetDecimals: 18,
        currentSource: { chainId: 1, ...pin, finalized: true },
        asOfMs: now,
      },
      currentSource: cash.currentSource,
      horizonHours: H,
      asOfMs: now,
    }
    const r = adapter.buildSghoHolderCapacityProjection(input, hash)
    assert.ok(r)
    assert.equal(r.request.horizonHours, H)
    assert.deepEqual(r.horizons[0].target, cash.horizons[0].target)
    const html = render(p)
    assert.ok(row(html).includes(expectedValue(p)))
    assert.ok(html.includes(r.horizons[0].target.earliestAt.slice(5, 19).replace('T', ' ')))
  }
})
test('paused sGHO preserves physical cash but displays negative requested headroom', async () => {
  const p = props(await actualPayload(24), 24, true)
  assert.ok(row(render(p)).includes('−1–−1 GHO'))
})
test('capacity-only 503 keeps full E independently and no execution assessment is synthesized', async () => {
  const p = props(await actualPayload(24))
  p.holderCapacityAgreement = workbench.holderCapacityAgreementFromResponse(
    { error: 'holder_exit_assessment_unavailable', capacityAgreement: p.holderCapacityAgreement },
    503,
  )
  assert.ok(row(render(p)).includes(expectedValue(p)))
  assert.equal(p.holderAssessment, null)
})
test('missing/disagreed full E, wrong owner/source/units and expiry retain independent cash fallback when valid', async () => {
  const body = await actualPayload(24),
    base = props(body)
  for (const change of [
    (p) => {
      for (const quote of [
        p.holderCapacityAgreement.quote,
        ...p.holderCapacityAgreement.origins.map((o) => o.quote),
      ]) {
        delete quote.fullPositionEntitlementRaw
        delete quote.fullPositionEntitlementMethod
      }
    },
    (p) => {
      p.holderCapacityAgreement.quote.fullPositionEntitlementRaw = null
      p.holderCapacityAgreement.quote.fullPositionEntitlementMethod = 'unavailable'
      for (const o of p.holderCapacityAgreement.origins) {
        o.quote.fullPositionEntitlementRaw = null
        o.quote.fullPositionEntitlementMethod = 'unavailable'
      }
    },
    (p) => {
      p.requestedHolderAddress = '0x' + 'c'.repeat(40)
    },
    (p) => {
      p.holderCapacityAgreement.origins[0].quote.source.blockHash = '0x' + 'c'.repeat(64)
    },
    (p) => {
      p.holderCapacityAgreement.quote.assetDecimals = 6
    },
    (p) => {
      p.holderCapacityAgreement.origins[0].quote.fullPositionEntitlementRaw = '4000000000000000000'
    },
  ]) {
    const p = structuredClone(base)
    change(p)
    const html = render(p)
    assert.ok(!html.includes('aria-label="Projected exit headroom"'))
    assert.ok(html.includes('Projected cash headroom'))
  }
  const expired = { ...base, asOfMs: Date.parse(base.currentCash.observedAt) + 1800001 }
  assert.ok(!render(expired).includes('aria-label="Projected exit headroom"'))
  assert.equal(
    card.selectedSghoCashForCard(
      expired.conditionalSampledCashPathProjection,
      expired,
      expired.currentCash,
    ),
    null,
  )
})
