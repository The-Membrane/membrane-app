import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'
import themeModule from '../../theme/index.ts'
import cardModule from '../../components/Carry/ExitPressureCard.tsx'
import bindingModule from '../../lib/carry/morphoV2HolderForecastBinding.ts'
import fixtureModule from './fixtures/morphoV2HolderForecastFixture.ts'
import jointBindingModule from '../../lib/carry/morphoV2JointHolderForecastBinding.ts'
import jointFixtureModule from './fixtures/morphoV2JointHolderForecastFixture.ts'
import historicalEaModule from '../../lib/carry/morphoV2HistoricalHolderEaEvidence.ts'
import semanticColorsModule from '../../config/semanticColors.ts'

const theme = themeModule.default ?? themeModule
const { ExitPressureCard, formatExitPressureSignedRaw } = cardModule
const { issuedMorphoV2HolderForecast, morphoV2HolderForecastIssueFromResponse } = bindingModule
const { createMorphoV2HolderForecastFixture } = fixtureModule
const { issuedMorphoV2JointHolderForecast, morphoV2JointHolderForecastIssueFromResponse } =
  jointBindingModule
const { createMorphoV2JointHolderForecastFixture, MORPHO_JOINT_RETAINED_FIXED_S, jointUint } =
  jointFixtureModule
const { encodeMorphoV2HistoricalHolderEaEvidencePair } = historicalEaModule
const { SEMANTIC_COLORS } = semanticColorsModule

function jointCardFixture(
  asset = 'USDT',
  shares = MORPHO_JOINT_RETAINED_FIXED_S,
  nativeHistory = false,
  H = 24,
  requestedRaw = '1000000',
) {
  const f = createMorphoV2JointHolderForecastFixture(asset, shares, nativeHistory, H)
  f.question.requestedRaw = requestedRaw
  f.capacityAgreement.quote.requestedRaw = requestedRaw
  f.capacityAgreement.origins.forEach((origin) => {
    origin.quote.requestedRaw = requestedRaw
  })
  const receipt = morphoV2JointHolderForecastIssueFromResponse(f.response, 200, f.question)
  const model = issuedMorphoV2JointHolderForecast(
    f.capacityAgreement,
    undefined,
    f.compactProtocol,
    f.compactHolder,
    f.compactHistorical,
    f.question,
  )
  assert.ok(receipt)
  assert.ok(model)
  const props = {
    ...f.question,
    requestedAmount: '1',
    requestedAssetSymbol: asset,
    currentCash: null,
    prospectiveCashModel: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    holderTimeProcessIssue: receipt,
    holderCapacityAgreement: f.capacityAgreement,
    holderMorphoV2ProtocolCapacityEvidence: f.compactProtocol,
    holderMorphoV2CurrentHolderPositionEvidence: f.compactHolder,
    holderMorphoV2HistoricalHolderEaEvidence: f.compactHistorical,
    holderAssessment: null,
    expectedEventEnrollment: null,
    eventContext: null,
    historicalOutlook: null,
  }
  const render = (p = props) =>
    renderToStaticMarkup(
      React.createElement(ChakraProvider, { theme }, React.createElement(ExitPressureCard, p)),
    )
  return { f, receipt, model, props, render }
}

function jointMetricValueCss(html) {
  const marker = 'aria-label="Selected-horizon joint Morpho holder headroom"'
  const at = html.indexOf(marker)
  assert.ok(at >= 0)
  const valueTag = html.slice(at + marker.length).match(/<p\b[^>]*class="([^"]+)"[^>]*>/)
  assert.ok(valueTag)
  const cssClass = valueTag[1].split(/\s+/).find((name) => name.startsWith('css-'))
  assert.ok(cssClass)
  const start = html.indexOf(`.${cssClass}{`)
  assert.ok(start >= 0)
  return html.slice(start, html.indexOf('}', start) + 1)
}

