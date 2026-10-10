import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ExitPressureCard,
  formatExitPressureSignedRaw,
  type ExitPressureCardProps,
} from '@/components/Carry/ExitPressureCard'
import { holderFluidUsdtBridgeJointIssueFromResponse } from '@/components/Carry/ForecastWorkbench'
import { selectedFluidUsdtBridgeJointHolderForecastFromIssue } from '@/lib/carry/fluidUsdtBridgeJointHolderForecastBinding'
import { resolveFluidUsdcBridgeJointTrustedProfile } from '@/lib/carry/fluidUsdcBridgeJointTrustedProfile'
import {
  FLUID_USDT_QUOTE_ROUTE as ROUTE,
  FLUID_USDT_QUOTE_CONTRACTS as C,
} from '@/lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec'

// REAL browser binding, Workbench wrapper, original private local receipt and Card.
// Every clean native field here is a controlled unsigned fixture, not new acquisition.
// The existing native originals are neither retimed nor registered by these tests.
const VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012',
  OWNER = '0x' + '1'.repeat(40)
const profile = resolveFluidUsdcBridgeJointTrustedProfile(
  'USDC → FluidBridgeAggregatorProxy [USDC]',
  VAULT,
  C.usdc,
)!
const anchors = profile.anchors.filter((a) => a.cashIndex >= 111 && a.cashIndex <= 118)
const flags = {
  originalAuthority: false,
  authenticated: false,
  executionQualified: false,
  calibrated: false,
  sourceImplementationEquivalence: false,
  noUSDTCapacityAmountBand: true,
  noLinearScaling: true,
  combinedBridgeUSDTExecutionRoute: 'unassessed',
  MRaw: null,
}
const runtimes = {
  ...profile.runtimeCodeHashes,
  [C.factory]: '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69',
  [C.quoter]: '0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b',
  [C.pool]: '0x2ff673bacc60a73fc85c678888296c6bce3de2a9d7475c032fe7aa6e0eacba86',
  [C.usdt]: '0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55',
}
function fixture(H = 168, censored = false, independent = false) {
  const issued = Date.now() - 10,
    sourceMs = Math.floor((issued - 60000) / 1000) * 1000,
    source = {
      chainId: 1 as const,
      blockNumber: 27000000,
      blockHash: '0x' + 'a'.repeat(64),
      blockTime: new Date(sourceMs).toISOString(),
      finalized: true as const,
    },
    acquiredAtUtc = new Date(issued - 1000).toISOString(),
    availableAtUtc = new Date(issued - 500).toISOString()
  const question = {
    routeKey: ROUTE,
    destination: VAULT,
    requestedRaw: '1000000',
    requestedAssetAddress: C.usdt,
    requestedAssetDecimals: 6,
    requestedHolderAddress: OWNER,
    horizonHours: H,
    ...(independent ? { independentSource: source } : {}),
  }
  const frame = (s: any, owner: string | null, n: number) => ({
    source: {
      chainId: 1,
      blockNumber: String(s.blockNumber),
      blockHash: s.blockHash,
      blockTime: s.blockTime,
    },
    acquiredAtUtc,
    availableAtUtc,
    provenanceRef: 'controlled_unsigned_' + n,
    profileId: 'fluid-usdt-bridge-same-pool-quote-funding-v1',
    holderSharesRaw: '1000000000000000000',
    shareDecimals: 18,
    fullHolderNetUsdcRaw: censored && n === 0 ? '10000000000' : '2000000',
    nativeProngs: {
      bridgeFunding: '10000000',
      bankCash: '10000000',
      bankSupply: '10000000',
      bankWithdrawableUntilLimit: '10000000',
      bankResolverWithdrawable: '10000000',
    },
    withdrawalFeeBps: 5,
    paused: false,
    runtimeCodeHashes: runtimes,
    sourceClass: 'captured_identical_runtimes_only',
    owner,
    historicalOwnership: false,
    provenanceKind: owner ? 'native_current_full_position' : 'native_hypothetical_shares',
    conversion: {
      factory: C.factory,
      quoter: C.quoter,
      pool: C.pool,
      fee: 100,
      method: 'quoteExactOutputSingle',
      inputAsset: C.usdc,
      inputDecimals: 6,
      outputAsset: C.usdt,
      outputDecimals: 6,
      fixedFinalUsdtOutputRaw: '1000000',
      requiredNetUsdcRaw: '999511',
    },
  })
  const current = { ...frame(source, OWNER, -1), readAtUtc: new Date(issued - 2000).toISOString() }
  const history = {
    schema: 'fluid_usdt_bridge_joint_historical_evidence_v1',
    points: anchors.map((a, n) => frame(a.source, null, n)),
    sharesRaw: current.holderSharesRaw,
    requestedFinalUsdtRaw: '1000000',
    acquiredAtUtc,
    availableAtUtc,
    owner: null,
    historicalOwnership: false,
    ...flags,
  }
  const response = {
    fluidUsdtBridgeJointIssuedAtUtc: new Date(issued).toISOString(),
    fluidUsdtBridgeJointCurrentEvidence: {
      schema: 'fluid_usdt_bridge_joint_current_evidence_v1',
      source,
      current,
      roundtripUsdtRaw: '1000000',
      ...flags,
    },
    fluidUsdtBridgeJointHistoricalEvidence: history,
  }
  return { question, response, issued, source, current, history }
}
function props(f: ReturnType<typeof fixture>): ExitPressureCardProps {
  return {
    routeKey: ROUTE,
    destination: VAULT,
    requestedAmount: '1',
    requestedRaw: '1000000',
    requestedAssetSymbol: 'USDT',
    requestedAssetAddress: C.usdt,
    requestedAssetDecimals: 6,
    requestedHolderAddress: OWNER,
    horizonHours: f.question.horizonHours,
    asOfMs: Date.now(),
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
}
function render(
  f: ReturnType<typeof fixture>,
  retained: any,
  changes: Partial<ExitPressureCardProps> = {},
) {
  return renderToStaticMarkup(
    <ChakraProvider>
      <ExitPressureCard {...props(f)} holderFluidUsdtBridgeJointIssue={retained} {...changes} />
    </ChakraProvider>,
  ).replaceAll(/<style[\s\S]*?<\/style>/g, '')
}
const expectedMargin = `${formatExitPressureSignedRaw('1000489', 6)}–${formatExitPressureSignedRaw('1000489', 6)} USDC`
describe('same-pool USDT JSON → Workbench original issue → existing Card metric', () => {
  it.each([3, 168, 8760])('renders conditional USDC margin for USDT Q at exact H=%s', (H) => {
    const f = fixture(H),
      received = Date.now(),
      wire = JSON.parse(JSON.stringify(f.response))
    const retained = holderFluidUsdtBridgeJointIssueFromResponse(wire, 200, f.question, received)
    expect(retained).not.toBeNull()
    const model = selectedFluidUsdtBridgeJointHolderForecastFromIssue(
      retained!.issue,
      retained!.question,
      Date.now(),
    )
    expect(model).not.toBeNull()
    expect(model!.process.targetSummary!.marginBand.p10Raw).toBe('1000489')
    expect(model!.sharesRaw).toBe('1000000000000000000')
    expect(model!.requestedFinalUsdtRaw).toBe('1000000')
    expect(model!.process.input.current.fullHolderNetUsdcRaw).toBe('2000000')
    expect(model!.MRaw).toBeNull()
    const html = render(f, retained)
    expect(html).toContain('Conditional quote-funding margin')
    expect(html).toContain(expectedMargin)
    expect(html).toContain('CONDITIONAL QUOTE FUNDING')
    expect(html).not.toContain('1.000489 USDT')
    expect(retained!.issue.authenticated).toBe(false)
    expect(retained!.issue.executionQualified).toBe(false)
  })
  it('accepts only canonical partial503 and keeps the original selected model across external mutations', () => {
    const f = fixture(),
      response = { ...f.response, error: 'holder_exit_assessment_unavailable' }
    const retained = holderFluidUsdtBridgeJointIssueFromResponse(
      JSON.parse(JSON.stringify(response)),
      503,
      f.question,
      Date.now(),
    )!
    expect(retained).not.toBeNull()
    const original = selectedFluidUsdtBridgeJointHolderForecastFromIssue(
      retained.issue,
      retained.question,
      Date.now(),
    )
    f.response.fluidUsdtBridgeJointCurrentEvidence.current.fullHolderNetUsdcRaw = '0'
    f.response.fluidUsdtBridgeJointHistoricalEvidence.points[0].conversion.requiredNetUsdcRaw = '1'
    expect(
      selectedFluidUsdtBridgeJointHolderForecastFromIssue(
        retained.issue,
        retained.question,
        Date.now(),
      ),
    ).toBe(original)
    expect(render(f, retained)).toContain(expectedMargin)
    expect(
      holderFluidUsdtBridgeJointIssueFromResponse(
        { ...response, error: 'other_error' },
        503,
        f.question,
        Date.now(),
      ),
    ).toBeNull()
    expect(
      holderFluidUsdtBridgeJointIssueFromResponse(response, 500, f.question, Date.now()),
    ).toBeNull()
  })
  it('preserves censored paths and renders — instead of a numeric margin band', () => {
    const f = fixture(168, true),
      retained = holderFluidUsdtBridgeJointIssueFromResponse(
        f.response,
        200,
        f.question,
        Date.now(),
      )!
    expect(retained).not.toBeNull()
    const model = selectedFluidUsdtBridgeJointHolderForecastFromIssue(
      retained.issue,
      retained.question,
      Date.now(),
    )!
    expect(model.counts.censored).toBeGreaterThan(0)
    expect(model.process.targetSummary).toBeNull()
    const html = render(f, retained)
    expect(html).toContain('Conditional quote-funding margin')
    expect(html).toContain('—')
    expect(html).not.toContain(expectedMargin)
  })
  it.each(['owner', 'Q', 'H', 'asset', 'issue_clone'] as const)(
    'cannot select a retained original receipt after %s drift',
    (field) => {
      const f = fixture(),
        retained = holderFluidUsdtBridgeJointIssueFromResponse(
          f.response,
          200,
          f.question,
          Date.now(),
        )!
      expect(retained).not.toBeNull()
      const originalQuestion = structuredClone(retained.question),
        model = selectedFluidUsdtBridgeJointHolderForecastFromIssue(
          retained.issue,
          originalQuestion,
          Date.now(),
        )
      const changed = { ...retained, question: { ...retained.question } }
      if (field === 'owner') changed.question.requestedHolderAddress = '0x' + '2'.repeat(40)
      if (field === 'Q') changed.question.requestedRaw = '999999'
      if (field === 'H') changed.question.horizonHours = 3
      if (field === 'asset') changed.question.requestedAssetAddress = C.usdc
      if (field === 'issue_clone') changed.issue = JSON.parse(JSON.stringify(changed.issue))
      expect(render(f, changed)).not.toContain(expectedMargin)
      expect(
        selectedFluidUsdtBridgeJointHolderForecastFromIssue(
          retained.issue,
          originalQuestion,
          Date.now(),
        ),
      ).toBe(model)
      expect(render(f, retained)).toContain(expectedMargin)
    },
  )
  it.each(['envelope_question', 'envelope_issue', 'question_Q', 'source_hash'] as const)(
    'rejects %s accessor props without invoking them or tearing SSR',
    (field) => {
      const f = fixture(168, false, true),
        retained = holderFluidUsdtBridgeJointIssueFromResponse(
          f.response,
          200,
          f.question,
          Date.now(),
        )!
      expect(retained).not.toBeNull()
      const original = selectedFluidUsdtBridgeJointHolderForecastFromIssue(
        retained.issue,
        retained.question,
        Date.now(),
      )
      const forged: any = {
        question: {
          ...retained.question,
          independentSource: { ...retained.question.independentSource },
        },
        issue: retained.issue,
      }
      let invoked = 0
      const get = () => {
        invoked++
        throw Error('must_not_run')
      }
      if (field === 'envelope_question')
        Object.defineProperty(forged, 'question', { enumerable: true, get })
      if (field === 'envelope_issue')
        Object.defineProperty(forged, 'issue', { enumerable: true, get })
      if (field === 'question_Q')
        Object.defineProperty(forged.question, 'requestedRaw', { enumerable: true, get })
      if (field === 'source_hash')
        Object.defineProperty(forged.question.independentSource, 'blockHash', {
          enumerable: true,
          get,
        })
      expect(() => render(f, forged)).not.toThrow()
      expect(render(f, forged)).not.toContain(expectedMargin)
      expect(invoked).toBe(0)
      expect(
        selectedFluidUsdtBridgeJointHolderForecastFromIssue(
          retained.issue,
          retained.question,
          Date.now(),
        ),
      ).toBe(original)
      expect(render(f, retained)).toContain(expectedMargin)
    },
  )
  it('rejects malformed descriptor, symbol, nonplain and throwing proxy envelopes without tearing SSR', () => {
    const f = fixture(),
      retained = holderFluidUsdtBridgeJointIssueFromResponse(
        f.response,
        200,
        f.question,
        Date.now(),
      )!
    expect(retained).not.toBeNull()
    const hidden = { ...retained }
    Object.defineProperty(hidden, 'question', { enumerable: false, value: retained.question })
    const symbol = { ...retained, [Symbol('foreign')]: 1 }
    const nonplain = Object.assign(Object.create(null), retained)
    const proxy = new Proxy(
      { ...retained },
      {
        ownKeys() {
          throw Error('descriptor_trap')
        },
      },
    )
    const issueFields: any = { question: retained.question, issue: { ...retained.issue } }
    let invoked = 0
    Object.defineProperty(issueFields.issue, 'requestedRaw', {
      enumerable: true,
      get() {
        invoked++
        throw Error('must_not_run')
      },
    })
    for (const forged of [hidden, symbol, nonplain, proxy, issueFields]) {
      expect(() => render(f, forged)).not.toThrow()
      expect(render(f, forged)).not.toContain(expectedMargin)
    }
    expect(invoked).toBe(0)
    expect(render(f, retained)).toContain(expectedMargin)
  })
  it('keeps staged own-source selection without unrelated cash, but enforces a declared independent source', () => {
    const f = fixture(168, false, true),
      retained = holderFluidUsdtBridgeJointIssueFromResponse(
        f.response,
        200,
        f.question,
        Date.now(),
      )!
    expect(retained).not.toBeNull()
    const currentCash = {
      routeKey: ROUTE,
      destination: VAULT,
      cashRaw: '10000000',
      assetDecimals: 6,
      assetSymbol: 'USDC',
      assetAddress: C.usdc,
      observedAt: f.source.blockTime,
      block: String(f.source.blockNumber),
      blockHash: f.source.blockHash,
      freshness: 'fresh' as const,
      label: 'Vault cash' as const,
    }
    expect(render(f, retained, { currentCash })).toContain(expectedMargin)
    expect(
      render(f, retained, { currentCash: { ...currentCash, blockHash: '0x' + 'b'.repeat(64) } }),
    ).not.toContain(expectedMargin)
    expect(
      selectedFluidUsdtBridgeJointHolderForecastFromIssue(
        retained.issue,
        retained.question,
        Date.now(),
      ),
    ).not.toBeNull()
  })
  it('never invokes an accessor issue stamp and rejects non-enumerable or malformed stamps', () => {
    const f = fixture()
    let invoked = 0
    const accessor = { ...f.response }
    Object.defineProperty(accessor, 'fluidUsdtBridgeJointIssuedAtUtc', {
      enumerable: true,
      get() {
        invoked++
        throw Error('must_not_run')
      },
    })
    expect(() =>
      holderFluidUsdtBridgeJointIssueFromResponse(accessor, 200, f.question, Date.now()),
    ).not.toThrow()
    expect(
      holderFluidUsdtBridgeJointIssueFromResponse(accessor, 200, f.question, Date.now()),
    ).toBeNull()
    expect(invoked).toBe(0)
    const hidden = { ...f.response }
    Object.defineProperty(hidden, 'fluidUsdtBridgeJointIssuedAtUtc', {
      enumerable: false,
      value: f.response.fluidUsdtBridgeJointIssuedAtUtc,
    })
    expect(
      holderFluidUsdtBridgeJointIssueFromResponse(hidden, 200, f.question, Date.now()),
    ).toBeNull()
    expect(
      holderFluidUsdtBridgeJointIssueFromResponse(
        { ...f.response, fluidUsdtBridgeJointIssuedAtUtc: 7 },
        200,
        f.question,
        Date.now(),
      ),
    ).toBeNull()
  })
  it('never invokes an accessor question field before the descriptor-safe binding', () => {
    const f = fixture()
    let invoked = 0
    const question = { ...f.question }
    Object.defineProperty(question, 'requestedRaw', {
      enumerable: true,
      get() {
        invoked++
        throw Error('must_not_run')
      },
    })
    expect(() =>
      holderFluidUsdtBridgeJointIssueFromResponse(f.response, 200, question, Date.now()),
    ).not.toThrow()
    expect(
      holderFluidUsdtBridgeJointIssueFromResponse(f.response, 200, question, Date.now()),
    ).toBeNull()
    expect(invoked).toBe(0)
    const nested = { ...f.question, independentSource: { ...f.source } }
    Object.defineProperty(nested.independentSource, 'blockHash', {
      enumerable: true,
      get() {
        invoked++
        throw Error('must_not_run')
      },
    })
    expect(
      holderFluidUsdtBridgeJointIssueFromResponse(f.response, 200, nested, Date.now()),
    ).toBeNull()
    expect(invoked).toBe(0)
  })
  it('rejects late availability, bad roundtrip, wrong Q/units and future server issue before local issuance', () => {
    for (const mutate of [
      (r: any) => (r.fluidUsdtBridgeJointCurrentEvidence.roundtripUsdtRaw = '999999'),
      (r: any) => (r.fluidUsdtBridgeJointCurrentEvidence.current.conversion.outputDecimals = 18),
      (r: any) =>
        (r.fluidUsdtBridgeJointCurrentEvidence.current.availableAtUtc = new Date(
          Date.now() + 60000,
        ).toISOString()),
      (r: any) => (r.fluidUsdtBridgeJointIssuedAtUtc = new Date(Date.now() + 60000).toISOString()),
    ]) {
      const f = fixture(),
        response = structuredClone(f.response)
      mutate(response)
      expect(
        holderFluidUsdtBridgeJointIssueFromResponse(response, 200, f.question, Date.now()),
      ).toBeNull()
    }
    const f = fixture()
    expect(
      holderFluidUsdtBridgeJointIssueFromResponse(
        f.response,
        200,
        { ...f.question, requestedRaw: '999999' },
        Date.now(),
      ),
    ).toBeNull()
  })
})

describe('conditional cash boundary row from the exact selected private model', () => {
  function cashFixture(H: number) {
    const f = fixture(H, false, true)
    f.history.points.forEach((p, n) => {
      p.nativeProngs.bankCash = n === 0 ? '10000000' : '5000000'
      p.nativeProngs.bankResolverWithdrawable = p.nativeProngs.bankCash
    })
    return f
  }
  it('shows one correlated cash boundary while the censored margin stays dashed and the model unchanged', () => {
    const f = cashFixture(168),
      retained = holderFluidUsdtBridgeJointIssueFromResponse(
        f.response,
        200,
        f.question,
        Date.now(),
      )!
    expect(retained).not.toBeNull()
    const model = selectedFluidUsdtBridgeJointHolderForecastFromIssue(
      retained.issue,
      retained.question,
      Date.now(),
    )!
    const before = JSON.stringify(model)
    expect(model.process.targetSummary).toBeNull()
    const html = render(f, retained)
    expect(html).toContain('Projected cash depletion')
    expect(html).toContain('24\u201348h \u00b7 1/7 paths')
    expect(html).toContain('Conditional quote-funding margin')
    expect(html).toContain('—')
    expect(model.process.targetSummary).toBeNull()
    expect(JSON.stringify(model)).toBe(before)
    expect(model.MRaw).toBeNull()
  })
  it.each([3, 24])('does not add a boundary row before it is diagnosed at H=%s', (H) => {
    const f = cashFixture(H),
      retained = holderFluidUsdtBridgeJointIssueFromResponse(
        f.response,
        200,
        f.question,
        Date.now(),
      )!
    expect(retained).not.toBeNull()
    expect(render(f, retained)).not.toContain('Projected cash depletion')
    expect(render(f, retained)).toContain(expectedMargin)
  })
  it.each(['owner', 'Q', 'H', 'source', 'receipt_clone'] as const)(
    'hides the cash diagnostic on %s mismatch without changing the original model',
    (kind) => {
      const f = cashFixture(168),
        retained = holderFluidUsdtBridgeJointIssueFromResponse(
          f.response,
          200,
          f.question,
          Date.now(),
        )!
      expect(retained).not.toBeNull()
      const original = selectedFluidUsdtBridgeJointHolderForecastFromIssue(
        retained.issue,
        retained.question,
        Date.now(),
      )
      const changed = { ...retained, question: structuredClone(retained.question) }
      if (kind === 'owner') changed.question.requestedHolderAddress = '0x' + '2'.repeat(40)
      if (kind === 'Q') changed.question.requestedRaw = '999999'
      if (kind === 'H') changed.question.horizonHours = 3
      if (kind === 'source') changed.question.independentSource!.blockHash = '0x' + 'b'.repeat(64)
      if (kind === 'receipt_clone') changed.issue = structuredClone(retained.issue)
      expect(render(f, changed)).not.toContain('Projected cash depletion')
      expect(
        selectedFluidUsdtBridgeJointHolderForecastFromIssue(
          retained.issue,
          retained.question,
          Date.now(),
        ),
      ).toBe(original)
      expect(render(f, retained)).toContain('Projected cash depletion')
    },
  )
})

describe('cash depletion label excludes availability and withdrawal constraints', () => {
  it.each(['bridgeFunding', 'bankResolverWithdrawable'] as const)(
    'keeps %s-only negative paths censored without claiming physical cash depletion',
    (key) => {
      const f = fixture(168, false, true)
      f.history.points.forEach((p, n) => {
        p.nativeProngs[key] = n === 0 ? '10000000' : '5000000'
      })
      const retained = holderFluidUsdtBridgeJointIssueFromResponse(
        f.response,
        200,
        f.question,
        Date.now(),
      )!
      expect(retained).not.toBeNull()
      const model = selectedFluidUsdtBridgeJointHolderForecastFromIssue(
        retained.issue,
        retained.question,
        Date.now(),
      )!
      const before = JSON.stringify(model)
      expect(model.counts.censored).toBe(1)
      expect(model.process.targetSummary).toBeNull()
      const html = render(f, retained)
      expect(html).toContain('Conditional quote-funding margin')
      expect(html).toContain('\u2014')
      expect(html).not.toContain('Projected cash depletion')
      expect(JSON.stringify(model)).toBe(before)
    },
  )
})
