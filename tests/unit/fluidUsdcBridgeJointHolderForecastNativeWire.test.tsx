import React from 'react'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import capacityOriginal from '../fixtures/fluid-usdc-bridge-native-2026-10-08/current-capacity-agreement.json'
import historicalOriginal from '../fixtures/fluid-usdc-bridge-native-2026-10-08/server-historical-at-issue.json'
import manifest from '../fixtures/fluid-usdc-bridge-native-2026-10-08/manifest.json'
import {
  issuedFluidUsdcBridgeJointHolderForecast,
  fluidUsdcBridgeJointHolderForecastFromResponse,
  selectedFluidUsdcBridgeJointHolderForecastFromIssue,
  type FluidUsdcBridgeJointHolderForecastQuestion,
} from '@/lib/carry/fluidUsdcBridgeJointHolderForecastBinding'
import { decodeFluidUsdcBridgeJointNativeHistoryEvidence } from '@/lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec'
import { holderFluidUsdcBridgeJointIssueFromResponse } from '@/components/Carry/ForecastWorkbench'
import {
  ExitPressureCard,
  formatExitPressureSignedRaw,
  type ExitPressureCardProps,
  type ExitPressureFluidUsdcBridgeJointIssue,
} from '@/components/Carry/ExitPressureCard'