test('joint metric warns for native available below Q even when headroom is clamped zero; equality stays unwarned', () => {
  const baseline = jointCardFixture('USDT', MORPHO_JOINT_RETAINED_FIXED_S, false, 1)
  const usable = baseline.model.process.scenarios.filter((s) => s.status === 'usable')
  assert.equal(usable.length, baseline.model.attemptedDonorCount)
  const minimumAvailable = usable.reduce((minimum, s) => {
    const available = BigInt(s.measurement.availableRaw)
    return available < minimum ? available : minimum
  }, BigInt(usable[0].measurement.availableRaw))
  assert.ok(minimumAvailable > 0n)
  const equality = jointCardFixture(
    'USDT',
    MORPHO_JOINT_RETAINED_FIXED_S,
    false,
    1,
    String(minimumAvailable),
  )
  const shortage = jointCardFixture(
    'USDT',
    MORPHO_JOINT_RETAINED_FIXED_S,
    false,
    1,
    String(minimumAvailable + 1n),
  )
  assert.ok(
    equality.model.process.scenarios.every(
      (s) => s.status === 'usable' && BigInt(s.measurement.availableRaw) >= minimumAvailable,
    ),
  )
  assert.ok(
    shortage.model.process.scenarios.some(
      (s) =>
        s.status === 'usable' &&
        BigInt(s.measurement.availableRaw) < BigInt(shortage.model.requestedRaw) &&
        s.measurement.headroomRaw === '0',
    ),
  )
  assert.ok(jointMetricValueCss(shortage.render()).includes(`color:${SEMANTIC_COLORS.warning}`))
  assert.ok(jointMetricValueCss(equality.render()).includes(`color:${SEMANTIC_COLORS.textPrimary}`))
})

for (const asset of ['USDC', 'USDT'])
  for (const H of [1, 24, 48, 168]) {
    test(`actual card renders synthetic native ${asset} joint H${H} with arbitrary S and no generic cash`, () => {
      const { model, render } = jointCardFixture(asset, '987654321123456789', true, H)
      const html = render(),
        summary = model.process.descriptiveExpectedFlow.headline?.headroom
      assert.ok(html.includes('Selected-horizon joint Morpho holder headroom'))
      assert.ok(html.includes('Expected headroom'))
      assert.ok(
        html.includes(`USABLE ${model.process.usableScenarioCount}/${model.attemptedDonorCount}`),
      )
      assert.ok(
        html.includes(`CENSORED ${model.process.descriptiveExpectedFlow.censoredScenarioCount}`),
      )
      assert.ok(html.includes(`EXCLUDED ${model.process.excludedDonors.length}`))
      assert.ok(html.includes('FIRST SAMPLE'))
      assert.ok(html.includes('BETWEEN SAMPLES ?'))
      assert.ok(html.includes(model.targetAtUtc.slice(5, 19).replace('T', ' ')))
      if (summary) {
        assert.ok(
          html.includes(
            `${formatExitPressureSignedRaw(summary.empiricalMean.floorRaw, model.assetDecimals)} ${asset}`,
          ),
        )
        assert.ok(
          html.includes(
            `${formatExitPressureSignedRaw(summary.band.minRaw, model.assetDecimals)}–${formatExitPressureSignedRaw(summary.band.maxRaw, model.assetDecimals)} ${asset}`,
          ),
        )
      } else assert.ok(html.includes('MIN–MAX —'))
      assert.ok(!html.includes('P10–P90'))
      assert.ok(!html.includes('your full entitlement stay unchanged'))
    })
  }

test('joint card selects fixed-S USDT only from complete current native bytes and private question receipt', () => {
  const { f, receipt, model, props, render } = jointCardFixture()
  const marker = 'Selected-horizon joint Morpho holder headroom'
  assert.ok(render().includes(marker))
  for (const replacement of [
    { horizonHours: 48 },
    { requestedRaw: '999999' },
    { requestedHolderAddress: `0x${'c'.repeat(40)}` },
    { requestedAssetAddress: `0x${'c'.repeat(40)}` },
    { requestedAssetDecimals: 18 },
    { destination: `0x${'c'.repeat(40)}` },
    { holderTimeProcessIssue: structuredClone(receipt) },
    { holderMorphoV2ProtocolCapacityEvidence: null },
    { holderMorphoV2CurrentHolderPositionEvidence: null },
    { holderMorphoV2CurrentHolderPositionEvidence: '{}' },
    { holderMorphoV2HistoricalHolderEaEvidence: '{}' },
    { asOfMs: Date.parse(model.sourceProofValidUntil) + 1 },
    { asOfMs: f.question.asOfMs - 1 },
    { scenarioMode: 'initial_deposit' },
  ])
    assert.ok(!render({ ...props, ...replacement }).includes(marker))
  const later = render({ ...props, asOfMs: f.question.asOfMs + 1000 })
  assert.ok(later.includes(marker))
  assert.ok(later.includes(model.targetAtUtc.slice(5, 19).replace('T', ' ')))
  const raw = JSON.parse(f.compactHolder)
  raw.origins[0].observation.traces[1].result = jointUint(1n)
  assert.ok(
    !render({
      ...props,
      holderMorphoV2CurrentHolderPositionEvidence: JSON.stringify(raw),
    }).includes(marker),
  )
  // Labels follow the privately selected asset, even if an unrelated symbol prop is supplied.
  assert.ok(render({ ...props, requestedAssetSymbol: 'USDC' }).includes('USDT'))
  const source = {
    routeKey: f.question.routeKey,
    destination: f.question.destination,
    block: String(receipt.source.blockNumber),
    blockHash: receipt.source.blockHash,
    observedAt: receipt.source.blockTime,
    cashRaw: '1',
    assetAddress: f.question.requestedAssetAddress,
    assetDecimals: 6,
    freshness: 'fresh',
    sourceKind: 'live_read_only_two_origin_finalized',
    readAtUtc: new Date(f.question.asOfMs).toISOString(),
  }
  assert.ok(render({ ...props, currentCash: source }).includes(marker))
  assert.ok(
    !render({ ...props, currentCash: { ...source, blockHash: `0x${'c'.repeat(64)}` } }).includes(
      marker,
    ),
  )
})

