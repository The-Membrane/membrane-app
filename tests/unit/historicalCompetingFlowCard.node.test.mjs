import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import cardModule from '../../components/Carry/ExitPressureCard.tsx'
import flowModule from '../../lib/carry/historicalCompetingFlowEstimate.ts'
import impactModule from '../../lib/forecast/exitImpactForecast.ts'
import stressModule from '../../lib/carry/historicalGrossFlowStress.ts'
const { ExitPressureCard, formatExitPressureRaw } = cardModule
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
function props() {
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
test('paired flow row shows bounded historical means even without a cash projection', () => {
  const p = props()
  const before = structuredClone(p.historicalGrossFlow)
  const html = render(p)
  assert.match(html, /Historical mean inflow \/ outflow/)
  const flow = p.historicalBacktest.expectedCompetingFlow
  assert.ok(
    html.includes(
      `OUT RANGE ${formatExitPressureRaw(flow.grossDepletion.p10Raw, 6)}–${formatExitPressureRaw(flow.grossDepletion.p90Raw, 6)} USDC`,
    ),
  )
  assert.match(html, /42–60min · 78 windows/)
  const rowText = html.slice(html.indexOf('Historical mean'), html.indexOf('Heavy flow'))
  assert.doesNotMatch(rowText, /256 BLOCKS|TRAIN 77|OUT MAE|PRIOR-PREFIX|PERSISTENCE TESTS/)
  assert.doesNotMatch(html, /ROUTE EXIT PROJECTION/)
  assert.deepEqual(p.historicalGrossFlow, before)
})
test('forged means or changed route suppress only the optional flow context', () => {
  const p = props()
  p.historicalBacktest.expectedCompetingFlow.grossDepletion.mean.numeratorRaw = '1'
  const html = render(p)
  assert.doesNotMatch(html, /Historical mean inflow/)
  assert.match(html, /CONDITIONAL HISTORICAL FLOW/)
  const other = props()
  other.destination = `0x${'a'.repeat(40)}`
  assert.doesNotMatch(render(other), /Historical mean inflow/)
})
