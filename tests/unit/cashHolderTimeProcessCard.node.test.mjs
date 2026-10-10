import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import card from '../../components/Carry/ExitPressureCard.tsx'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'
const audit = JSON.parse(
  readFileSync(
    'data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json',
    'utf8',
  ),
)
import sampled from '../../lib/carry/conditionalSampledCashPathProjection.ts'
import capacity from '../../lib/carry/holderExitCapacity.ts'
import comet from '../../lib/carry/cometHolderCapacityProjection.ts'
import constants from '../../lib/carry/directSupplyMarketConstants.ts'
import time from '../../lib/carry/conditionalCashHolderTimeProcess.ts'
const { buildConditionalSampledCashPathProjection } = sampled
const { buildHolderExitCapacityQuote, agreeHolderExitCapacityQuotes } = capacity
const { agreeCometWithdrawFacts } = comet
const markets = constants.DIRECT_SUPPLY_MARKETS
const { buildConditionalCashHolderTimeProcess } = time
const hash = (s) => createHash('sha256').update(s).digest('hex'),
  NOW = Date.parse('2026-10-08T12:00:00.000Z')
function fixture(market = markets.aaveV3Usdc, H = 24, paused = null) {
  const history = structuredClone(
    Object.values(audit.histories).find((h) => h.identity.routeKey === market.routeKey),
  )
  const currentSource = {
    ...history.identity,
    chainId: 1,
    block: '26190000',
    blockHash: '0x' + 'a'.repeat(64),
    blockTime: new Date(NOW - 60000).toISOString(),
    readAt: new Date(NOW).toISOString(),
    cashRaw: '500000000',
    sourceKind: 'live_read_only_two_origin_finalized',
  }
  const source = {
      chainId: 1,
      blockNumber: Number(currentSource.block),
      blockHash: currentSource.blockHash,
      blockTime: currentSource.blockTime,
      finalized: true,
    },
    owner = '0x' + 'b'.repeat(40),
    q = '20000000'
  const assessment = {
    status: 'assessed',
    routeKey: history.identity.routeKey,
    destinationAddress: history.identity.destination,
    owner,
    request: { assetsRaw: q, assetAddress: history.identity.asset, horizonHours: H },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'reverted',
        amountRaw: q,
        assetAddress: history.identity.asset,
      },
    ],
    finalPayout: { status: 'unassessed', assetAddress: history.identity.asset, amountRaw: null },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: '100000000',
      quotedMaxWithdrawRaw: null,
      quotedMaxWithdrawStatus: 'not_read',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    NOW,
  )
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    NOW,
  )
  const cometFactsAgreement =
    market === markets.compoundV3Usdc
      ? agreeCometWithdrawFacts(
          {
            host: 'one.example',
            facts: {
              ...history.identity,
              status: 'comet_withdraw_getter_observed',
              source,
              withdrawalsPaused: paused,
            },
          },
          {
            host: 'two.example',
            facts: {
              ...history.identity,
              status: 'comet_withdraw_getter_observed',
              source,
              withdrawalsPaused: paused,
            },
          },
          NOW,
        )
      : undefined
  const cashProjection = buildConditionalSampledCashPathProjection(
    { history, currentSource, request: { requestedRaw: q, asOf: new Date(NOW).toISOString() } },
    hash,
  )
  const input = {
    cashProjection,
    capacityAgreement,
    cometFactsAgreement,
    currentSource,
    binding: { ...history.identity, owner, requestedRaw: q, currentSource: source, asOfMs: NOW },
    horizonHours: H,
    asOfMs: NOW,
  }
  return { input, history }
}

