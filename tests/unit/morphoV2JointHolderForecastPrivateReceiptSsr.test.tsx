import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ExitPressureCard,
  formatExitPressureSignedRaw,
  type ExitPressureCardProps,
} from '@/components/Carry/ExitPressureCard'
import { holderTimeProcessIssueFromResponse } from '@/components/Carry/ForecastWorkbench'
import {
  issuedMorphoV2JointHolderForecast,
  selectedMorphoV2JointHolderForecastFromIssue,
} from '@/lib/carry/morphoV2JointHolderForecastBinding'
import { encodeMorphoV2HistoricalHolderEaEvidencePair } from '@/lib/carry/morphoV2HistoricalHolderEaEvidence'
import {
  createMorphoV2JointHolderForecastFixture,
  jointUint,
} from './fixtures/morphoV2JointHolderForecastFixture'

// Real private issuer/codec with synthetic native responses: no acquisition or execution claim.
function fixture(asset: 'USDC' | 'USDT' = 'USDC') {
  const f = createMorphoV2JointHolderForecastFixture(asset, '987654321123456789', true, 1)
  const issue = holderTimeProcessIssueFromResponse(f.response, 200, f.question, null, null)
  if (!issue) throw Error('expected genuine controlled private receipt')
  const model = selectedMorphoV2JointHolderForecastFromIssue(issue, f.question)!
  if (!model.process.descriptiveExpectedFlow.headline)
    throw Error('expected complete controlled band')
  const props: ExitPressureCardProps = {
    routeKey: f.question.routeKey,
    destination: f.question.destination,
    requestedAmount: '1',
    requestedRaw: f.question.requestedRaw,
    requestedAssetSymbol: 'LINK',
    requestedAssetAddress: f.question.requestedAssetAddress,
    requestedAssetDecimals: f.question.requestedAssetDecimals,
    requestedHolderAddress: f.question.requestedHolderAddress,
    horizonHours: 1,
    asOfMs: f.question.asOfMs,
    currentCash: null,
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
    holderTimeProcessIssue: issue,
    holderCapacityAgreement: f.capacityAgreement,
    holderMorphoV2ProtocolCapacityEvidence: f.compactProtocol,
    holderMorphoV2CurrentHolderPositionEvidence: f.compactHolder,
    holderMorphoV2HistoricalHolderEaEvidence: f.compactHistorical,
  }
  const headline = `${formatExitPressureSignedRaw(model.process.descriptiveExpectedFlow.headline.headroom.empiricalMean.floorRaw, model.assetDecimals)} ${asset}`
  return { f, issue, model, props, headline }
}
function render(props: ExitPressureCardProps) {
  return renderToStaticMarkup(
    <ChakraProvider>
      <ExitPressureCard {...props} />
    </ChakraProvider>,
  )
}
describe('original private Morpho receipt Card and Workbench boundary', () => {
  it('renders the original model with its trusted asset symbol and actual issue target', () => {
    const { model, props, headline } = fixture()
    expect(model.authenticated).toBe(false)
    expect(model.historicalPastOwnershipProven).toBe(false)
    expect(render(props)).toContain(headline)
    expect(render(props)).toContain('Expected headroom')
    expect(Date.parse(model.targetAtUtc)).toBe(props.asOfMs! + 3600000)
  })
  it('retains the same original forecast when same-source current C and both historical origins change', () => {
    const { f, issue, model, props, headline } = fixture()
    const current = structuredClone(f.compactProtocol)
    for (const origin of current.origins) {
      const trace = origin.observation.traces.find((t: { key: string }) => t.key === 'idleCash')!
      trace.result = '0x' + '0'.repeat(63) + '1'
    }
    const historical = JSON.parse(f.compactHistorical!)
    for (const origin of historical.origins)
      origin.observation.traces[0].result = '0x' + '0'.repeat(64)
    const agreement = JSON.parse(JSON.stringify(f.capacityAgreement))
    agreement.quote.entitlementRaw = '1'
    props.holderCapacityAgreement = agreement
    props.holderMorphoV2ProtocolCapacityEvidence = current
    props.holderMorphoV2HistoricalHolderEaEvidence = JSON.stringify(historical)
    expect(selectedMorphoV2JointHolderForecastFromIssue(issue, f.question)).toBe(model)
    expect(render(props)).toContain(headline)
  })
  it('cannot substitute a different VALID historical trajectory accepted by the real issuer', () => {
    const { f, issue, model, props, headline } = fixture('USDT')
    const original = model.process.scenarios[0]
    if (original.status !== 'usable') throw Error('expected usable original donor')
    const raw = structuredClone(f.historical)
    const period = BigInt(
      Date.parse(f.anchors[1].source.blockTime) - Date.parse(f.anchors[0].source.blockTime),
    )
    const elapsed = BigInt(f.question.asOfMs - Date.parse(f.expected.source.blockTime) + 3600000)
    const desiredEa = BigInt(original.measurement.availableRaw) / 2n
    const decline = ((BigInt(model.fullEaRaw) - desiredEa) * period + elapsed - 1n) / elapsed
    for (const origin of raw.origins) {
      const endEa = BigInt(origin.observation.traces[1].result)
      origin.observation.traces[0].result = jointUint(endEa + decline)
    }
    const validHistorical = encodeMorphoV2HistoricalHolderEaEvidencePair(raw, f.historicalExpected)
    expect(validHistorical).not.toBeNull()
    const alternate = issuedMorphoV2JointHolderForecast(
      f.capacityAgreement,
      undefined,
      f.compactProtocol,
      f.compactHolder,
      validHistorical,
      f.question,
    )!
    expect(alternate).not.toBeNull()
    expect(alternate.process.descriptiveExpectedFlow.headline).not.toBeNull()
    expect(alternate).toMatchObject({
      sharesRaw: model.sharesRaw,
      fullEaRaw: model.fullEaRaw,
      source: model.source,
      requestedRaw: model.requestedRaw,
    })
    const changedHeadline = `${formatExitPressureSignedRaw(alternate.process.descriptiveExpectedFlow.headline!.headroom.empiricalMean.floorRaw, alternate.assetDecimals)} USDT`
    expect(changedHeadline).not.toBe(headline)
    props.holderMorphoV2HistoricalHolderEaEvidence = validHistorical
    expect(selectedMorphoV2JointHolderForecastFromIssue(issue, f.question)).toBe(model)
    expect(render(props)).toContain(headline)
    expect(render(props)).not.toContain(changedHeadline)
  })
  it('uses the original USDT asset symbol even when the caller requests another label', () => {
    const { props, model, headline } = fixture('USDT')
    expect(model.assetSymbol).toBe('USDT')
    expect(render(props)).toContain(headline)
  })
  it('rejects a cloned receipt, changed complete question and expired render clock', () => {
    const { props, issue, headline, model } = fixture()
    expect(render({ ...props, holderTimeProcessIssue: structuredClone(issue) })).not.toContain(
      headline,
    )
    expect(render({ ...props, asOfMs: props.asOfMs! - 1 })).not.toContain(headline)
    expect(render({ ...props, routeKey: 'USDT → VaultV2 [USDT]' })).not.toContain(headline)
    expect(render({ ...props, destination: '0x' + 'c'.repeat(40) })).not.toContain(headline)
    expect(render({ ...props, requestedAssetAddress: '0x' + 'c'.repeat(40) })).not.toContain(
      headline,
    )
    expect(render({ ...props, requestedAssetDecimals: 18 })).not.toContain(headline)
    expect(
      render({
        ...props,
        currentCash: {
          routeKey: props.routeKey,
          destination: props.destination,
          cashRaw: '0',
          assetDecimals: model.assetDecimals,
          assetSymbol: model.assetSymbol,
          assetAddress: model.asset,
          freshness: 'fresh',
          label: 'Vault cash',
          block: String(model.source.blockNumber),
          observedAt: model.source.blockTime,
          blockHash: '0x' + 'e'.repeat(64),
        },
      }),
    ).not.toContain(headline)
    expect(render({ ...props, requestedRaw: '2000000' })).not.toContain(headline)
    expect(render({ ...props, horizonHours: 24 })).not.toContain(headline)
    expect(render({ ...props, requestedHolderAddress: '0x' + 'c'.repeat(40) })).not.toContain(
      headline,
    )
    expect(render({ ...props, asOfMs: Date.parse(model.sourceProofValidUntil) + 1 })).not.toContain(
      headline,
    )
  })
})
