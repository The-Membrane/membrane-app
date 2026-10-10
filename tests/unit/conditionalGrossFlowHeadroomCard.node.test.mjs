import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import cardModule from '../../components/Carry/ExitPressureCard.tsx'
import headroomModule from '../../lib/carry/conditionalGrossFlowHeadroom.ts'
import flowModule from '../../lib/carry/historicalCompetingFlowEstimate.ts'
import impactModule from '../../lib/forecast/exitImpactForecast.ts'
import stressModule from '../../lib/carry/historicalGrossFlowStress.ts'
const { ExitPressureCard, formatExitPressureSignedRaw } = cardModule
const { AAVE_COMPETING_FLOW_IDENTITY: id, buildHistoricalCompetingFlowEstimate } = flowModule
const { buildExitImpactForecast, withHistoricalCompetingFlow } = impactModule
const { projectHistoricalGrossFlowStress } = stressModule
const hash = (s) => createHash('sha256').update(s).digest('hex')
const summary = JSON.parse(
  readFileSync(
    new URL(
      '../../data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
)
const now = Date.parse('2026-10-07T08:00:00.000Z')
function baseProps() {
  const pairs = Array.from({ length: 60 }, (_, i) => ({
    subjectKey: `${id.routeKey}\0${id.destination}\0${id.asset}`,
    sourceAt: new Date(now - (121 - i * 2) * 86400000).toISOString(),
    targetAt: new Date(now - (120 - i * 2) * 86400000).toISOString(),
    sourceCashRaw: '500000000000000',
    targetCashRaw: '400000000000000',
  }))
  const estimate = buildHistoricalCompetingFlowEstimate(summary, hash)
  const historicalBacktest = withHistoricalCompetingFlow(
    buildExitImpactForecast({
      kind: 'retrospective_backtest',
      identity: id,
      requestedRaw: '1000000',
      horizonHours: 24,
      pairs,
    }),
    estimate,
    hash,
  )
  const stress = projectHistoricalGrossFlowStress(summary, '500000000000000', '1000000')
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
    currentCash: null,
    prospectiveCashModel: null,
    historicalBacktest,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    morphoPayout: null,
    holderAssessment: null,
    expectedEventEnrollment: null,
    eventContext: null,
    historicalOutlook: null,
    historicalGrossFlow: {
      ...stress,
      pairedScenarios: stress.historicalScenarios,
      requestedAmountRaw: '1000000',
      currentMarginAfterQRaw: (500000000000000n - 1000000n).toString(),
      routeKey: id.routeKey,
      destination: id.destination,
      requestedRaw: '1000000',
      archiveVerification: 'full_sealed_replay',
      validation: 'not_validated',
      holderExecutableExit: false,
      horizonBlocks: 256,
      windowCount: 78,
      assetDecimals: 6,
      assetSymbol: 'USDC',
      assetAddress: id.asset,
      startingCashRaw: '500000000000000',
      source: summary.source,
      startingBlock: 26139032,
      startingBlockHash: `0x${'b'.repeat(64)}`,
      startingAt: new Date(now).toISOString(),
    },
  }
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(ExitPressureCard, p)),
  )
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')

