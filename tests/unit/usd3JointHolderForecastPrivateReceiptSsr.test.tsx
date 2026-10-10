import React from 'react'
import { readFileSync } from 'node:fs'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, keccak256, parseAbi } from 'viem'
import {
  ExitPressureCard,
  formatExitPressureSignedRaw,
  type ExitPressureCardProps,
  type ExitPressureUsd3JointIssue,
} from '@/components/Carry/ExitPressureCard'
import { holderUsd3JointIssueFromResponse } from '@/components/Carry/ForecastWorkbench'
import { encodeUsd3JointNativeHistoryEvidence } from '@/lib/carry/usd3JointNativeEvidenceCodec'
import { resolveUsd3JointTrustedProfile } from '@/lib/carry/usd3JointTrustedProfile'
import {
  issuedUsd3JointHolderForecast,
  selectedUsd3JointHolderForecastFromIssue,
} from '@/lib/carry/usd3JointHolderForecastBinding'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
  type HolderExitCapacityFacts,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import type { Usd3NativeCapacityFact } from '@/lib/carry/usd3ExitQuote'
import { buildCanonicalAtomicHolderExitSubjects } from '@/lib/carry/holderExitMechanisms'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import { ROUTES } from '@/components/Carry/fixtures'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import config from '@/tools/venue-recorder.config.json'

