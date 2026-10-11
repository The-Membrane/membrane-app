import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import handler, {
  withApyUsdJointHistoricalEvidence,
} from '@/pages/api/carry/holder-exit-assessment'
import { APYUSD_ROUTE, APYUSD_VAULT, APXUSD_ASSET } from '@/lib/carry/apyUsdExit'
import type { HolderExitAssessmentRequest } from '@/lib/carry/holderExitAssessment'

// These test doubles control orchestration only. No fixture can call a native factory or recorder.
const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  current: vi.fn(),
  issue: vi.fn(),
  history: vi.fn(),
  hints: vi.fn(),
  read: vi.fn(),
  now: 0,
  original: null as any,
  finalized: null as any,
  fact: null as any,
}))
vi.mock('@/lib/carry/apyUsdJointNativeEvidence.server', () => ({
  acquireApyUsdJointNativeCurrent: mocks.acquire,
  selectedOriginalApyUsdJointNativeCurrent: mocks.current,
  readApyUsdJointNativeHistoryAtIssue: mocks.issue,
  selectedOriginalApyUsdJointNativeHistory: mocks.history,
  apyUsdJointNativeReceiptCandidateHints: mocks.hints,
}))
vi.mock('@/lib/carry/holderExitAssessment', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitAssessment')>()),
  readHolderExitAssessment: mocks.read,
}))
vi.mock('@/lib/carry/morphoV2CurrentProtocolCapacityEvidence', () => ({
  prewarmMorphoV2ProtocolHistory: vi.fn().mockResolvedValue(true),
  readMorphoV2CurrentProtocolOrigin: vi.fn().mockResolvedValue(null),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => ({})),
}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', () => ({
  readProviderPolicy: () => ({ status: 'active' }),
  configuredProviders: () => [
    {
      host: 'eth-mainnet.g.alchemy.com',
      url: 'https://eth-mainnet.g.alchemy.com/v2/unit-no-native',
    },
    { host: 'rpc.ankr.com', url: 'https://rpc.ankr.com/eth/unit-no-native' },
  ],
}))
vi.mock('@/lib/game/rateLimit', () => ({
  checkRateLimit: async () => ({ allowed: true }),
  getClientIp: () => '127.0.0.1',
}))
// Synthetic clocks and facts deliberately do not claim native acquisition or authentication.
const START = Date.parse('2026-10-08T23:10:00.000Z')
const source = {
  chainId: 1 as const,
  blockNumber: 26150788,
  blockHash: `0x${'a'.repeat(64)}`,
  blockTime: '2026-10-08T23:00:00.000Z',
  finalized: true as const,
}
const input: HolderExitAssessmentRequest = {
  routeKey: APYUSD_ROUTE,
  destinationAddress: APYUSD_VAULT,
  owner: '0x9830d6b37fe7488707cc4ad7f8b481d75eb2a8c2',
  assetsRaw: '1000000000000000000',
  horizonHours: 168,
}
const oldReference = {
  ...source,
  blockNumber: source.blockNumber - 100,
  blockHash: `0x${'b'.repeat(64)}`,
  blockTime: '2026-10-08T22:30:00.000Z',
}
const historyEvidence = {
  schema: 'apyusd_joint_native_history_evidence_v1',
  points: Array.from({ length: 8 }, (_, cashIndex) => ({
    binding: { currentSource: oldReference, cashIndex: cashIndex + 112 },
    wire: { unitFixtureOnly: true },
  })),
  fullSharesRaw: '391143432',
  acquiredAtUtc: '2026-10-08T22:35:00.000Z',
  availableAtUtc: '2026-10-08T22:36:00.000Z',
  owner: null,
  historicalOwnership: false,
  originalAuthority: false,
  authenticated: false,
  executionQualified: false,
}
beforeEach(() => {
  mocks.now = START
  vi.spyOn(Date, 'now').mockImplementation(() => mocks.now)
  mocks.fact = {
    current: { fullSharesRaw: '391143432', receiptInventory: { complete: true } },
    unitFixtureOnly: true,
    authenticated: false,
    originalAuthority: false,
  }
  mocks.original = {
    fact: mocks.fact,
    evidence: {
      binding: { acquiredAtUtc: new Date(START).toISOString() },
      wire: { unitFixtureOnly: true },
    },
    availableAtUtc: new Date(START).toISOString(),
    originalAuthority: false,
  }
  mocks.finalized = null
  mocks.acquire.mockReset().mockResolvedValue(mocks.original)
  mocks.current
    .mockReset()
    .mockImplementation((p, b) =>
      p === mocks.original &&
      b.owner === input.owner &&
      b.source.blockHash === source.blockHash &&
      b.asOfMs <= mocks.now
        ? mocks.fact
        : null,
    )
  mocks.issue.mockReset().mockImplementation(async () => {
    mocks.now += 2000
    mocks.finalized = {
      evidence: structuredClone(historyEvidence),
      issuedAtUtc: new Date(mocks.now).toISOString(),
    }
    return mocks.finalized
  })
  mocks.history
    .mockReset()
    .mockImplementation((h, p, b) =>
      h === mocks.finalized &&
      p === mocks.original &&
      b.owner === input.owner &&
      b.asOfMs === Date.parse(h.issuedAtUtc)
        ? historyEvidence.points
        : null,
    )
  mocks.hints
    .mockReset()
    .mockImplementation((owner, id) =>
      id === undefined ? (owner === input.owner ? ['881'] : []) : [id],
    )
  mocks.read.mockReset()
})
afterEach(() => vi.restoreAllMocks())
async function request() {
  let code = 0,
    response: any
  const res = {
    setHeader: vi.fn(),
    status(v: number) {
      code = v
      return this
    },
    json(v: any) {
      response = v
      return this
    },
  }
  await handler(
    { method: 'POST', headers: {}, body: input, socket: { remoteAddress: '127.0.0.1' } } as never,
    res as never,
  )
  return { code, response }
}
function assessment(overrides: Record<string, unknown> = {}) {
  return {
    status: 'assessed',
    routeKey: input.routeKey,
    destinationAddress: input.destinationAddress,
    owner: input.owner,
    request: {
      assetsRaw: input.assetsRaw,
      assetAddress: APXUSD_ASSET,
      horizonHours: input.horizonHours,
    },
    source: {
      chainId: 1,
      blockNumber: source.blockNumber,
      blockHash: source.blockHash,
      blockTime: source.blockTime,
      originValidation: 'single_provider',
    },
    stages: [
      {
        name: 'receipt_initiation',
        assetAddress: null,
        status: 'simulated',
        amountRaw: input.assetsRaw,
        relatedToRequest: true,
      },
    ],
    finalPayout: { assetAddress: APXUSD_ASSET, status: 'unassessed', amountRaw: null },
    condition: null,
    ...overrides,
  }
}
describe('APY optional native API forwarding (isolated controlled originals)', () => {
  it.each([{}, { error: 'holder_exit_assessment_unavailable' }])(
    'retains the response and same original pointers after post-retention issue',
    async (extras) => {
      const executionAgreement = { controlledExecutionEnvelope: true },
        response = { ...extras, executionAgreement }
      const result = await withApyUsdJointHistoricalEvidence(input, response, source)
      expect(result.executionAgreement).toBe(executionAgreement)
      expect(result.apyUsdJointNativeCurrentEvidence).toEqual({
        ...mocks.original.evidence,
        availableAtUtc: mocks.original.availableAtUtc,
      })
      expect(result.apyUsdJointHistoricalEvidence).toBe(mocks.finalized.evidence)
      expect(result.apyUsdJointIssuedAtUtc).toBe(new Date(mocks.now).toISOString())
      expect(mocks.issue.mock.calls[0][0]).toBe(mocks.original)
      expect(mocks.history.mock.calls[0][0]).toBe(mocks.finalized)
      expect(mocks.history.mock.calls[0][1]).toBe(mocks.original)
      expect(mocks.current.mock.calls.at(-1)![1].asOfMs).toBe(mocks.now)
    },
  )
  it('preserves old cached reference/acquisition/availability and independent full S when Q or H changes', async () => {
    const a = await withApyUsdJointHistoricalEvidence(input, {}, source)
    const first = structuredClone(mocks.acquire.mock.calls[0][0])
    const b = await withApyUsdJointHistoricalEvidence(
      { ...input, assetsRaw: '2000000000000000000', horizonHours: 24 },
      {},
      source,
    )
    expect({ ...mocks.acquire.mock.calls[1][0], asOfMs: null }).toEqual({ ...first, asOfMs: null })
    expect(b.apyUsdJointHistoricalEvidence).toEqual(a.apyUsdJointHistoricalEvidence)
    expect(b.apyUsdJointHistoricalEvidence!.points[0].binding.currentSource).toEqual(oldReference)
    expect(first).not.toHaveProperty('sharesRaw')
    expect(first).not.toHaveProperty('assetsRaw')
    expect(first).not.toHaveProperty('horizonHours')
    expect(first.asset).toBe(APXUSD_ASSET)
  })
  it('supplies explicit receipt ID only as a candidate and refuses incomplete native inventory', async () => {
    mocks.fact.current.receiptInventory.complete = false
    const response = {}
    expect(
      await withApyUsdJointHistoricalEvidence(
        { ...input, receiptTokenId: '881' },
        response,
        source,
      ),
    ).toBe(response)
    expect(mocks.acquire.mock.calls[0][0].candidateReceiptIds).toEqual(['881'])
    expect(mocks.issue).not.toHaveBeenCalled()
  })
  it.each([
    'current',
    'history',
    'current_selection',
    'history_selection',
    'cloned_current',
    'cloned_history',
  ] as const)(
    'keeps optional %s failure from changing required execution/error',
    async (failure) => {
      if (failure === 'current') mocks.acquire.mockResolvedValue(null)
      if (failure === 'history') mocks.issue.mockResolvedValue(null)
      if (failure === 'current_selection') mocks.current.mockReturnValue(null)
      if (failure === 'history_selection') mocks.history.mockReturnValue(null)
      if (failure === 'cloned_current')
        mocks.acquire.mockResolvedValue(structuredClone(mocks.original))
      if (failure === 'cloned_history')
        mocks.issue.mockImplementation(async () => {
          mocks.now += 2000
          mocks.finalized = {
            evidence: structuredClone(historyEvidence),
            issuedAtUtc: new Date(mocks.now).toISOString(),
          }
          return structuredClone(mocks.finalized)
        })
      const response = {
        error: 'holder_exit_assessment_unavailable',
        executionAgreement: { same: true },
      }
      expect(await withApyUsdJointHistoricalEvidence(input, response, source)).toBe(response)
    },
  )
  it.each([
    { routeKey: 'other' },
    { destinationAddress: `0x${'1'.repeat(40)}` },
    { owner: `0x${'0'.repeat(40)}` },
    { assetsRaw: '0' },
    { assetsRaw: '01' },
    { horizonHours: 721 },
    { receiptTokenId: '01' },
  ])('rejects wrong or incomplete question before acquisition: %j', async (patch) => {
    const response = {}
    expect(
      await withApyUsdJointHistoricalEvidence({ ...input, ...patch } as never, response, source),
    ).toBe(response)
    expect(mocks.acquire).not.toHaveBeenCalled()
  })
  it.each([
    null,
    { ...source, finalized: false },
    { ...source, chainId: 2 },
    { ...source, blockTime: '2026-10-08T23:10:01.000Z' },
    { ...source, blockTime: '2026-10-08T22:39:59.000Z' },
  ])('rejects missing/future/expired/unfinalized source', async (s) => {
    const response = {}
    expect(await withApyUsdJointHistoricalEvidence(input, response, s as never)).toBe(response)
    expect(mocks.acquire).not.toHaveBeenCalled()
  })
  it('snapshots primitive question/source before await and never calls accessors', async () => {
    const q = { ...input },
      s = { ...source }
    mocks.acquire.mockImplementation(async () => {
      q.owner = `0x${'1'.repeat(40)}`
      s.blockHash = `0x${'1'.repeat(64)}`
      return mocks.original
    })
    expect(await withApyUsdJointHistoricalEvidence(q, {}, s)).toHaveProperty(
      'apyUsdJointHistoricalEvidence',
    )
    const getter = vi.fn(() => '881'),
      bad = { ...input }
    Object.defineProperty(bad, 'receiptTokenId', { enumerable: true, get: getter })
    expect(await withApyUsdJointHistoricalEvidence(bad, {}, source)).toEqual({})
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([
    'current_acquisition',
    'current_retention',
    'history_acquisition',
    'history_retention',
    'future_issue',
    'expired_source',
  ] as const)('rejects invalid %s timing after native awaits', async (clock) => {
    mocks.issue.mockImplementation(async () => {
      mocks.now += 2000
      const evidence = structuredClone(historyEvidence),
        future = new Date(mocks.now + 1).toISOString()
      if (clock === 'current_acquisition') mocks.original.evidence.binding.acquiredAtUtc = future
      if (clock === 'current_retention') mocks.original.availableAtUtc = future
      if (clock === 'history_acquisition') evidence.acquiredAtUtc = future
      if (clock === 'history_retention') evidence.availableAtUtc = future
      if (clock === 'expired_source') mocks.now = Date.parse(source.blockTime) + 1800001
      mocks.finalized = {
        evidence,
        issuedAtUtc:
          clock === 'future_issue'
            ? new Date(mocks.now + 1).toISOString()
            : new Date(mocks.now).toISOString(),
      }
      return mocks.finalized
    })
    const response = {}
    expect(await withApyUsdJointHistoricalEvidence(input, response, source)).toBe(response)
  })
  it('forwards after two required finalized SDK witnesses, without advancing the execution source', async () => {
    const a = assessment()
    mocks.read.mockResolvedValue(a)
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.response.apyUsdJointHistoricalEvidence).toBe(mocks.finalized.evidence)
    expect(result.response.source.blockHash).toBe(a.source.blockHash)
    expect(result.response.request).toEqual(a.request)
    expect(mocks.acquire.mock.calls[0][0].source).toEqual(source)
    expect(mocks.read.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.acquire.mock.invocationCallOrder[0],
    )
  })
  it('adds native fields to canonical partial503 without inventing capacity or execution', async () => {
    mocks.read
      .mockResolvedValueOnce(assessment({ status: 'partial' }))
      .mockResolvedValueOnce(assessment({ status: 'partial', condition: { gate: 'different' } }))
    const result = await request()
    expect(result.code).toBe(503)
    expect(result.response.error).toBe('holder_exit_assessment_unavailable')
    expect(result.response.apyUsdJointHistoricalEvidence).toBe(mocks.finalized.evidence)
    expect(result.response.executionAgreement).toBeUndefined()
    expect(result.response.capacityAgreement).toBeUndefined()
  })
  it.each(['source', 'asset', 'owner', 'q', 'h'] as const)(
    'does not attach if required witnesses differ on %s',
    async (key) => {
      const b = assessment()
      if (key === 'source') b.source.blockHash = `0x${'b'.repeat(64)}`
      if (key === 'asset') b.request.assetAddress = `0x${'1'.repeat(40)}` as never
      if (key === 'owner') b.owner = `0x${'1'.repeat(40)}` as never
      if (key === 'q') b.request.assetsRaw = '2'
      if (key === 'h') b.request.horizonHours = 24
      mocks.read.mockResolvedValueOnce(assessment()).mockResolvedValueOnce(b)
      const result = await request()
      expect(result.response.apyUsdJointHistoricalEvidence).toBeUndefined()
      expect(mocks.acquire).not.toHaveBeenCalled()
    },
  )
})