function props(f) {
  const s = f.input.currentSource,
    b = f.input.binding,
    H = f.input.horizonHours
  const currentCash = {
    routeKey: s.routeKey,
    destination: s.destination,
    assetAddress: s.asset,
    assetDecimals: s.assetDecimals,
    assetSymbol: s.assetDecimals === 18 ? 'USDe' : s.routeKey.includes('USDT') ? 'USDT' : 'USDC',
    cashRaw: s.cashRaw,
    block: s.block,
    blockHash: s.blockHash,
    observedAt: s.blockTime,
    readAtUtc: s.readAt,
    sourceKind: s.sourceKind,
    freshness: 'fresh',
    label: 'Pool cash',
  }
  const p = {
    routeKey: s.routeKey,
    destination: s.destination,
    requestedRaw: b.requestedRaw,
    requestedAmount: '20',
    requestedAssetAddress: s.asset,
    requestedAssetDecimals: s.assetDecimals,
    requestedAssetSymbol: currentCash.assetSymbol,
    requestedHolderAddress: b.owner,
    horizonHours: H,
    asOfMs: NOW,
    currentCash,
    conditionalSampledCashPathProjection: f.input.cashProjection,
    holderCapacityAgreement: f.input.capacityAgreement,
    holderCometFactsAgreement: f.input.cometFactsAgreement,
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
  const body = {
    error: 'holder_exit_assessment_unavailable',
    capacityAgreement: p.holderCapacityAgreement,
    cometFactsAgreement: p.holderCometFactsAgreement,
  }
  p.holderTimeProcessIssue = workbench.holderTimeProcessIssueFromResponse(
    body,
    503,
    p,
    currentCash,
    p.conditionalSampledCashPathProjection,
  )
  return p
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(card.ExitPressureCard, p)),
  )
for (const market of Object.values(markets))
  test('native selected-H holder UI ' + market.routeKey, () => {
    for (const H of [1, 24, 48]) {
      const f = fixture(market, H),
        p = props(f)
      assert.ok(p.holderTimeProcessIssue)
      const html = render(p),
        target = new Date(NOW + H * 3600000).toISOString().slice(5, 19).replace('T', ' ')
      assert.ok(html.includes('aria-label="Selected-horizon conditional holder headroom"'))
      assert.ok(html.includes(target + ' UTC'))
      assert.ok(!html.includes('90% confidence'))
      const later = render({ ...p, asOfMs: NOW + 1000 })
      assert.ok(later.includes(target + ' UTC'))
      assert.equal(p.holderTimeProcessIssue.issuedAtMs, NOW)
    }
  })
test('issued native receipt cannot be fabricated from unrelated503 or changed owner/Q/source/H', () => {
  const f = fixture(),
    p = props(f),
    body = { capacityAgreement: p.holderCapacityAgreement }
  assert.equal(
    workbench.holderTimeProcessIssueFromResponse(
      body,
      503,
      p,
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    ),
    null,
  )
  for (const change of [
    { requestedHolderAddress: '0x' + 'c'.repeat(40) },
    { requestedRaw: '2' },
    { horizonHours: 48 },
    { currentCash: { ...p.currentCash, blockHash: '0x' + 'c'.repeat(64) } },
  ]) {
    const q = { ...p, ...change }
    assert.ok(!render(q).includes('aria-label="Selected-horizon conditional holder headroom"'))
  }
  const current = { ...p.currentCash, readAtUtc: new Date(NOW + 1).toISOString() }
  assert.equal(
    workbench.holderTimeProcessIssueFromResponse(
      { error: 'holder_exit_assessment_unavailable', capacityAgreement: p.holderCapacityAgreement },
      503,
      p,
      current,
      p.conditionalSampledCashPathProjection,
    ),
    null,
  )
})
test('ticking render clock does not reissue and rejects elapsed target or expired source', () => {
  const f = fixture(markets.aaveV3Usdc, 0.01),
    p = props(f)
  assert.ok(render(p).includes('aria-label="Selected-horizon conditional holder headroom"'))
  assert.ok(
    !render({ ...p, asOfMs: NOW + 36000 }).includes(
      'aria-label="Selected-horizon conditional holder headroom"',
    ),
  )
  assert.ok(
    !render({ ...props(fixture()), asOfMs: NOW + 1800000 }).includes(
      'aria-label="Selected-horizon conditional holder headroom"',
    ),
  )
})
test('independently attested Comet pause retains physical cash and all negative-Q headroom', () => {
  const f = fixture(markets.compoundV3Usdc, 1, true),
    p = props(f),
    html = render(p)
  assert.ok(html.includes('Selected-horizon conditional holder headroom'))
  assert.ok(html.includes('−20'))
  assert.ok(html.includes('SHORTFALL'))
  const input = card.issuedCashHolderTimeInputForCard(
    p.conditionalSampledCashPathProjection,
    p.holderCapacityAgreement,
    p.holderCometFactsAgreement,
    null,
    p,
    p.currentCash,
  )
  const process = buildConditionalCashHolderTimeProcess(input, hash)
  assert.equal(process.withdrawalsPaused, true)
  assert.ok(
    process.process.scenarios.every((s) =>
      s.points.every((point) => point.capacityRaw === '0' && point.headroomRaw === '-20000000'),
    ),
  )
})