buildCanonicalAtomicHolderExitSubjects(
  buildCarryForecastRegistry(
    ROUTES,
    seed,
    config.venues,
    '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    verifiedDirectSupplyDestinations(),
  ),
)
const AT = Date.parse('2026-10-08T12:15:00.000Z')
const base: ExitPressureCardProps = {
  routeKey: 'USDC → USD3 [USDC]',
  destination: '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
  requestedAmount: '1',
  requestedRaw: '1000000',
  requestedAssetSymbol: 'USDC',
  requestedAssetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  requestedAssetDecimals: 6,
  requestedHolderAddress: '0x' + 'c'.repeat(40),
  horizonHours: 1,
  asOfMs: AT,
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
const profile = resolveUsd3JointTrustedProfile(
  base.routeKey,
  base.destination,
  base.requestedAssetAddress!,
)!
const abi = parseAbi(['function availableWithdrawLimit(address) view returns (uint256)'])
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0')
function fixture() {
  const raw = JSON.parse(
    readFileSync(
      new URL(
        '../../data/research/venue-signals/usd3-joint-native-history-evidence-2026-10-08/native-originals/01-native-historical-capture.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const history = structuredClone(encodeUsd3JointNativeHistoryEvidence(raw))
  // Controlled unsigned facts exercise the genuine private issuer. This fixture
  // deliberately claims no original RPC authority or historical ownership.
  history.subject.withdrawalLimitSubject = base.requestedHolderAddress!
  for (const origin of history.origins)
    for (const anchor of origin.anchors) {
      const trace = anchor.find((t) => t.key === 'withdrawal_limit')!
      ;(trace.request.params[0] as { data: string }).data = encodeFunctionData({
        abi,
        functionName: 'availableWithdrawLimit',
        args: [base.requestedHolderAddress as `0x${string}`],
      })
      trace.response = { jsonrpc: '2.0', id: trace.request.id, result: word(2_000_000n) }
    }
  const source = {
    chainId: 1 as const,
    blockNumber: 26150000,
    blockHash: '0x' + 'f'.repeat(64),
    blockTime: '2026-10-08T12:05:00.000Z',
    finalized: true as const,
  }
  const question = {
    routeKey: base.routeKey,
    destination: base.destination,
    requestedRaw: base.requestedRaw,
    requestedAssetAddress: base.requestedAssetAddress,
    requestedAssetDecimals: base.requestedAssetDecimals,
    requestedHolderAddress: base.requestedHolderAddress,
    horizonHours: 1,
    independentSource: structuredClone(source),
  }
  const assessment = {
    status: 'partial',
    routeKey: base.routeKey,
    destinationAddress: base.destination,
    owner: base.requestedHolderAddress,
    request: {
      assetsRaw: base.requestedRaw,
      assetAddress: base.requestedAssetAddress,
      horizonHours: 1,
    },
    source: { ...source, originValidation: 'single_provider' },
    stages: [],
    finalPayout: {
      status: 'unavailable',
      assetAddress: base.requestedAssetAddress,
      amountRaw: null,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  } as unknown as HolderExitAssessment
  const native: Usd3NativeCapacityFact = {
    owner: base.requestedHolderAddress!,
    method: 'availableWithdrawLimit(address)',
    asset: base.requestedAssetAddress as `0x${string}`,
    assetDecimals: 6,
    unit: 'raw_usdc_6',
    capacityRaw: '2000000',
    resultStatus: 'quoted',
    shutdown: false,
    readAtUtc: '2026-10-08T12:11:00.000Z',
    source,
    runtimeProfile: {
      sourceClass: 'pinned_usd3_native_runtime',
      shareDecimals: 6,
      contracts: profile.runtimePins.map((p) => ({
        address: p.address,
        code: history.codeDictionary[p.key] as `0x${string}`,
        keccak256: keccak256(history.codeDictionary[p.key] as `0x${string}`),
      })) as NonNullable<Usd3NativeCapacityFact['runtimeProfile']>['contracts'],
    },
  }
  const facts: HolderExitCapacityFacts = {
    entitlementRaw: '1000000',
    fullPositionEntitlementRaw: '1000000',
    quotedMaxWithdrawRaw: '5',
    quotedMaxWithdrawStatus: 'quoted',
    effectiveLimitRaw: null,
    withdrawalsPaused: null,
    sourceHolderPosition: {
      sharesRaw: history.subject.sharesRaw,
      shareDecimals: 6,
      method: 'balance_of_owner_at_source',
    },
    usd3NativeCapacity: native,
  }
  const quote = buildHolderExitCapacityQuote(assessment, facts, AT)!
  const capacity = agreeHolderExitCapacityQuotes(
    { host: profile.originHosts[0], quote },
    { host: profile.originHosts[1], quote: structuredClone(quote) },
    AT,
  )!
  const response = {
    capacityAgreement: capacity,
    usd3JointHistoricalEvidence: history,
    usd3JointIssuedAtUtc: new Date(AT).toISOString(),
  }
  const retained = holderUsd3JointIssueFromResponse(response, 200, question, AT + 1000)!
  return { history, source, question, capacity, response, retained }
}
function render(
  retained: ExitPressureUsd3JointIssue,
  overrides: Partial<ExitPressureCardProps> = {},
) {
  return renderToStaticMarkup(
    <ChakraProvider>
      <ExitPressureCard {...base} holderUsd3JointIssue={retained} {...overrides} />
    </ChakraProvider>,
  ).replaceAll(/<style[\s\S]*?<\/style>/g, '')
}
function band(retained: ExitPressureUsd3JointIssue) {
  const model = selectedUsd3JointHolderForecastFromIssue(retained.issue, retained.question, AT)!
  const summary = model.process.targetSummary!
  return `${formatExitPressureSignedRaw(summary.empiricalP10HeadroomRaw, 6)}–${formatExitPressureSignedRaw(summary.empiricalP90HeadroomRaw, 6)} USDC`
}
describe('genuine USD3 private receipt SSR boundary', () => {
  it('renders the issued empirical range without granting original native or ownership authority', () => {
    const f = fixture(),
      model = selectedUsd3JointHolderForecastFromIssue(f.retained.issue, f.retained.question, AT)!
    expect(model.authenticated).toBe(false)
    expect(model.historicalOwnership).toBe(false)
    expect(render(f.retained)).toContain(band(f.retained))
    expect(render(f.retained)).toContain('Expected headroom')
  })
  it('cannot authorize mutated same-source current C or changed historical bytes in both origins', () => {
    const f = fixture(),
      original = selectedUsd3JointHolderForecastFromIssue(
        f.retained.issue,
        f.retained.question,
        AT,
      )!
    const originalBand = band(f.retained)
    for (const origin of f.capacity.origins) origin.quote.usd3NativeCapacity!.capacityRaw = '0'
    const changed = agreeHolderExitCapacityQuotes(f.capacity.origins[0], f.capacity.origins[1], AT)!
    const newModel = issuedUsd3JointHolderForecast(changed, f.history, f.retained.question)!
    expect(newModel.process.targetSummary).not.toEqual(original.process.targetSummary)
    f.retained.capacityAgreement = changed
    for (const origin of f.history.origins)
      for (const anchor of origin.anchors) {
        const trace = anchor.find((t) => t.key === 'withdrawal_limit')!
        trace.response = { jsonrpc: '2.0', id: trace.request.id, result: word(0n) }
      }
    expect(render(f.retained)).toContain(originalBand)
    expect(
      selectedUsd3JointHolderForecastFromIssue(f.retained.issue, f.retained.question, AT),
    ).toBe(original)
    expect(original.input.current.availableWithdrawLimitRaw).toBe('2000000')
    expect(original.input.history.every((p) => p.availableWithdrawLimitRaw === '2000000')).toBe(
      true,
    )
  })
  it('rejects cloned receipts, changed question/cutoff/source, and stale render clocks', () => {
    const f = fixture(),
      expected = band(f.retained)
    expect(render({ ...f.retained, issue: structuredClone(f.retained.issue) })).not.toContain(
      expected,
    )
    expect(render({ ...f.retained, issue: { ...f.retained.issue } })).not.toContain(expected)
    expect(
      render({ ...f.retained, question: { ...f.retained.question, asOfMs: AT + 1 } }),
    ).not.toContain(expected)
    expect(
      render({
        ...f.retained,
        question: {
          ...f.retained.question,
          independentSource: { ...f.source, blockHash: '0x' + 'e'.repeat(64) },
        },
      }),
    ).not.toContain(expected)
    for (const change of [
      { requestedRaw: '2000000' },
      { horizonHours: 24 },
      { requestedAssetDecimals: 18 },
      { requestedHolderAddress: '0x' + '2'.repeat(40) },
    ])
      expect(render(f.retained, change)).not.toContain(expected)
    expect(render(f.retained, { asOfMs: AT + 1000 })).toContain(expected)
    expect(render(f.retained, { asOfMs: Date.parse(f.source.blockTime) + 1800001 })).not.toContain(
      expected,
    )
  })
})
