import { afterEach, describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { DIRECT_SUPPLY_MARKETS as markets } from '@/lib/carry/directSupplyMarketConstants'
import { carryForecastRequest, aaveSparkCapacityApiFields } from '@/pages/api/carry/forecast'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'
vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(),
}))
const root = 'data/research/venue-signals/local-carry-cash-v1'
const receipt = readdirSync(root)
  .filter((n) => /^\d{12}\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(root + '/' + n, 'utf8')))
  .filter((r) => r.collectionMode === 'current')
  .sort((a, b) => b.blockAt.localeCompare(a.blockAt))[0]
const supplementalRoot = 'data/research/venue-signals/local-carry-supplemental-aave-usde-cash-v1'
const supplementalClock = Math.max(
  ...readdirSync(supplementalRoot)
    .filter((n) => /^\d{12}\.json$/.test(n))
    .map((n) => JSON.parse(readFileSync(supplementalRoot + '/' + n, 'utf8')))
    .filter((r) => r.collectionMode === 'current')
    .map((r) => Date.parse(r.firstLocalReceiptAt)),
)
// Unit clock follows both genuine ledger arrival times; runtime never retimes a receipt.
const now = Math.max(Date.parse(receipt.firstLocalReceiptAt), supplementalClock),
  native = [markets.aaveV3Usdc, markets.sparkLendUsdt, markets.aaveV3Usde]
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
async function response(market = markets.aaveV3Usdc, horizonHours = 24, include = '0') {
  vi.stubEnv('NODE_ENV', 'development')
  let body: any
  const headers = vi.fn()
  await carryForecastRequest(
    {
      method: 'GET',
      query: {
        routeKey: market.routeKey,
        destination: market.destination.toLowerCase(),
        amountUnits: '1',
        horizonHours: String(horizonHours),
        includeLiveCurrent: include,
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as any,
    {
      setHeader: headers,
      status(code: number) {
        expect(code).toBe(200)
        return this
      },
      json(v: any) {
        body = v
      },
    } as any,
    async () => ({ status: 'unavailable' }) as any,
    async () => ({ status: 'unavailable' }) as any,
  )
  expect(headers).toHaveBeenCalledWith('Cache-Control', 'no-store')
  return body
}
describe('independent Aave/Spark native protocol API fields', () => {
  for (const market of native)
    it(`normal ${market.routeKey} reuses actual sealed C2/native daily paths withoutRPC`, async () => {
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const body = await response(market as any),
        p = body.aaveSparkCapacityProjection,
        s = body.aaveSparkCapacitySource
      expect(p.status).toBe('conditional_aave_spark_capacity_projection')
      expect(p.scope).toBe('protocol_reserve_liquidity_scenario')
      expect(s.sourceKind).toBe('manifest_bound_ledger')
      expect(s.assetDecimals).toBe(market.decimals)
      expect(s.cashRaw).toBe(body.sampledCashPaths.current.cashRaw)
      expect(String(s.blockNumber)).toBe(body.sampledCashPaths.current.block)
      expect(s.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(s.receiptSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(p.input.requestedRaw).toBe((10n ** BigInt(market.decimals)).toString())
      expect(p.input.reserveAgreement).toBeNull()
      expect(p.input.holder).toBeUndefined()
      expect(p.scenarios).toHaveLength(17)
      expect(p.horizons).toHaveLength(7)
      expect(p.holderExecutableExit).toBe(false)
      expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
    }, 10000)
  it.each([1, 48, 168])(
    'Aave sealed nonH24=%s keeps genuine daily target intervals',
    async (horizon) => {
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const body = await response(markets.aaveV3Usdc, horizon)
      expect(body.aaveSparkCapacityProjection.status).toBe(
        'conditional_aave_spark_capacity_projection',
      )
      expect(body.aaveSparkCapacityProjection.input.horizonHours).toBe(horizon)
      expect(body.aaveSparkCapacityProjection.horizons[0].target.lowerSeconds).toBeGreaterThan(
        80000,
      )
      expect(body.aaveSparkCapacityProjection.horizons[0].target.upperSeconds).toBeLessThan(92000)
      expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
    },
    10000,
  )
  it('one existing live read joins accepted AaveC2 and78jointwindow target withoutnewRPC', async () => {
    const at = Date.parse(receipt.blockAt) + 31 * 60000
    vi.spyOn(Date, 'now').mockReturnValue(at)
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue({
      status: 'available',
      routeKey: markets.aaveV3Usdc.routeKey,
      destination: markets.aaveV3Usdc.destination.toLowerCase(),
      asset: markets.aaveV3Usdc.underlying.toLowerCase(),
      assetDecimals: 6,
      cashRaw: '10000000000000',
      block: '26190000',
      blockHash: '0x' + 'a'.repeat(64),
      blockAt: new Date(at - 60000).toISOString(),
      readAtUtc: new Date(at).toISOString(),
      sourceKind: 'live_read_only_two_origin_finalized',
    })
    const body = await response(markets.aaveV3Usdc, 1, '1'),
      p = body.aaveSparkCapacityProjection
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledTimes(1)
    expect(p.status).toBe('conditional_aave_spark_capacity_projection')
    expect(p.scenarios).toHaveLength(78)
    expect(p.horizons[0].target.lowerSeconds).toBe(2532)
    expect(p.horizons[0].target.upperSeconds).toBe(3588)
    expect(body.aaveSparkCapacitySource.sourceKind).toBe('live_read_only_two_origin_finalized')
    expect(body.aaveSparkCapacitySource.readAt).toBe(new Date(at).toISOString())
  }, 10000)
  it('rejected older live block cannot replace accepted savedC2 in new projection', async () => {
    const at = Date.parse(receipt.blockAt) + 31 * 60000
    vi.spyOn(Date, 'now').mockReturnValue(at)
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue({
      status: 'available',
      routeKey: markets.aaveV3Usdc.routeKey,
      destination: markets.aaveV3Usdc.destination.toLowerCase(),
      asset: markets.aaveV3Usdc.underlying.toLowerCase(),
      assetDecimals: 6,
      cashRaw: '10000000000000',
      block: String(Number(receipt.block) - 1),
      blockHash: '0x' + 'c'.repeat(64),
      blockAt: new Date(at - 60000).toISOString(),
      readAtUtc: new Date(at).toISOString(),
      sourceKind: 'live_read_only_two_origin_finalized',
    })
    const body = await response(markets.aaveV3Usdc, 24, '1')
    expect(body.aaveSparkCapacityProjection).toEqual({
      status: 'unavailable',
      reason: 'current_source_conflict',
    })
    expect(body.aaveSparkCapacitySource.blockNumber).toBe(Number(receipt.block))
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledTimes(1)
  }, 10000)
  it('stale/missing/conflicting or malformedsource fields drop independently, preservingotherforecasts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const body = await response(),
      s = body.aaveSparkCapacitySource
    const current = { ...s, block: String(s.blockNumber) }
    const args = {
      current,
      requestedRaw: '1000000',
      horizonHours: 24,
      asOfMs: now,
      jointProjection: body.conditionalGrossFlowHeadroom,
      dailyProjection: body.conditionalSampledCashPathProjection,
      currentSourceConflict: false,
    }
    expect(
      aaveSparkCapacityApiFields({ ...args, current: null }).aaveSparkCapacityProjection.reason,
    ).toBe('missing_current_source')
    expect(
      aaveSparkCapacityApiFields({ ...args, currentSourceConflict: true })
        .aaveSparkCapacityProjection.reason,
    ).toBe('current_source_conflict')
    expect(
      aaveSparkCapacityApiFields({ ...args, asOfMs: Date.parse(s.blockTime) + 1800001 })
        .aaveSparkCapacityProjection.reason,
    ).toBe('source_stale')
    for (const changed of [
      { ...current, assetDecimals: 18 },
      { ...current, cashRaw: ['1'] },
      { ...current, readAt: [s.readAt] },
      { ...current, receiptSha256: null },
    ])
      expect(
        aaveSparkCapacityApiFields({ ...args, current: changed }).aaveSparkCapacitySource,
      ).toBeNull()
    expect(body.sampledCashPaths.status).toBe('conditional_historical_sampled_cash_paths')
  }, 10000)
  it('foreignCompound route retains existingresponse and has noadapter fields', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const body = await response(markets.compoundV3Usdc as any)
    expect(body.aaveSparkCapacityProjection).toBeUndefined()
    expect(body.aaveSparkCapacitySource).toBeUndefined()
  }, 10000)
})