function durationFixture(runs) {
  const issue = '2026-10-08T12:00:00.000Z',
    target = '2026-10-08T13:00:00.000Z'
  return {
    process: { issueAtUtc: issue, targetAtUtc: target, scenarios: [{ sampledShortfalls: runs }] },
  }
}
test('future duration excludes episodes recovered before or exactly at issue', () => {
  for (const by of ['2026-10-08T11:59:59.000Z', '2026-10-08T12:00:00.000Z'])
    assert.equal(
      card.cashHolderDurationDetail(
        durationFixture([
          {
            onset: { after: '2026-10-08T11:30:00.000Z', by: '2026-10-08T11:40:00.000Z' },
            recovery: { after: '2026-10-08T11:50:00.000Z', by },
            leftCensored: false,
            rightCensored: false,
          },
        ]),
      ),
      '',
    )
})
test('future duration clips source-age onset and left censor to genuine issue', () => {
  const r = {
    onset: { after: null, by: '2026-10-08T11:40:00.000Z' },
    recovery: { after: '2026-10-08T12:20:00.000Z', by: '2026-10-08T12:30:00.000Z' },
    leftCensored: true,
    rightCensored: false,
  }
  assert.equal(card.cashHolderDurationDetail(durationFixture([r])), ' · SHORTFALL 20–30min')
  r.onset.after = '2026-10-08T11:30:00.000Z'
  r.leftCensored = false
  assert.equal(card.cashHolderDurationDetail(durationFixture([r])), ' · SHORTFALL 20–30min')
})
test('future duration subhour recovery bracket rounds bounds outwards in minutes', () => {
  const r = {
    onset: { after: '2026-10-08T12:01:00.000Z', by: '2026-10-08T12:02:00.000Z' },
    recovery: { after: '2026-10-08T12:02:36.000Z', by: '2026-10-08T12:03:00.000Z' },
    leftCensored: false,
    rightCensored: false,
  }
  assert.equal(card.cashHolderDurationDetail(durationFixture([r])), ' · SHORTFALL 0.6–2min')
  r.onset.after = r.onset.by = '2026-10-08T12:00:00.000Z'
  r.recovery.after = '2026-10-08T12:00:20.000Z'
  r.recovery.by = '2026-10-08T12:00:30.000Z'
  assert.equal(card.cashHolderDurationDetail(durationFixture([r])), ' · SHORTFALL 20–30s')
})
test('future duration genuine right censor retains useful lower bound or unresolved target', () => {
  const r = {
      onset: { after: '2026-10-08T11:30:00.000Z', by: '2026-10-08T11:40:00.000Z' },
      recovery: null,
      leftCensored: false,
      rightCensored: true,
    },
    v = durationFixture([r])
  v.process.targetAtUtc = '2026-10-08T12:00:36.000Z'
  assert.equal(card.cashHolderDurationDetail(v), ' · SHORTFALL ≥36s')
  r.onset.after = '2026-10-08T12:00:00.000Z'
  r.onset.by = v.process.targetAtUtc
  assert.equal(card.cashHolderDurationDetail(v), ' · SHORTFALL AT TARGET')
})
