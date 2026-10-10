import type { NextApiRequest, NextApiResponse } from 'next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { carryForecastRequest } from '@/pages/api/carry/forecast'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'

const fixtureState = vi.hoisted(() => ({ observations: [] as unknown[] }))
vi.mock('@/scripts/lib/localCarryCashStore.mjs', async (original) => ({
  ...(await original<typeof import('@/scripts/lib/localCarryCashStore.mjs')>()),
  verifyLocalCarryCash: () => ({ count: 0, records: [], last: null }),
  localCarryCashObservationsFromVerified: () => fixtureState.observations,
}))
vi.mock('@/scripts/lib/localCarryCashIssueStore.mjs', async (original) => ({
  ...(await original<typeof import('@/scripts/lib/localCarryCashIssueStore.mjs')>()),
  verifyLocalCashIssueLedgerFromVerified: () => null,
}))
vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(),
}))
const subject = {
  route_key: 'USDC → VaultV2 [USDC]',
  destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
}
function observations() {
  const now = Date.now()
  const day = 86400000
  const first = Math.floor(now / day) * day - 123 * day
  const rows = Array.from({ length: 120 }, (_, i) => ({
    collectionMode: 'retrospective',
    anchorAt: new Date(first + i * day).toISOString(),
    firstLocalReceiptAt: new Date(now).toISOString(),
    source: {
      blockAt: new Date(first + i * day - 1000).toISOString(),
      block: String(i + 1),
      blockHash: `0x${'a'.repeat(64)}`,
    },
    subjects: [
      {
        routeKey: subject.route_key,
        destination: subject.destination,
        state: i < 11 ? 'no_code' : 'observed',
        reason: i < 11 ? 'destination_not_deployed' : null,
        asset: i < 11 ? null : subject.asset,
        assetDecimals: i < 11 ? null : 6,
        cashRaw: i < 11 ? null : String(1000000 + i * 10000),
      },
    ],
  }))
  return [
    ...rows,
    {
      collectionMode: 'current',
      anchorAt: new Date(now).toISOString(),
      firstLocalReceiptAt: new Date(now).toISOString(),
      source: {
        blockAt: new Date(now - 1000).toISOString(),
        block: '1000',
        blockHash: `0x${'b'.repeat(64)}`,
      },
      subjects: [
        {
          routeKey: subject.route_key,
          destination: subject.destination,
          state: 'observed',
          asset: subject.asset,
          assetDecimals: 6,
          cashRaw: '100000000',
        },
      ],
    },
  ]
}
async function response(amountUnits = '1', overrides: Record<string, string> = {}) {
  let code = 0
  let body: Record<string, unknown> = {}
  const headers: Record<string, string> = {}
  const res = {
    status(n: number) {
      code = n
      return this
    },
    json(value: Record<string, unknown>) {
      body = value
      return this
    },
    setHeader(key: string, value: string) {
      headers[key] = value
      return this
    },
  } as unknown as NextApiResponse
  await carryForecastRequest(
    {
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
      query: {
        routeKey: subject.route_key,
        destination: subject.destination,
        amountUnits,
        horizonHours: '24',
        includeLiveCurrent: '0',
        ...overrides,
      },
    } as unknown as NextApiRequest,
    res,
    async () => ({ status: 'unavailable', reason: 'no_exact_model_match' }),
    async () => ({ status: 'unavailable', reason: 'not_enrolled' }),
  )
  return { code, body, headers }
}
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development')
  fixtureState.observations = observations()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('network_disabled')
    }),
  )
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
describe('sampled API uses postdeployment history independently of fitted qualification', () => {
  it('publishes 109/120 coverage and 15 sampled spans with native Q and fresh C2 despite failed model readers', async () => {
    const { code, body, headers } = await response()
    expect(code).toBe(200)
    expect(headers['Cache-Control']).toBe('no-store')
    expect(body.exitImpact).toMatchObject({
      historicalBacktestUnavailableReason: 'subject_no_code',
    })
    expect(body.sampledCashPaths).toMatchObject({
      status: 'conditional_historical_sampled_cash_paths',
      requestedRaw: '1000000',
      identity: { asset: subject.asset, assetDecimals: 6 },
      current: { cashRaw: '100000000', block: '1000' },
      counts: { samples: 109, candidateEpisodes: 15, eligibleEpisodes: 15, gaps: 0 },
      historyCoverage: {
        gridAnchorCount: 120,
        observedAnchorCount: 109,
        leadingPredeploymentAnchorCount: 11,
      },
      forwardProbability: false,
      holderExecutableExit: false,
      prospectiveValidated: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['stale', 'foreign_asset', 'foreign_units', 'missing_current'])(
    'drops %s C2 independently while retaining verified history coverage',
    async (change) => {
      const current = fixtureState.observations.at(-1) as ReturnType<typeof observations>[number]
      if (change === 'stale')
        current.source.blockAt = new Date(Date.now() - 2 * 3600000 - 1000).toISOString()
      if (change === 'foreign_asset') current.subjects[0].asset = `0x${'c'.repeat(40)}`
      if (change === 'foreign_units') current.subjects[0].assetDecimals = 18
      if (change === 'missing_current') fixtureState.observations.pop()
      const { code, body } = await response()
      expect(code).toBe(200)
      expect(body.sampledCashPaths).toMatchObject({
        status: 'unavailable',
        historyCoverage: { observedAnchorCount: 109, leadingPredeploymentAnchorCount: 11 },
      })
      expect(body.exitImpact).toMatchObject({
        historicalBacktestUnavailableReason: 'subject_no_code',
      })
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it.each([
    ['AUSD → Staked USDat [USDat]', '0xd166337499e176bbc38a1fbd113ab144e5bd2df7'],
    ['PYUSD → StakingVault [wYLDS]', '0x19ebb35279a16207ec4ba82799cc64715065f7f6'],
    ['USDT → FluidBridgeAggregatorProxy [USDC]', '0x273da948aca9261043fbdb2a857bc255ecc29012'],
    [
      'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
      '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    ],
  ])('keeps foreign payout %s excluded from native cash replay', async (routeKey, destination) => {
    const { code, body } = await response('1', { routeKey, destination })
    expect(code).toBe(200)
    expect(body.sampledCashPaths).toMatchObject({
      status: 'unavailable',
      reason: 'subject_mismatch',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'uses the existing two-origin live reader independently of the pair gate (foreign overlay=%s)',
    async (foreign) => {
      const now = Date.now()
      const current = fixtureState.observations.at(-1) as ReturnType<typeof observations>[number]
      current.source.blockAt = new Date(now - 3 * 3600000).toISOString()
      vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValueOnce({
        status: 'available',
        sourceKind: 'live_read_only_two_origin_finalized',
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: foreign ? `0x${'c'.repeat(40)}` : subject.asset,
        assetDecimals: 6,
        cashRaw: '120000000',
        block: '1001',
        blockHash: `0x${'c'.repeat(64)}`,
        blockAt: new Date(now - 1000).toISOString(),
        readAtUtc: new Date(now).toISOString(),
      })
      const { code, body } = await response('1', { includeLiveCurrent: '1' })
      expect(code).toBe(200)
      expect(readConfiguredLiveCurrentCash).toHaveBeenCalledWith(
        { routeKey: subject.route_key, destination: subject.destination },
        // Authenticated issuance bypasses the reader's general shared cache.
        expect.objectContaining({ cache: false }),
      )
      expect(body.sampledCashPaths).toMatchObject({
        status: foreign ? 'unavailable' : 'conditional_historical_sampled_cash_paths',
        historyCoverage: { observedAnchorCount: 109 },
      })
      if (!foreign)
        expect(body.sampledCashPaths).toMatchObject({
          current: { cashRaw: '120000000', sourceKind: 'live_read_only_two_origin_finalized' },
        })
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each(['0', '-1', 'bad'])('keeps invalid Q %s at HTTP400 before extraction', async (q) => {
    const { code, body } = await response(q)
    expect(code).toBe(400)
    expect(body).not.toHaveProperty('sampledCashPaths')
  })
})