test('joint card preserves censored tails without a complete mean or min/max headline', () => {
  const { f, props, render } = jointCardFixture('USDT', '123', true, 168)
  f.historical.origins.forEach((o) => {
    o.observation.traces[0].result = jointUint(1000000000000n)
    o.observation.traces[1].result = jointUint(0n)
  })
  const historical = encodeMorphoV2HistoricalHolderEaEvidencePair(
    f.historical,
    f.historicalExpected,
  )
  const response = { ...f.response, morphoV2HistoricalHolderEaEvidence: historical }
  const receipt = morphoV2JointHolderForecastIssueFromResponse(response, 200, f.question)
  assert.ok(receipt)
  const html = render({
    ...props,
    holderTimeProcessIssue: receipt,
    holderMorphoV2HistoricalHolderEaEvidence: historical,
  })
  assert.ok(html.includes('Selected-horizon joint Morpho holder headroom'))
  assert.ok(html.includes('MIN–MAX —'))
  assert.ok(!html.includes('CENSORED 0'))
  assert.ok(!html.includes('P10–P90'))
})

for (const H of [1, 24, 48, 168]) {
  test(`actual card renders native Morpho H${H} with no wallet or generic cash`, () => {
    const f = createMorphoV2HolderForecastFixture(H)
    const issue = morphoV2HolderForecastIssueFromResponse(
      { ...f.response, error: 'holder_exit_assessment_unavailable' },
      503,
      f.question,
    )
    const value = issuedMorphoV2HolderForecast(
      f.capacityAgreement,
      undefined,
      f.compact,
      f.question,
    )
    assert.ok(issue)
    assert.ok(value)
    const summary = value.process.targetSummary
    const props = {
      ...f.question,
      requestedAmount: '1',
      requestedAssetSymbol: 'USDC',
      currentCash: null,
      prospectiveCashModel: null,
      historicalScenario: null,
      grossWithdrawals: null,
      grossInflows: null,
      historicalGrossFlow: null,
      morphoPayout: null,
      holderTimeProcessIssue: issue,
      holderCapacityAgreement: f.capacityAgreement,
      holderMorphoV2ProtocolCapacityEvidence: f.compact,
      holderAssessment: null,
      expectedEventEnrollment: null,
      eventContext: null,
      historicalOutlook: null,
    }
    const render = (p = props) =>
      renderToStaticMarkup(
        React.createElement(ChakraProvider, { theme }, React.createElement(ExitPressureCard, p)),
      )
    const marker = 'Selected-horizon conditional Morpho holder headroom'
    const html = render()
    assert.ok(html.includes(marker))
    assert.ok(
      html.includes(
        `${formatExitPressureSignedRaw(summary.empiricalP10HeadroomRaw, 6)}–${formatExitPressureSignedRaw(summary.empiricalP90HeadroomRaw, 6)} USDC`,
      ),
    )
    assert.ok(html.includes(value.targetAtUtc.slice(5, 19).replace('T', ' ')))
    assert.ok(!render({ ...props, horizonHours: H === 1 ? 24 : 1 }).includes(marker))
    assert.ok(!render({ ...props, requestedRaw: '999999' }).includes(marker))
    assert.ok(!render({ ...props, requestedHolderAddress: `0x${'c'.repeat(40)}` }).includes(marker))
    assert.ok(
      !render({
        ...props,
        holderTimeProcessIssue: {
          ...issue,
          source: {
            ...issue.source,
            blockTime: new Date(Date.parse(issue.source.blockTime) + 1000).toISOString(),
          },
        },
      }).includes(marker),
    )
    assert.ok(
      !render({ ...props, asOfMs: Date.parse(value.sourceProofValidUntil) + 1 }).includes(marker),
    )
    const later = render({ ...props, asOfMs: f.question.asOfMs + 1000 })
    assert.ok(later.includes(value.targetAtUtc.slice(5, 19).replace('T', ' ')))
  })
}
