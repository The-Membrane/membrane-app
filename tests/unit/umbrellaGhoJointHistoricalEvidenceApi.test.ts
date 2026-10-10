import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import handler, {
  withUmbrellaGhoJointHistoricalEvidence,
} from '@/pages/api/carry/holder-exit-assessment'
import { UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO, ORIGINAL_GHO } from '@/lib/carry/umbrellaGhoExit'
import type { HolderExitAssessmentRequest } from '@/lib/carry/holderExitAssessment'

// These are isolated orchestration controls, not native acquisition or original authority.
const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  current: vi.fn(),
  issue: vi.fn(),
  history: vi.fn(),
  read: vi.fn(),
  now: 0,
  original: null as any,
  finalized: null as any,
  fact: null as any,
}))
vi.mock('@/lib/carry/umbrellaGhoNativeCapacity.server', () => ({
  acquireUmbrellaGhoNativeCapacity: mocks.acquire,
  selectedOriginalUmbrellaGhoNativeCapacity: mocks.current,
}))
vi.mock('@/lib/carry/umbrellaGhoJointHistoricalEvidence.server', () => ({
  readUmbrellaGhoJointHistoricalEvidenceAtIssue: mocks.issue,
  selectedOriginalUmbrellaGhoJointHistoricalEvidence: mocks.history,
}))
// Mock both protected modules above: synthetic API fixtures can never invoke native RPC or the real sink.
vi.mock('@/lib/carry/holderExitAssessment', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitAssessment')>()),
  readHolderExitAssessment: mocks.read,
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
const archivedFact = JSON.parse(
  readFileSync(
    join(process.cwd(), 'tests/unit/fixtures/umbrella-gho-native-current50-oct8.json'),
    'utf8',
  ),
)
const input: HolderExitAssessmentRequest = {
  routeKey: UMBRELLA_GHO_ROUTE,
  destinationAddress: UMBRELLA_STKGHO,
  owner: archivedFact.owner,
  assetsRaw: '1000000',
  horizonHours: 24,
}
const evidence = Object.freeze({
  unitFixtureOnly: true,
  authenticated: false,
  originalAuthority: false,
  acquiredAtUtc: '2026-10-08T20:14:01.000Z',
})
const sameSource = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b)
beforeEach(() => {
  mocks.now = Date.parse('2026-10-08T20:14:00.000Z')
  vi.spyOn(Date, 'now').mockImplementation(() => mocks.now)
  mocks.fact = structuredClone(archivedFact)
  mocks.original = Object.freeze({ fact: mocks.fact, controlledOriginalPointerOnly: true })
  mocks.finalized = null
  mocks.acquire.mockReset().mockResolvedValue(mocks.original)
  mocks.current
    .mockReset()
    .mockImplementation((p, b) =>
      p === mocks.original &&
      b.owner === input.owner &&
      sameSource(b.source, mocks.fact.source) &&
      b.asOfMs >= Date.parse(mocks.fact.readAtUtc) &&
      b.asOfMs <= mocks.now &&
      mocks.now - Date.parse(b.source.blockTime) <= 1800000
        ? mocks.fact
        : null,
    )
  mocks.issue.mockReset().mockImplementation(async () => {
    mocks.now += 2000
    mocks.finalized = Object.freeze({ evidence, issuedAtUtc: new Date(mocks.now).toISOString() })
    return mocks.finalized
  })
  mocks.history
    .mockReset()
    .mockImplementation((v, p, b) =>
      v === mocks.finalized &&
      p === mocks.original &&
      b.owner === input.owner &&
      sameSource(b.source, mocks.fact.source)
        ? Object.freeze(Array.from({ length: 8 }, () => ({ unitFixtureOnly: true })))
        : null,
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
    request: { assetsRaw: input.assetsRaw, assetAddress: ORIGINAL_GHO, horizonHours: 24 },
    source: {
      chainId: 1,
      blockNumber: archivedFact.source.blockNumber,
      blockHash: archivedFact.source.blockHash,
      blockTime: archivedFact.source.blockTime,
      originValidation: 'single_provider',
    },
    stages: [
      {
        name: 'redeem',
        assetAddress: ORIGINAL_GHO,
        status: 'simulated',
        amountRaw: input.assetsRaw,
        relatedToRequest: true,
      },
    ],
    finalPayout: { assetAddress: ORIGINAL_GHO, status: 'simulated', amountRaw: input.assetsRaw },
    condition: null,
    ...overrides,
  }
}
describe('Umbrella optional native API forwarding (controlled originals)', () => {
  it.each([{}, { error: 'holder_exit_assessment_unavailable' }])(
    'preserves the base response/execution envelope and uses the same original pointer',
    async (extras) => {
      const executionAgreement = { controlledExecutionEnvelope: true },
        response = { ...extras, executionAgreement }
      const result = await withUmbrellaGhoJointHistoricalEvidence(input, response, {
        ...archivedFact.source,
      })
      expect(result).toEqual({
        ...response,
        umbrellaGhoNativeCapacity: mocks.fact,
        umbrellaGhoJointHistoricalEvidence: evidence,
        umbrellaGhoJointIssuedAtUtc: new Date(mocks.now).toISOString(),
      })
      expect(result.executionAgreement).toBe(executionAgreement)
      expect(mocks.issue.mock.calls[0][0]).toBe(mocks.original)
      expect(mocks.history.mock.calls[0][0]).toBe(mocks.finalized)
      expect(mocks.history.mock.calls[0][1]).toBe(mocks.original)
      expect(mocks.history.mock.calls[0][2].asOfMs).toBe(mocks.now)
      expect(mocks.current.mock.calls.at(-1)![1].asOfMs).toBe(mocks.now)
    },
  )
  it('does not derive full S/Ea or historical S/CS from Q or a generic capacity quote', async () => {
    await withUmbrellaGhoJointHistoricalEvidence(
      input,
      { capacityAgreement: { controlledIrrelevantQuote: true } },
      archivedFact.source,
    )
    const first = structuredClone(mocks.acquire.mock.calls[0][0])
    await withUmbrellaGhoJointHistoricalEvidence(
      { ...input, assetsRaw: '2000000' },
      {},
      archivedFact.source,
    )
    expect({ ...mocks.acquire.mock.calls[1][0], asOfMs: null }).toEqual({ ...first, asOfMs: null })
    expect(
      mocks.issue.mock.calls.every(
        ([p, b]) =>
          p === mocks.original &&
          !Object.hasOwn(b, 'requestedRaw') &&
          !Object.hasOwn(b, 'sharesRaw') &&
          !Object.hasOwn(b, 'horizonHours'),
      ),
    ).toBe(true)
    expect(mocks.fact.fullSharesRaw).not.toBe(input.assetsRaw)
  })
  it.each(['current', 'history', 'current_selection', 'history_selection'] as const)(
    'leaves the existing response unchanged when optional %s fails',
    async (failure) => {
      if (failure === 'current') mocks.acquire.mockResolvedValue(null)
      if (failure === 'history') mocks.issue.mockResolvedValue(null)
      if (failure === 'current_selection') mocks.current.mockReturnValue(null)
      if (failure === 'history_selection') mocks.history.mockReturnValue(null)
      const response = {
        error: 'holder_exit_assessment_unavailable',
        executionAgreement: { unchanged: true },
      }
      expect(
        await withUmbrellaGhoJointHistoricalEvidence(input, response, archivedFact.source),
      ).toBe(response)
      expect(mocks.acquire).toHaveBeenCalledTimes(1)
    },
  )
  it.each([
    { routeKey: 'other' },
    { destinationAddress: '0x0000000000000000000000000000000000000001' },
    { owner: '0x0000000000000000000000000000000000000000' },
    { assetsRaw: '0' },
    { horizonHours: 721 },
  ])(
    'rejects a mismatched or incomplete request before optional acquisition: %j',
    async (patch) => {
      const response = {}
      expect(
        await withUmbrellaGhoJointHistoricalEvidence(
          { ...input, ...patch } as never,
          response,
          archivedFact.source,
        ),
      ).toBe(response)
      expect(mocks.acquire).not.toHaveBeenCalled()
    },
  )
  it.each([
    null,
    { ...archivedFact.source, finalized: false },
    { ...archivedFact.source, blockTime: '2026-10-08T20:14:01.000Z' },
    { ...archivedFact.source, blockTime: '2026-10-08T19:43:59.000Z' },
  ])('rejects missing, unfinalized, future or expired sources before capture', async (source) => {
    const response = {}
    expect(await withUmbrellaGhoJointHistoricalEvidence(input, response, source as never)).toBe(
      response,
    )
    expect(mocks.acquire).not.toHaveBeenCalled()
  })
  it('does not forward if the native source expires during historical retention', async () => {
    mocks.issue.mockImplementation(async () => {
      mocks.now = Date.parse(archivedFact.source.blockTime) + 1800001
      return { evidence, issuedAtUtc: new Date(mocks.now).toISOString() }
    })
    const response = {}
    expect(await withUmbrellaGhoJointHistoricalEvidence(input, response, archivedFact.source)).toBe(
      response,
    )
  })
  it('refuses an invented future issue clock and acquisition after issue', async () => {
    const response = {}
    mocks.issue.mockResolvedValue({ evidence, issuedAtUtc: '2026-10-08T20:14:10.000Z' })
    expect(await withUmbrellaGhoJointHistoricalEvidence(input, response, archivedFact.source)).toBe(
      response,
    )
    mocks.issue.mockResolvedValue({ evidence, issuedAtUtc: '2026-10-08T20:14:00.000Z' })
    expect(await withUmbrellaGhoJointHistoricalEvidence(input, response, archivedFact.source)).toBe(
      response,
    )
  })
  it('copies the complete input/source before await and never invokes getters', async () => {
    const q = { ...input },
      source = { ...archivedFact.source }
    mocks.acquire.mockImplementation(async () => {
      q.owner = '0x0000000000000000000000000000000000000001'
      source.blockHash = '0x' + '1'.repeat(64)
      return mocks.original
    })
    expect(await withUmbrellaGhoJointHistoricalEvidence(q, {}, source)).toHaveProperty(
      'umbrellaGhoNativeCapacity',
      mocks.fact,
    )
    const getter = vi.fn(() => input.owner),
      bad = { ...input }
    Object.defineProperty(bad, 'owner', { enumerable: true, get: getter })
    expect(await withUmbrellaGhoJointHistoricalEvidence(bad, {}, archivedFact.source)).toEqual({})
    expect(getter).not.toHaveBeenCalled()
  })
  it('waits for both required finalized source witnesses before optional reads, preserving execution source', async () => {
    const a = assessment()
    mocks.read.mockResolvedValue(a)
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.response.umbrellaGhoNativeCapacity).toBe(mocks.fact)
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.acquire).toHaveBeenCalledTimes(1)
    expect(mocks.read.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.acquire.mock.invocationCallOrder[0],
    )
    expect(mocks.acquire.mock.calls[0][0].source).toEqual(archivedFact.source)
    expect(result.response.source.blockHash).toBe(a.source.blockHash)
  })
  it('attaches independent native facts to an existing partial503 without a generic quote fallback', async () => {
    mocks.read
      .mockResolvedValueOnce(assessment({ status: 'partial' }))
      .mockResolvedValueOnce(
        assessment({ status: 'partial', condition: { gate: 'window_expired' } }),
      )
    const result = await request()
    expect(result.code).toBe(503)
    expect(result.response.error).toBe('holder_exit_assessment_unavailable')
    expect(result.response.capacityAgreement).toBeUndefined()
    expect(result.response.umbrellaGhoNativeCapacity).toBe(mocks.fact)
  })
  it('does not attach when required source witnesses disagree', async () => {
    const b = assessment()
    b.source.blockHash = '0x' + '1'.repeat(64)
    mocks.read.mockResolvedValueOnce(assessment()).mockResolvedValueOnce(b)
    const result = await request()
    expect(result.response.umbrellaGhoNativeCapacity).toBeUndefined()
    expect(mocks.acquire).not.toHaveBeenCalled()
  })
  it('does not attach if a required witness reports the wrong final asset', async () => {
    const a = assessment()
    a.request.assetAddress = '0x0000000000000000000000000000000000000001'
    mocks.read.mockResolvedValue(a)
    const result = await request()
    expect(result.response.umbrellaGhoNativeCapacity).toBeUndefined()
    expect(mocks.acquire).not.toHaveBeenCalled()
  })
})
