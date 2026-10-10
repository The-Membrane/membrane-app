import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS } from '@/lib/carry/conditionalGrossFlowHeadroom'
import { carryForecastRequest } from '@/pages/api/carry/forecast'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'

vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(),
}))
const fixtureRoot = 'data/research/venue-signals/local-carry-cash-v1'
const newestReceipt = readdirSync(fixtureRoot)
  .filter((n) => /^\d{12}\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(`${fixtureRoot}/${n}`, 'utf8')))
  .filter((r) => r.collectionMode === 'current')
  .sort((a, b) => b.blockAt.localeCompare(a.blockAt))[0]
// Unit-fixture clocks distinguish fresh sealed C2 from a source requiring enrichment;
// runtime proofs always retain the real wall clock.
const FRESH_NOW = Date.parse(newestReceipt.firstLocalReceiptAt)
const INITIAL_NOW = Math.max(FRESH_NOW, Date.parse(newestReceipt.blockAt) + 31 * 60000)
const MAX_SOURCE_AGE_MS = CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000
const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
function live(ageMs = 0) {
  return {
    status: 'available',
    sourceKind: 'live_read_only_two_origin_finalized',
    routeKey: market.routeKey,
    destination: market.destination.toLowerCase(),
    asset: market.underlying.toLowerCase(),
    assetDecimals: 6,
    cashRaw: '135803123530462',
    block: '26150000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockAt: new Date(INITIAL_NOW - ageMs).toISOString(),
    readAtUtc: new Date(INITIAL_NOW).toISOString(),
  }
}
async function response(includeLiveCurrent = '1', selected = market) {
  vi.stubEnv('NODE_ENV', 'development')
  let code = 0
  let body: any
  const headers = vi.fn()
  await carryForecastRequest(
    {
      method: 'GET',
      query: {
        routeKey: selected.routeKey,
        destination: selected.destination.toLowerCase(),
        amountUnits: '1',
        horizonHours: '24',
        includeLiveCurrent,
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
    {
      setHeader: headers,
      status(n: number) {
        code = n
        return this
      },
      json(value: unknown) {
        body = value
        return this
      },
    } as never,
    async () => ({ status: 'unavailable' }) as never,
    async () => ({ status: 'unavailable' }) as never,
  )
  expect(code).toBe(200)
  expect(headers).toHaveBeenCalledWith('Cache-Control', 'no-store')
  return body
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('independent Aave conditional gross-flow API connection', () => {
  it('refreshes once after30min even with saved cash within two hours, binds USDC Q once and keeps H24 separate', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(INITIAL_NOW)
    const source = live(16 * 60000)
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue(source)
    const body = await response()
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledTimes(1)
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledWith(
      { routeKey: market.routeKey, destination: market.destination.toLowerCase() },
      expect.objectContaining({ cache: true, maxSourceAgeMs: MAX_SOURCE_AGE_MS }),
    )
    const result = body.conditionalGrossFlowHeadroom
    expect(result.status).toBe('estimated')
    expect(result.request).toEqual({
      requestedRaw: '1000000',
      asOf: new Date(INITIAL_NOW).toISOString(),
    })
    expect(result.currentSource).toMatchObject({
      cashRaw: live().cashRaw,
      assetDecimals: 6,
      blockNumber: 26150000,
    })
    expect(result.target.durationSeconds).toEqual({ lowerSeconds: 2532, upperSeconds: 3588 })
    expect(Date.parse(result.target.earliestAt)).toBe(Date.parse(source.blockAt) + 2532 * 1000)
    expect(Date.parse(result.target.latestAt)).toBe(Date.parse(source.blockAt) + 3588 * 1000)
    expect(result.holderExecutableExit).toBe(false)
    expect(result.forecastValidated).toBe(false)
    for (const scenario of result.scenarios) {
      expect(BigInt(scenario.userHeadroomRaw)).toBe(BigInt(scenario.capacityRaw) - 1000000n)
    }
    expect(body.exitImpact.historicalBacktest.question.horizonHours).toBe(24)
    expect(body.exitImpact.historicalBacktest.expectedCompetingFlow.status).toBe(
      'historical_context',
    )
  })
  it.each([
    [MAX_SOURCE_AGE_MS, 'estimated'],
    [MAX_SOURCE_AGE_MS + 1, 'unavailable'],
  ] as const)('enforces source age boundary %i ms', async (age, expected) => {
    vi.spyOn(Date, 'now').mockReturnValue(INITIAL_NOW)
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue(live(age))
    const result = (await response()).conditionalGrossFlowHeadroom
    expect(result.status).toBe(expected)
    if (expected === 'unavailable') expect(result.reason).toBe('source_stale')
  })
  it('uses actual assembly clock after awaiting the read and rejects a source aged during await', async () => {
    let now = INITIAL_NOW
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.mocked(readConfiguredLiveCurrentCash).mockImplementation(async () => {
      now += 1000
      return live(MAX_SOURCE_AGE_MS - 500)
    })
    const body = await response()
    expect(body.conditionalGrossFlowHeadroom).toEqual({
      status: 'unavailable',
      reason: 'source_stale',
    })
    vi.mocked(readConfiguredLiveCurrentCash).mockImplementation(async () => {
      now += 1000
      return live()
    })
    const later = await response()
    expect(later.conditionalGrossFlowHeadroom.request.asOf).toBe(new Date(now).toISOString())
  }, 15000)
  it('normal request performs no RPC, keeps historical context and reports stale source', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(INITIAL_NOW)
    const fetch = vi.fn(() => {
      throw Error('network forbidden')
    })
    vi.stubGlobal('fetch', fetch)
    const body = await response('0')
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(body.conditionalGrossFlowHeadroom).toEqual({
      status: 'unavailable',
      reason: 'source_stale',
    })
    expect(body.exitImpact.historicalBacktest.expectedCompetingFlow.status).toBe(
      'historical_context',
    )
  })
  it('foreign subject has no independent field and retains existing saved-current selection', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FRESH_NOW)
    const body = await response('1', DIRECT_SUPPLY_MARKETS.compoundV3Usdc)
    expect(body).not.toHaveProperty('conditionalGrossFlowHeadroom')
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
  })
  it('rejects rollback and conflicting saved-source overlays while admitting equal or properly newer sources', async () => {
    let now = INITIAL_NOW
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const baseline = await response('0')
    const saved = baseline.sampledCashPaths.current
    expect(saved).toBeTruthy()
    const equal = {
      ...live(),
      block: saved.block,
      blockHash: saved.blockHash,
      blockAt: saved.blockAt,
      cashRaw: saved.cashRaw,
      readAtUtc: new Date(now).toISOString(),
    }
    for (const candidate of [
      {
        ...equal,
        block: (BigInt(saved.block) - 1n).toString(),
        blockAt: new Date(now).toISOString(),
      },
      { ...equal, blockHash: `0x${'b'.repeat(64)}` },
      { ...equal, blockAt: new Date(Date.parse(saved.blockAt) + 1000).toISOString() },
      { ...equal, cashRaw: (BigInt(saved.cashRaw) + 1n).toString() },
      { ...equal, block: (BigInt(saved.block) + 1n).toString() },
    ]) {
      vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue(candidate)
      const result = await response()
      expect(result.conditionalGrossFlowHeadroom).toEqual({
        status: 'unavailable',
        reason: 'current_source_conflict',
      })
      expect(result.sampledCashPaths.current.block).toBe(saved.block)
      expect(result.liveCurrentRead).toEqual({
        status: 'unavailable',
        reason: 'live_read_rejected',
      })
    }
    for (const candidate of [
      equal,
      {
        ...equal,
        block: (BigInt(saved.block) + 1n).toString(),
        blockAt: new Date(now).toISOString(),
      },
    ]) {
      vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue(candidate)
      const result = await response()
      if (candidate === equal) {
        expect(result.conditionalGrossFlowHeadroom.status).toBe('unavailable')
        expect(['source_stale', 'future_window_unavailable']).toContain(
          result.conditionalGrossFlowHeadroom.reason,
        )
        expect(result.liveCurrentRead.status).toBe('available')
      } else {
        expect(result.conditionalGrossFlowHeadroom.status).toBe('estimated')
        expect(result.conditionalGrossFlowHeadroom.currentSource.blockNumber).toBe(
          Number(candidate.block),
        )
        expect(result.conditionalGrossFlowHeadroom.holderExecutableExit).toBe(false)
      }
      expect(result.sampledCashPaths.current.block).toBe(candidate.block)
    }
  }, 60000)
  it.each(['26150000.0', '9007199254740992', ['26150000']])(
    'rejects malformed or unsafe native block %j',
    async (block) => {
      vi.spyOn(Date, 'now').mockReturnValue(INITIAL_NOW)
      vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue({ ...live(), block })
      expect((await response()).conditionalGrossFlowHeadroom).toEqual({
        status: 'unavailable',
        reason: 'current_source_invalid',
      })
    },
  )
})
