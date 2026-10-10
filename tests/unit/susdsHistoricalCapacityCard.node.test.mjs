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
import adapter from '../../lib/carry/susdsHistoricalHolderCapacityProjection.ts'
const hash = (s) => createHash('sha256').update(s).digest('hex')
const routeKey = 'USDS → SUsds [USDS]',
  destination = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'
const asset = '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
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
function props(body, H = 24) {
  const c = body.sampledCashPaths.current
  const current = workbench.withBoundSampledCashCurrentMetadata(
    {
      routeKey,
      destination,
      assetAddress: asset,
      assetDecimals: 18,
      assetSymbol: 'USDS',
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
      entitlementRaw: '3000000000000000000',
      quotedMaxWithdrawRaw: '0',
      quotedMaxWithdrawStatus: 'quoted',
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
    requestedAssetDecimals: 18,
    requestedAssetSymbol: 'USDS',
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
  const cash = card.selectedSusdsCashForCard(
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
    history: adapter.susdsPinnedIndexHistory(),
    capacityAgreement: p.holderCapacityAgreement,
    binding: {
      routeKey,
      destination,
      owner: p.requestedHolderAddress,
      requestedRaw: p.requestedRaw,
      asset,
      assetDecimals: 18,
      currentSource: source,
      asOfMs: p.asOfMs,
    },
    currentSource: source,
    currentReadAtUtc: cash.currentSource.readAt,
    horizonHours: p.horizonHours,
    asOfMs: p.asOfMs,
  }
  const built = adapter.buildSusdsHistoricalHolderCapacityProjection(input, hash)
  assert.ok(built)
  return adapter.selectedSusdsHistoricalHolderCapacityProjection(built, input, hash)
}
test('actual any-H API source drives own-index USDS holder row, never current max cap', async () => {
  for (const H of [1, 24, 48]) {
    const body = await actualPayload(H),
      p = props(body, H),
      s = selected(p),
      g = s.view.groups[0],
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
    // Source selection consumes the actual response witness, independently of holder E.
    for (const mutate of [
      (x) => {
        x.requestedRaw = '2'
      },
      (x) => {
        x.currentCash.blockHash = '0x' + 'f'.repeat(64)
      },
      (x) => {
        x.asOfMs = Date.parse(x.currentCash.observedAt) + 1800001
      },
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
    assert.ok(html.includes('aria-label="Projected exit headroom"'))
    assert.ok(
      html.includes(
        card.formatExitPressureSignedRaw(g.headroomLower.p10Raw, 18) +
          '–' +
          card.formatExitPressureSignedRaw(g.headroomUpper.p90Raw, 18) +
          ' USDS',
      ),
    )
    assert.ok(html.includes(g.targetAt.slice(5, 19).replace('T', ' ') + ' UTC'))
    assert.ok(!html.includes('OWN SHARE INDEX'))
    assert.ok(!html.includes('SEALED CHECKPOINTS'))
    assert.ok(!html.includes('29 saved checkpoints'))
    assert.ok(BigInt(g.headroomLower.p10Raw) > 0n)
    assert.equal(s.projection.holderExecutableExit, false)
    assert.ok(s.view.groups.every((x) => Date.parse(x.targetAt) > now))
  }
})
test('different owner/Q/header/units, stale clock or missing source witness cannot render holder row', async () => {
  const p = props(await actualPayload(48), 48)
  const mutations = [
    (x) => delete x.requestedHolderAddress,
    (x) => (x.requestedHolderAddress = '0x' + 'c'.repeat(40)),
    (x) => (x.requestedRaw = '2'),
    (x) => (x.currentCash.blockHash = '0x' + 'f'.repeat(64)),
    (x) => (x.requestedAssetDecimals = 6),
    (x) => (x.asOfMs = Date.parse(x.currentCash.observedAt) + 1800001),
    (x) => delete x.currentCash.receiptSha256,
  ]
  for (const mutate of mutations) {
    const x = structuredClone(p)
    mutate(x)
    assert.ok(!render(x).includes('aria-label="Projected exit headroom"'))
  }
  assert.ok(render(p).includes('aria-label="Projected exit headroom"'))
})
test('render selector removes elapsed targets while source remains valid', async () => {
  const p = props(await actualPayload(24)),
    s = selected(p),
    sourceAt = Date.parse(p.currentCash.observedAt)
  assert.ok(s.view.elapsedEpisodeIndices.length > 0)
  assert.ok(s.view.groups.every((g) => Date.parse(g.targetAt) > now))
  const early = s.projection.groups.find(
    (g) => Date.parse(g.targetAt) > now && Date.parse(g.targetAt) <= sourceAt + 1800000,
  )
  if (early) {
    p.asOfMs = Date.parse(early.targetAt)
    const next = selected(p)
    assert.ok(!next.view.groups.some((g) => g.targetAt === early.targetAt))
    assert.ok(!render(p).includes(early.targetAt.slice(5, 19).replace('T', ' ') + ' UTC'))
  } else {
    assert.ok(s.view.groups.every((g) => Date.parse(g.targetAt) > now))
    assert.ok(
      !render({ ...p, asOfMs: sourceAt + 1800001 }).includes(
        'aria-label="Projected exit headroom"',
      ),
    )
  }
})