const { buildConditionalGrossFlowHeadroom } = headroomModule
function props(cashRaw = '500000000000000') {
  const p = baseProps()
  const source = {
    ...id,
    chainId: 1,
    cashRaw,
    blockNumber: 26139032,
    blockHash: `0x${'b'.repeat(64)}`,
    blockTime: new Date(now - 60000).toISOString(),
    readAt: new Date(now - 1000).toISOString(),
    finalized: true,
  }
  p.currentCash = {
    routeKey: id.routeKey,
    destination: id.destination,
    cashRaw,
    assetDecimals: 6,
    assetSymbol: 'USDC',
    assetAddress: id.asset,
    observedAt: source.blockTime,
    block: String(source.blockNumber),
    blockHash: source.blockHash,
    readAtUtc: source.readAt,
    sourceKind: 'live_read_only_two_origin_finalized',
    freshness: 'fresh',
    label: 'Market cash',
  }
  p.conditionalGrossFlowHeadroom = buildConditionalGrossFlowHeadroom(
    {
      currentSource: source,
      request: { requestedRaw: p.requestedRaw, asOf: new Date(now).toISOString() },
      historicalFlow: buildHistoricalCompetingFlowEstimate(summary, hash),
    },
    hash,
  )
  assert.equal(p.conditionalGrossFlowHeadroom.status, 'estimated')
  return p
}
test('shows one conditional signed P10–P90 headroom range with concrete future times', () => {
  for (const cash of ['500000000000000', '1']) {
    const p = props(cash),
      before = structuredClone(p),
      f = p.conditionalGrossFlowHeadroom
    const html = render(p)
    assert.match(html, /Projected headroom/)
    assert.ok(
      html.includes(
        `${formatExitPressureSignedRaw(f.userHeadroom.p10Raw, 6)}–${formatExitPressureSignedRaw(f.userHeadroom.p90Raw, 6)} USDC`,
      ),
    )
    assert.match(html, /CONDITIONAL · P10–P90 · 10-07 08:41:12–10-07 08:58:48 UTC/)
    assert.doesNotMatch(html, /you can withdraw|calibrated probability/i)
    assert.deepEqual(p, before)
  }
})
test('valid headroom remains visible without separate historical gross-flow context', () => {
  const p = props()
  p.historicalGrossFlow = null
  assert.match(render(p), /Projected headroom/)
})
const changes = {
  'Q changed': (p) => (p.requestedRaw = '2000000'),
  'stale render': (p) => (p.asOfMs = now + 29 * 60000 + 1),
  'target expired': (p) =>
    (p.asOfMs = Date.parse(p.conditionalGrossFlowHeadroom.target.earliestAt)),
  'wrong current cash': (p) => (p.currentCash.cashRaw = '1'),
  'wrong C2 hash': (p) => (p.currentCash.blockHash = `0x${'c'.repeat(64)}`),
  'wrong block': (p) => (p.currentCash.block = '26139033'),
  'array block': (p) => (p.currentCash.block = ['26139032']),
  'overflow block': (p) => (p.currentCash.block = String(1n << 256n)),
  'wrong C2 time': (p) => (p.currentCash.observedAt = new Date(now - 60001).toISOString()),
  'wrong read time': (p) => (p.currentCash.readAtUtc = new Date(now - 999).toISOString()),
  'missing read time': (p) => delete p.currentCash.readAtUtc,
  'single origin': (p) => (p.currentCash.sourceKind = 'single_origin'),
  'foreign decimals': (p) => (p.requestedAssetDecimals = 18),
  'foreign token': (p) => (p.requestedAssetAddress = `0x${'d'.repeat(40)}`),
  'foreign route': (p) => (p.routeKey = 'USDT → supply on Spark'),
  'forged full value': (p) => {
    const old = p.conditionalGrossFlowHeadroom
    p.conditionalGrossFlowHeadroom = buildConditionalGrossFlowHeadroom(
      {
        currentSource: { ...old.currentSource, cashRaw: '1', blockHash: `0x${'c'.repeat(64)}` },
        request: old.request,
        historicalFlow: old.historicalFlow,
      },
      hash,
    )
    assert.equal(p.conditionalGrossFlowHeadroom.status, 'estimated')
  },
  'forged mean': (p) => (p.conditionalGrossFlowHeadroom.userHeadroom.mean.numeratorRaw = '1'),
  'forged scenario': (p) => (p.conditionalGrossFlowHeadroom.scenarios[0].capacityRaw = '1'),
  'future response': (p) =>
    (p.conditionalGrossFlowHeadroom.request.asOf = new Date(now + 1).toISOString()),
  'noncanonical response': (p) =>
    (p.conditionalGrossFlowHeadroom.request.asOf = '2026-10-07T08:00:00Z'),
  'array payload': (p) =>
    (p.conditionalGrossFlowHeadroom = Object.entries(p.conditionalGrossFlowHeadroom)),
}
for (const [name, change] of Object.entries(changes))
  test(`omits only projected metric for ${name}`, () => {
    const p = props()
    change(p)
    const html = render(p)
    assert.doesNotMatch(html, /Projected headroom/)
    if (!['Q changed', 'foreign decimals', 'foreign token', 'foreign route'].includes(name))
      assert.match(html, /HISTORICAL Q BACKTEST/)
  })
test('response older than15min remains under30min source policy without retiming its target', () => {
  const p = props()
  p.asOfMs = now + 16 * 60000
  assert.match(render(p), /Projected headroom/)
  assert.match(render(p), /10-07 08:41:12–10-07 08:58:48 UTC/)
})

test('accepts source age exactly30min and omits at30min plus1ms', () => {
  const p = props()
  p.asOfMs = now + 29 * 60000
  assert.match(render(p), /Projected headroom/)
  p.asOfMs += 1
  assert.doesNotMatch(render(p), /Projected headroom/)
  assert.match(render(p), /HISTORICAL Q BACKTEST/)
})
