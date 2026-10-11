import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import handler, {
  withFluidUsdtBridgeJointHistoricalEvidence,
  parseHolderExitAssessmentRequest,
} from '@/pages/api/carry/holder-exit-assessment'
import { validateHolderExitAssessmentRequest } from '@/lib/carry/holderExitAssessment'
import {
  FLUID_USDT_QUOTE_ROUTE,
  FLUID_USDT_QUOTE_CONTRACTS as C,
} from '@/lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec'

// Controlled API orchestration. Saved inspection facts are unsigned fixtures;
// protected current/history selectors and finalized execution readers are mocked.
// These controls cannot invoke native providers or write real research originals.
const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  current: vi.fn(),
  history: vi.fn(),
  selectHistory: vi.fn(),
  read: vi.fn(),
  tracked: vi.fn(),
  actualRead: null as any,
  now: 0,
  fact: null as any,
  original: null as any,
  finalized: null as any,
}))
vi.mock('@/lib/carry/fluidUsdtBridgeNativeCapacity.server', () => ({
  acquireFluidUsdtBridgeNativeCapacity: mocks.acquire,
  selectedOriginalFluidUsdtBridgeNativeCapacity: mocks.current,
}))
vi.mock('@/lib/carry/fluidUsdtBridgeJointHistoricalEvidence.server', () => ({
  readFluidUsdtBridgeJointHistoricalEvidenceAtIssue: mocks.history,
  selectedOriginalFluidUsdtBridgeJointHistoricalEvidence: mocks.selectHistory,
}))
vi.mock('@/lib/carry/holderExitAssessment', async (original) => {
  const actual = await original<typeof import('@/lib/carry/holderExitAssessment')>()
  mocks.actualRead = actual.readHolderExitAssessment
  return { ...actual, readHolderExitAssessment: mocks.read }
})
vi.mock('@/lib/carry/trackedDirectVaultExit', async (original) => ({
  ...(await original<typeof import('@/lib/carry/trackedDirectVaultExit')>()),
  readTrackedDirectVaultExit: mocks.tracked,
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => ({})),
}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', () => ({
  readProviderPolicy: () => ({ status: 'active' }),
  configuredProviders: () => [
    { url: 'https://eth-mainnet.g.alchemy.com/v2/unit-no-native' },
    { url: 'https://rpc.ankr.com/eth/unit-no-native' },
  ],
}))
vi.mock('@/lib/game/rateLimit', () => ({
  checkRateLimit: async () => ({ allowed: true }),
  getClientIp: () => '127.0.0.1',
}))
const bytes = readFileSync(
  join(
    process.cwd(),
    'data/research/venue-signals/fluid-usdt-native-current-inspection-2026-10-09-f93ee33c-9cef-4e9c-ba6e-6abb131d1a1a.json',
  ),
)
if (
  createHash('sha256').update(bytes).digest('hex') !==
  '88f6f69ac2f6793af428f71863c42b5762e0af44c20361efe57ccf803f9304c0'
)
  throw Error('inspection fixture drift')