// Actual retained native ABI wire data; real profile/decoder/issuer, no mocks.
// Offline replay uses the original issue clock and cannot establish fresh native
// acquisition, historical ownership, authentication, execution or calibration.
function fixture() {
  const capacity = structuredClone(capacityOriginal)
  const historical = structuredClone(historicalOriginal)
  const question: FluidUsdcBridgeJointHolderForecastQuestion = {
    routeKey: capacity.quote.routeKey,
    destination: capacity.quote.destination,
    requestedHolderAddress: capacity.quote.owner,
    requestedRaw: capacity.quote.requestedRaw,
    requestedAssetAddress: capacity.quote.asset,
    requestedAssetDecimals: 6,
    horizonHours: 1,
    asOfMs: Date.parse(historical.issuedAtUtc),
  }
  const response = {
    capacityAgreement: capacity,
    fluidUsdcBridgeJointHistoricalEvidence: historical.evidence,
    fluidUsdcBridgeJointIssuedAtUtc: historical.issuedAtUtc,
  }
  return { capacity, historical, question, response }
}
function render(retained: ExitPressureFluidUsdcBridgeJointIssue) {
  const q = retained.question
  const props: ExitPressureCardProps = {
    routeKey: q.routeKey,
    destination: q.destination,
    requestedAmount: '1',
    requestedRaw: q.requestedRaw,
    requestedAssetSymbol: 'USDC',
    requestedAssetAddress: q.requestedAssetAddress,
    requestedAssetDecimals: 6,
    requestedHolderAddress: q.requestedHolderAddress,
    horizonHours: q.horizonHours,
    asOfMs: q.asOfMs + 1,
    holderFluidUsdcBridgeJointIssue: retained,
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
  }
  return renderToStaticMarkup(
    <ChakraProvider>
      <ExitPressureCard {...props} />
    </ChakraProvider>,
  )
}
describe('Fluid actual twelve-anchor native wire offline private forecast replay', () => {
  it('retains exact reviewed originals and accepts the real twelve-anchor evidence and response', () => {
    for (const record of manifest.originals) {
      const bytes = readFileSync(
        resolve(process.cwd(), 'tests/fixtures/fluid-usdc-bridge-native-2026-10-08', record.file),
      )
      expect(bytes.length).toBe(record.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.fileSha256)
    }
    const f = fixture()
    expect(
      decodeFluidUsdcBridgeJointNativeHistoryEvidence(f.historical.evidence)?.frames,
    ).toHaveLength(12)
    const model = issuedFluidUsdcBridgeJointHolderForecast(
      f.capacity,
      f.historical.evidence,
      f.question,
    )
    expect(model).not.toBeNull()
    expect(model?.issueAtUtc).toBe(f.historical.issuedAtUtc)
    expect(model?.targetAtUtc).toBe(new Date(f.question.asOfMs + 3600000).toISOString())
    expect(model?.MRaw).toBeNull()
    expect(model?.originalAuthority).toBe(false)
    expect(model?.authenticated).toBe(false)
    expect(
      fluidUsdcBridgeJointHolderForecastFromResponse(f.response, 200, f.question),
    ).not.toBeNull()
    expect(
      fluidUsdcBridgeJointHolderForecastFromResponse(
        { ...f.response, error: 'holder_exit_assessment_unavailable' },
        503,
        f.question,
      ),
    ).not.toBeNull()
  })
  it('rejects unsupported twenty-anchor payloads, malformed native ABI and route drift', () => {
    const f = fixture(),
      tooMany = structuredClone(f.historical.evidence)
    tooMany.captures.push(
      structuredClone(tooMany.captures[0]),
      structuredClone(tooMany.captures[1]),
    )
    expect(issuedFluidUsdcBridgeJointHolderForecast(f.capacity, tooMany, f.question)).toBeNull()
    const malformed = structuredClone(f.historical.evidence)
    const fullEa = malformed.captures[0].anchors[0].origins[0].traces.find(
      (trace) => trace.key === 'full_net_ea',
    )
    expect(fullEa).toBeDefined()
    // A truncated native uint256 return cannot round-trip canonical previewRedeem ABI.
    // bodySha256 alone is a diagnostic raw-record hash, not decoded native facts.
    fullEa!.response.result = '0x01'
    expect(issuedFluidUsdcBridgeJointHolderForecast(f.capacity, malformed, f.question)).toBeNull()
    expect(
      issuedFluidUsdcBridgeJointHolderForecast(f.capacity, f.historical.evidence, {
        ...f.question,
        destination: '0x' + '1'.repeat(40),
      }),
    ).toBeNull()
    expect(
      issuedFluidUsdcBridgeJointHolderForecast(f.capacity, f.historical.evidence, {
        ...f.question,
        requestedRaw: '2000000',
      }),
    ).toBeNull()
    expect(
      issuedFluidUsdcBridgeJointHolderForecast(f.capacity, f.historical.evidence, {
        ...f.question,
        asOfMs: Date.parse(f.capacity.quote.source.blockTime) + 1800001,
      }),
    ).toBeNull()
  })
  it('keeps accessors and oversized current trees rejected under their original boundary', () => {
    const f = fixture()
    let reads = 0
    Object.defineProperty(f.historical.evidence, 'codes', {
      enumerable: true,
      get() {
        reads++
        return historicalOriginal.evidence.codes
      },
    })
    expect(
      issuedFluidUsdcBridgeJointHolderForecast(f.capacity, f.historical.evidence, f.question),
    ).toBeNull()
    expect(reads).toBe(0)
    const g = fixture(),
      current = {
        ...g.capacity,
        unsupportedOrigins: Array.from({ length: 1500 }, () => ({ native: [1, 2, 3, 4, 5, 6] })),
      }
    expect(
      issuedFluidUsdcBridgeJointHolderForecast(current, g.historical.evidence, g.question),
    ).toBeNull()
  })
  it('renders the real offline private band and prevents mutated payloads or cloned receipts replacing it', () => {
    const f = fixture()
    const retained = holderFluidUsdcBridgeJointIssueFromResponse(
      f.response,
      200,
      f.question,
      f.question.asOfMs + 1,
    )
    expect(retained).not.toBeNull()
    const model = selectedFluidUsdcBridgeJointHolderForecastFromIssue(
      retained!.issue,
      retained!.question,
      f.question.asOfMs + 1,
    )
    expect(model).not.toBeNull()
    const summary = model!.process.targetSummary
    expect(summary).not.toBeNull()
    const band = `${formatExitPressureSignedRaw(summary!.empiricalP10HeadroomRaw, 6)}–${formatExitPressureSignedRaw(summary!.empiricalP90HeadroomRaw, 6)} USDC`
    expect(render(retained!)).toContain(band)
    f.capacity.quote.entitlementRaw = '0'
    f.historical.evidence.captures.length = 0
    expect(
      selectedFluidUsdcBridgeJointHolderForecastFromIssue(
        retained!.issue,
        retained!.question,
        f.question.asOfMs + 1,
      ),
    ).toBe(model)
    expect(render(retained!)).toContain(band)
    const cloned = { ...retained!, issue: structuredClone(retained!.issue) }
    expect(
      selectedFluidUsdcBridgeJointHolderForecastFromIssue(
        cloned.issue,
        cloned.question,
        f.question.asOfMs + 1,
      ),
    ).toBeNull()
    expect(render(cloned)).not.toContain(band)
  })
})
