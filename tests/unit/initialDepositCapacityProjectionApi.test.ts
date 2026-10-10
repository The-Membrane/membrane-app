import { afterEach, describe, expect, it, vi } from 'vitest'
import { carryForecastRequest } from '@/pages/api/carry/forecast'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'
import { readConfiguredInitialDepositNativeFacts } from '@/scripts/research/carry-initial-deposit-native-facts.mjs'
import { INITIAL_DEPOSIT_MARKETS } from '@/lib/carry/initialDepositCapacityProjection'
vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(),
}))
vi.mock('@/scripts/research/carry-initial-deposit-native-facts.mjs', () => ({
  readConfiguredInitialDepositNativeFacts: vi.fn(),
}))
const now = Date.parse('2026-10-08T12:00:00.000Z')
const m = INITIAL_DEPOSIT_MARKETS[0]
const question = {
  mode: 'initial_deposit',
  routeKey: m.routeKey,
  destination: m.destination.toLowerCase(),
  depositAssetsRaw: '100000000',
  plannedExitAssetsRaw: '120000000',
  horizonHours: 24,
}
async function response(extra = {}, method = 'POST', native = false, postQuery = {}) {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  vi.stubEnv('NODE_ENV', 'development')
  vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue({
    status: 'available',
    routeKey: m.routeKey,
    destination: m.destination.toLowerCase(),
    asset: m.underlying.toLowerCase(),
    assetDecimals: 6,
    cashRaw: '50000000',
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockAt: new Date(now - 1000).toISOString(),
    readAtUtc: new Date(now).toISOString(),
    sourceKind: 'live_read_only_two_origin_finalized',
  })
  vi.mocked(readConfiguredInitialDepositNativeFacts).mockResolvedValue({
    status: 'unavailable',
    reason: 'offline_test',
  })
  if (native)
    vi.mocked(readConfiguredInitialDepositNativeFacts).mockImplementation(async (source) => {
      const facts = {
        pool: m.pool,
        aToken: source.destination,
        asset: source.asset,
        assetDecimals: 6,
        configurationRaw: String((6n << 48n) | (1n << 56n)),
        normalizedIncomeRaw: String(10n ** 27n),
        scaledTotalSupplyRaw: '400',
        accruedToTreasuryScaledRaw: '0',
      }
      return {
        status: 'agreed_initial_deposit_native_facts',
        currentSource: structuredClone(source),
        readAt: new Date(now).toISOString(),
        origins: [
          { originHostSha256: 'a'.repeat(64), facts },
          { originHostSha256: 'b'.repeat(64), facts },
        ],
      }
    })
  let body: any,
    code = 0
  const q = { ...question, ...extra }
  await carryForecastRequest(
    {
      method,
      query: method === 'GET' ? { ...q, horizonHours: String(q.horizonHours) } : postQuery,
      body: method === 'POST' ? q : undefined,
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
    {
      setHeader: vi.fn(),
      status(n: number) {
        code = n
        return this
      },
      json(v: unknown) {
        body = v
        return this
      },
    } as never,
    async () => ({ status: 'unavailable' }) as never,
    async () => ({ status: 'unavailable' }) as never,
  )
  return { body, code }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
describe('initial-deposit API seam', () => {
  it.each([
    ['initial_deposit', 'legacy'],
    ['legacy', 'initial_deposit'],
  ])(
    'rejects conflicting query %s and body %s before reading data',
    async (queryMode, bodyMode) => {
      const { code, body } = await response({ mode: bodyMode }, 'POST', false, { mode: queryMode })
      expect(code).toBe(400)
      expect(body).toEqual({ error: 'conflicting_forecast_modes' })
      expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
      expect(readConfiguredInitialDepositNativeFacts).not.toHaveBeenCalled()
    },
  )
  it('does not let query mode authorize a POST body with no mode', async () => {
    expect(
      (await response({ mode: undefined }, 'POST', false, { mode: 'initial_deposit' })).code,
    ).toBe(405)
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
  })
  it('binds optional agreed index facts to actual source and clips E0 before the full intended Q', async () => {
    const { body, code } = await response({}, 'POST', true)
    expect(code).toBe(200)
    const p = body.initialDepositProjection
    expect(p.hypotheticalReceipt).toMatchObject({
      status: 'conditional_source_indexed_receipt',
      entitlementRaw: '100000000',
      indexAt: body.conditionalSampledCashPathProjection.currentSource.blockTime,
    })
    expect(p.process).not.toBeNull()
    expect(BigInt(p.process.targetSummary.maximumHeadroomRaw)).toBeLessThanOrEqual(-20000000n)
    expect(p.currentSource).toEqual(body.conditionalSampledCashPathProjection.currentSource)
    expect(p.nativeAgreement.currentSource).toEqual(p.currentSource)
  })
  it.each(['POST', 'GET'])(
    'accepts native D and Q separately via %s, preserving baseline forecasts',
    async (method) => {
      const { body, code } = await response({}, method)
      expect(code).toBe(200)
      expect(body.conditionalSampledCashPathProjection.status).toBe('estimated')
      const p = body.initialDepositProjection
      expect(p.status).toBe('conditional_initial_deposit_projection')
      expect(p.currentSource.cashRaw).toBe('50000000')
      expect(p.hypotheticalPostDepositCashRaw).toBe('150000000')
      expect(p.request).toMatchObject({
        depositAssetsRaw: '100000000',
        plannedExitAssetsRaw: '120000000',
        horizonHours: 24,
      })
      expect(p.process).toBeNull()
      expect(p.cashOnlyProcess.targetSummary).not.toBeNull()
      expect(readConfiguredInitialDepositNativeFacts).toHaveBeenCalledTimes(1)
      expect(body.conditionalSampledCashPathProjection.request.requestedRaw).toBe('120000000')
    },
  )
  it.each([
    { depositAssetsRaw: '0' },
    { plannedExitAssetsRaw: '0' },
    { depositAssetsRaw: '1.0' },
    { depositAssetsRaw: '-1' },
    { depositAssetsRaw: String(1n << 256n) },
  ])('rejects malformed native principal or Q', async (extra) => {
    expect((await response(extra)).code).toBe(400)
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
  })
  it('retains the legacy POST rejection and a truthful unsupported-destination field', async () => {
    expect((await response({ mode: 'legacy' })).code).toBe(405)
    const unsupported = await response({
      routeKey: 'USDC → VaultV2 [USDC]',
      destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
    })
    expect(unsupported.code).toBe(200)
    expect(unsupported.body.initialDepositProjection).toEqual({
      status: 'unavailable',
      reason: 'unsupported_subject',
    })
  })
})