const observed = JSON.parse(bytes.toString()).fact
const input = {
  routeKey: FLUID_USDT_QUOTE_ROUTE,
  destinationAddress: '0x273da948aca9261043fbdb2a857bc255ecc29012' as const,
  owner: observed.owner,
  assetsRaw: '1000000',
  firstLegUsdcRaw: '777777',
  horizonHours: 168,
}
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b)
beforeEach(() => {
  mocks.now = Date.parse('2026-10-09T06:16:00.000Z')
  vi.spyOn(Date, 'now').mockImplementation(() => mocks.now)
  mocks.fact = structuredClone(observed)
  mocks.original = Object.freeze({ fact: mocks.fact, controlledOriginalOnly: true })
  mocks.finalized = null
  mocks.acquire.mockReset().mockResolvedValue(mocks.original)
  mocks.current
    .mockReset()
    .mockImplementation((p, b) =>
      p === mocks.original &&
      b.owner === input.owner &&
      b.requestedFinalUsdtRaw === input.assetsRaw &&
      same(b.source, mocks.fact.source) &&
      b.asOfMs >= Date.parse(mocks.fact.availableAtUtc) &&
      b.asOfMs <= mocks.now &&
      mocks.now - Date.parse(b.source.blockTime) <= 1800000
        ? mocks.fact
        : null,
    )
  mocks.history.mockReset().mockImplementation(async (p, b) => {
    if (p !== mocks.original || !same(b.source, mocks.fact.source)) return null
    mocks.now += 1000
    const availableAtUtc = new Date(mocks.now - 1).toISOString()
    mocks.finalized = {
      evidence: Object.freeze({
        schema: 'fluid_usdt_bridge_joint_historical_evidence_v1',
        points: Object.freeze(
          Array.from({ length: 8 }, () => Object.freeze({ controlledHistoryOnly: true })),
        ),
        sharesRaw: mocks.fact.sharesRaw,
        requestedFinalUsdtRaw: input.assetsRaw,
        owner: null,
        historicalOwnership: false,
        acquiredAtUtc: new Date(mocks.now - 100).toISOString(),
        availableAtUtc,
        originalAuthority: false,
        authenticated: false,
        executionQualified: false,
        calibrated: false,
        sourceImplementationEquivalence: false,
        noUSDTCapacityAmountBand: true,
        noLinearScaling: true,
        combinedBridgeUSDTExecutionRoute: 'unassessed',
        MRaw: null,
      }),
      issuedAtUtc: new Date(mocks.now).toISOString(),
    }
    return mocks.finalized
  })
  mocks.selectHistory
    .mockReset()
    .mockImplementation((v, p, b) =>
      v === mocks.finalized &&
      p === mocks.original &&
      same(b.source, mocks.fact.source) &&
      b.requestedFinalUsdtRaw === input.assetsRaw
        ? mocks.finalized.evidence.points
        : null,
    )
  mocks.read.mockReset().mockImplementation(async () => assessment())
  mocks.tracked
    .mockReset()
    .mockResolvedValue({ simulation: { status: 'success' }, source: { ...observed.source } })
})
afterEach(() => vi.restoreAllMocks())
function assessment(overrides: any = {}) {
  return {
    status: 'partial',
    routeKey: input.routeKey,
    destinationAddress: input.destinationAddress,
    owner: input.owner,
    request: { assetsRaw: input.assetsRaw, assetAddress: C.usdt, horizonHours: input.horizonHours },
    source: {
      chainId: 1,
      blockNumber: observed.source.blockNumber,
      blockHash: observed.source.blockHash,
      blockTime: observed.source.blockTime,
      originValidation: 'single_provider',
    },
    stages: [
      {
        name: 'usdc_vault_withdrawal',
        assetAddress: C.usdc,
        status: 'simulated',
        amountRaw: input.firstLegUsdcRaw,
        relatedToRequest: false,
      },
      {
        name: 'usdc_to_usdt_conversion',
        assetAddress: C.usdt,
        status: 'unassessed',
        amountRaw: null,
        relatedToRequest: false,
      },
      {
        name: 'usdt_delivery',
        assetAddress: C.usdt,
        status: 'unassessed',
        amountRaw: null,
        relatedToRequest: true,
      },
    ],
    finalPayout: { assetAddress: C.usdt, status: 'unassessed', amountRaw: null },
    condition: null,
    ...overrides,
  }
}
async function request(body: any = input) {
  let code = 0,
    response: any
  const res = {
    setHeader: vi.fn(),
    status(n: number) {
      code = n
      return this
    },
    json(v: any) {
      response = v
      return this
    },
  }
  await handler(
    { method: 'POST', headers: {}, body, socket: { remoteAddress: '127.0.0.1' } } as never,
    res as never,
  )
  return { code, response }
}
describe('optional protected same-pool USDT quote-funding API', () => {
  it('preserves execution and publishes clean native S/Ea/R independently of manual first-leg/Q', async () => {
    const execution = { manualFirstLeg: input.firstLegUsdcRaw },
      base = { executionAgreement: execution }
    const result = await withFluidUsdtBridgeJointHistoricalEvidence(input, base, observed.source)
    expect(result.executionAgreement).toBe(execution)
    expect(result.fluidUsdtBridgeJointCurrentEvidence).toMatchObject({
      schema: 'fluid_usdt_bridge_joint_current_evidence_v1',
      source: observed.source,
      roundtripUsdtRaw: '1000000',
      current: {
        holderSharesRaw: observed.sharesRaw,
        fullHolderNetUsdcRaw: observed.fullNetEaRaw,
        owner: observed.owner,
        shareDecimals: 18,
        nativeProngs: observed.nativeProngs,
        conversion: {
          fixedFinalUsdtOutputRaw: input.assetsRaw,
          requiredNetUsdcRaw: '999511',
          inputDecimals: 6,
          outputDecimals: 6,
        },
      },
      originalAuthority: false,
      executionQualified: false,
      noUSDTCapacityAmountBand: true,
      MRaw: null,
    })
    expect(result.fluidUsdtBridgeJointCurrentEvidence!.current.holderSharesRaw).not.toBe(
      input.assetsRaw,
    )
    expect(
      result.fluidUsdtBridgeJointCurrentEvidence!.current.conversion.requiredNetUsdcRaw,
    ).not.toBe(input.firstLegUsdcRaw)
    expect(Object.keys(mocks.acquire.mock.calls[0][0]).sort()).toEqual([
      'asOfMs',
      'owner',
      'requestedFinalUsdtRaw',
      'source',
    ])
    expect(mocks.history.mock.calls[0][0]).toBe(mocks.original)
    expect(result.fluidUsdtBridgeJointHistoricalEvidence).toBe(mocks.finalized.evidence)
    expect(Date.parse(result.fluidUsdtBridgeJointIssuedAtUtc!)).toBeGreaterThanOrEqual(
      Date.parse(mocks.finalized.evidence.availableAtUtc),
    )
    const wire = JSON.stringify(result)
    for (const privateKey of [
      'retention',
      'quoteWire',
      'underlyingOriginFacts',
      'artifactDirectory',
      'manifestFileSha256',
    ])
      expect(wire).not.toContain(privateKey)
  })
  it.each(['acquire', 'current', 'history', 'selectHistory'] as const)(
    'optional %s failure preserves existing response',
    async (key) => {
      mocks[key].mockResolvedValueOnce(null)
      if (key === 'current' || key === 'selectHistory') mocks[key].mockReturnValueOnce(null)
      const base = {
        error: 'holder_exit_assessment_unavailable',
        executionAgreement: { unchanged: true },
      }
      expect(await withFluidUsdtBridgeJointHistoricalEvidence(input, base, observed.source)).toBe(
        base,
      )
    },
  )
  it('rejects a cloned foreign current object without converting inspection JSON to an original', async () => {
    mocks.acquire.mockResolvedValue(structuredClone(mocks.original))
    const base = {}
    expect(await withFluidUsdtBridgeJointHistoricalEvidence(input, base, observed.source)).toBe(
      base,
    )
    expect(mocks.history).not.toHaveBeenCalled()
  })
  it.each([
    { routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]' },
    { destinationAddress: C.usdc },
    { owner: '0x' + '0'.repeat(40) },
    { assetsRaw: '0' },
    { assetsRaw: '01' },
    { assetsRaw: (1n << 256n).toString() },
    { horizonHours: 8761 },
    { horizonHours: 1.5 },
  ])(
    'rejects wrong question identity/units boundary before native acquisition: %j',
    async (change) => {
      const base = {}
      expect(
        await withFluidUsdtBridgeJointHistoricalEvidence(
          { ...input, ...change } as any,
          base,
          observed.source,
        ),
      ).toBe(base)
      expect(mocks.acquire).not.toHaveBeenCalled()
    },
  )
  it('rejects source future/stale/nonfinalized and accessors without executing getters', async () => {
    const base = {}
    for (const source of [
      { ...observed.source, finalized: false },
      { ...observed.source, blockTime: new Date(mocks.now + 1).toISOString() },
      { ...observed.source, blockTime: new Date(mocks.now - 1800001).toISOString() },
    ])
      expect(await withFluidUsdtBridgeJointHistoricalEvidence(input, base, source as any)).toBe(
        base,
      )
    const getter = vi.fn(() => input.owner),
      bad = { ...input }
    Object.defineProperty(bad, 'owner', { enumerable: true, get: getter })
    expect(await withFluidUsdtBridgeJointHistoricalEvidence(bad, base, observed.source)).toBe(base)
    expect(getter).not.toHaveBeenCalled()
    expect(mocks.acquire).not.toHaveBeenCalled()
  })
  it('abstains when post-retention TTL expires or availability exceeds issue', async () => {
    mocks.history.mockImplementationOnce(async () => {
      mocks.now += 1800001
      return {
        evidence: {
          acquiredAtUtc: new Date(mocks.now).toISOString(),
          availableAtUtc: new Date(mocks.now).toISOString(),
        },
        issuedAtUtc: new Date(mocks.now).toISOString(),
      }
    })
    const base = {}
    expect(await withFluidUsdtBridgeJointHistoricalEvidence(input, base, observed.source)).toBe(
      base,
    )
    mocks.now = Date.parse('2026-10-09T06:16:00.000Z')
    mocks.history.mockImplementationOnce(async () => ({
      evidence: {
        acquiredAtUtc: new Date(mocks.now).toISOString(),
        availableAtUtc: new Date(mocks.now + 1).toISOString(),
      },
      issuedAtUtc: new Date(mocks.now).toISOString(),
    }))
    expect(await withFluidUsdtBridgeJointHistoricalEvidence(input, base, observed.source)).toBe(
      base,
    )
  })
  it('decorates corroborated200 while USDT conversion/delivery remain unassessed', async () => {
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.response.finalPayout).toMatchObject({ status: 'unassessed', amountRaw: null })
    expect(result.response.stages[0].amountRaw).toBe(input.firstLegUsdcRaw)
    expect(
      result.response.fluidUsdtBridgeJointCurrentEvidence.current.conversion.requiredNetUsdcRaw,
    ).toBe('999511')
    expect(mocks.read.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.acquire.mock.invocationCallOrder[0],
    )
  })
  it('decorates canonical partial503 using source agreement independently of contradictory execution stages', async () => {
    mocks.read
      .mockResolvedValueOnce(assessment())
      .mockResolvedValueOnce(assessment({ condition: { gate: 'unassessed' } }))
    const result = await request()
    expect(result.code).toBe(503)
    expect(result.response.error).toBe('holder_exit_assessment_unavailable')
    expect(result.response.capacityAgreement).toBeUndefined()
    expect(result.response.fluidUsdtBridgeJointHistoricalEvidence).toBe(mocks.finalized.evidence)
  })
  it.each(['hash', 'asset'] as const)(
    'does not acquire when required paired %s witnesses disagree',
    async (kind) => {
      const a = assessment(),
        b = assessment()
      if (kind === 'hash') b.source.blockHash = '0x' + 'b'.repeat(64)
      else {
        a.request.assetAddress = C.usdc
        b.request.assetAddress = C.usdc
      }
      mocks.read.mockResolvedValueOnce(a).mockResolvedValueOnce(b)
      const result = await request()
      expect(result.response.fluidUsdtBridgeJointCurrentEvidence).toBeUndefined()
      expect(mocks.acquire).not.toHaveBeenCalled()
    },
  )
  it.each([721, 8760])(
    'accepts exact USDT H=%s without clamping the execution question',
    async (H) => {
      const question = { ...input, horizonHours: H }
      expect(parseHolderExitAssessmentRequest(question)?.horizonHours).toBe(H)
      expect(() => validateHolderExitAssessmentRequest(question)).not.toThrow()
      const value = await mocks.actualRead(
        { tracked: {}, direct: {}, apy: {}, morpho: {} },
        question,
      )
      expect(value.request.horizonHours).toBe(H)
      expect(value.status).toBe('partial')
      expect(value.finalPayout).toEqual({
        assetAddress: C.usdt,
        status: 'unassessed',
        amountRaw: null,
      })
      expect(mocks.tracked.mock.calls[0][1].assetsRaw).toBe(input.firstLegUsdcRaw)
    },
  )
  it('retains every unrelated route720 cap and rejects USDT8761', () => {
    expect(parseHolderExitAssessmentRequest({ ...input, horizonHours: 8761 })).toBeNull()
    const usdc = {
      ...input,
      routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
      horizonHours: 721,
    }
    delete (usdc as any).firstLegUsdcRaw
    expect(() => validateHolderExitAssessmentRequest(usdc)).toThrow()
  })
})
