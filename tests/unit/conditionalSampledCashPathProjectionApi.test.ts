import { afterEach, describe, expect, it, vi } from 'vitest'
import { carryForecastRequest } from '@/pages/api/carry/forecast'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'
import { selectedConditionalSampledCashPathProjection } from '@/lib/carry/conditionalSampledCashPathProjection'
import { createHash } from 'node:crypto'
vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(),
}))
const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const vault = {
  routeKey: 'USDC → VaultV2 [USDC]',
  destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
}
const aave = {
  routeKey: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
}
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
function live(subject = vault, age = 1000) {
  return {
    status: 'available',
    sourceKind: 'live_read_only_two_origin_finalized',
    ...subject,
    asset,
    assetDecimals: 6,
    cashRaw: '100000000',
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockAt: new Date(NOW - age).toISOString(),
    readAtUtc: new Date(NOW).toISOString(),
  }
}
async function response(subject = vault, include = '1', amount = '1') {
  vi.stubEnv('NODE_ENV', 'development')
  let body: any,
    code = 0
  const headers = vi.fn()
  await carryForecastRequest(
    {
      method: 'GET',
      query: { ...subject, horizonHours: '24', amountUnits: amount, includeLiveCurrent: include },
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
    {
      setHeader: headers,
      status(n: number) {
        code = n
        return this
      },
      json(b: unknown) {
        body = b
        return this
      },
    } as never,
    async () => ({ status: 'unavailable' }) as never,
    async () => ({ status: 'unavailable' }) as never,
  )
  if (code === 200) expect(headers).toHaveBeenCalledWith('Cache-Control', 'no-store')
  return { code, body }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('conditional daily paths actual sealed-history API', () => {
  it('projects all native Q paths for postdeployment history while fitted model remains unavailable', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue(live())
    const { code, body } = await response()
    expect(code).toBe(200)
    const r = body.conditionalSampledCashPathProjection
    expect(r.status).toBe('estimated')
    expect(r.counts).toMatchObject({ samples: 109, eligibleEpisodes: 15, gapRejectedEpisodes: 0 })
    expect(r.horizons).toHaveLength(7)
    expect(r.scenarios).toHaveLength(15)
    expect(r.request.requestedRaw).toBe('1000000')
    expect(r.request.asOf).toBe(new Date(NOW).toISOString())
    expect(body.sampledCashPaths.historyCoverage.leadingPredeploymentAnchorCount).toBe(11)
    expect(body.exitImpact.historicalBacktestUnavailableReason).toBe('insufficient_long_history')
    expect(body.localHistoricalScenario.status).toBe('unavailable')
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledWith(
      vault,
      expect.objectContaining({ maxSourceAgeMs: 1800000 }),
    )
    const c = body.sampledCashPaths.current
    expect(
      selectedConditionalSampledCashPathProjection(
        r,
        {
          identity: r.identity,
          requestedRaw: '1000000',
          asOfMs: NOW,
          currentSource: {
            ...r.identity,
            chainId: 1,
            cashRaw: c.cashRaw,
            block: c.block,
            blockHash: c.blockHash,
            blockTime: c.blockAt,
            readAt: c.readAtUtc,
            sourceKind: c.sourceKind,
          },
        },
        (s) => createHash('sha256').update(s).digest('hex'),
      ),
    ).not.toBeNull()
  })
  it('archive-only request stays offline and drops stale future field while retaining history', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const { code, body } = await response(vault, '0')
    expect(code).toBe(200)
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
    expect(body.conditionalSampledCashPathProjection).toEqual({
      status: 'unavailable',
      reason: 'source_stale',
    })
    expect(body.sampledCashPaths.historyCoverage.observedAnchorCount).toBe(109)
  })
  it('uses genuine sealed-current availability and witness when that C2 is fresh', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const root = 'data/research/venue-signals/local-carry-cash-v1'
    const receipt = readdirSync(root)
      .filter((n) => /^\d{12}\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(`${root}/${n}`, 'utf8')))
      .filter((r) => r.collectionMode === 'current')
      .sort((a, b) => b.blockAt.localeCompare(a.blockAt))[0]
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(receipt.firstLocalReceiptAt))
    const { body } = await response(aave, '0')
    const r = body.conditionalSampledCashPathProjection
    expect(r.status).toBe('estimated')
    expect(r.currentSource).toMatchObject({
      sourceKind: 'manifest_bound_ledger',
      readAt: receipt.firstLocalReceiptAt,
      receiptSha256: receipt.sha256,
      manifestSha256: receipt.manifestSha256,
    })
    expect(body.sampledCashPaths.current.receiptSha256).toBe(receipt.sha256)
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
  })
  it('rechecks freshness after await without disabling descriptive cash history', async () => {
    let clock = NOW
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.mocked(readConfiguredLiveCurrentCash).mockImplementation(async () => {
      const r = live(vault, 1800000)
      clock++
      return r
    })
    const { body } = await response()
    expect(body.conditionalSampledCashPathProjection).toEqual({
      status: 'unavailable',
      reason: 'source_stale',
    })
    expect(body.sampledCashPaths.status).toBe('conditional_historical_sampled_cash_paths')
  })
  it('rejects a conflicting live source independently of historical availability', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue({ ...live(), block: '1' })
    const { body } = await response()
    expect(body.conditionalSampledCashPathProjection).toEqual({
      status: 'unavailable',
      reason: 'current_source_conflict',
    })
    expect(body.sampledCashPaths.historyCoverage.observedAnchorCount).toBe(109)
  })
  it('enriches generic sources older than30min while archived cash is still within2h', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const root = 'data/research/venue-signals/local-carry-cash-v1'
    const receipt = readdirSync(root)
      .filter((n) => /^\d{12}\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(`${root}/${n}`, 'utf8')))
      .filter((r) => r.collectionMode === 'current')
      .sort((a, b) => b.blockAt.localeCompare(a.blockAt))[0]
    const at = Math.max(
      Date.parse(receipt.firstLocalReceiptAt),
      Date.parse(receipt.blockAt) + 31 * 60000,
    )
    expect(at - Date.parse(receipt.blockAt)).toBeLessThan(2 * 3600000)
    vi.spyOn(Date, 'now').mockReturnValue(at)
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue({
      ...live(),
      block: (BigInt(receipt.block) + 1000n).toString(),
      blockAt: new Date(at - 1000).toISOString(),
      readAtUtc: new Date(at).toISOString(),
    })
    const { body } = await response()
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledTimes(1)
    expect(body.conditionalSampledCashPathProjection.status).toBe('estimated')
  })
  it('preserves invalid amount HTTP400', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    expect((await response(vault, '0', 'not-an-amount')).code).toBe(400)
  })
  it.each([
    {
      routeKey: 'AUSD → Staked USDat [USDat]',
      destination: '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
    },
    {
      routeKey: 'PYUSD → StakingVault [wYLDS]',
      destination: '0x19ebb35279a16207ec4ba82799cc64715065f7f6',
    },
    {
      routeKey: 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
      destination: '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    },
    {
      routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
      destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    },
  ])(
    'never converts native Q one-for-one to foreign first-leg cash for $routeKey',
    async (subject) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      const { code, body } = await response(subject, '0')
      expect(code).toBe(200)
      expect(body.conditionalSampledCashPathProjection).toEqual({
        status: 'unavailable',
        reason: 'subject_mismatch',
      })
    },
  )
})
