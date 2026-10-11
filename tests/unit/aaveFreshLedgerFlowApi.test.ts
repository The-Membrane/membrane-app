import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { carryForecastRequest } from '@/pages/api/carry/forecast'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'
import { selectedConditionalGrossFlowHeadroom } from '@/lib/carry/conditionalGrossFlowHeadroom'
vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(),
}))
const root = 'data/research/venue-signals/local-carry-cash-v1'
const receipt = readdirSync(root)
  .filter((n) => /^\d{12}\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(`${root}/${n}`, 'utf8')))
  .filter((r) => r.collectionMode === 'current')
  .sort((a, b) => b.blockAt.localeCompare(a.blockAt))[0]
const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const fresh = Date.parse(receipt.firstLocalReceiptAt)
async function response(include = '0', amount = '1') {
  vi.stubEnv('NODE_ENV', 'development')
  const headers = vi.fn()
  let body: any,
    code = 0
  await carryForecastRequest(
    {
      method: 'GET',
      query: {
        routeKey: market.routeKey,
        destination: market.destination.toLowerCase(),
        amountUnits: amount,
        horizonHours: '24',
        includeLiveCurrent: include,
      },
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
  return { body, code, headers }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('fresh verified native Aave C2 joint-flow API', () => {
  it.each(['0', '1'])(
    'uses genuine ledger C2 with includeLiveCurrent=%s without RPC or fabricated freshness',
    async (include) => {
      vi.spyOn(Date, 'now').mockReturnValue(fresh)
      const fetch = vi.fn(() => {
        throw Error('NETWORK_DISABLED')
      })
      vi.stubGlobal('fetch', fetch)
      const { body, code, headers } = await response(include)
      expect(code).toBe(200)
      expect(headers).toHaveBeenCalledWith('Cache-Control', 'no-store')
      expect(fetch).not.toHaveBeenCalled()
      expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
      const r = body.conditionalGrossFlowHeadroom
      expect(r.status).toBe('estimated')
      expect(r.request.requestedRaw).toBe('1000000')
      expect(r.currentSource).toMatchObject({
        blockNumber: Number(receipt.block),
        blockHash: receipt.blockHash,
        blockTime: receipt.blockAt,
        readAt: receipt.firstLocalReceiptAt,
        finalized: true,
        assetDecimals: 6,
      })
      expect(body.sampledCashPaths.current).toMatchObject({
        receiptSha256: receipt.sha256,
        manifestSha256: receipt.manifestSha256,
        firstLocalReceiptAt: receipt.firstLocalReceiptAt,
      })
      expect(body.sampledCashPaths.current.sourceKind).toBeUndefined()
      expect(body.sampledCashPaths.current.readAtUtc).toBeUndefined()
      expect(body.conditionalSampledCashPathProjection.currentSource.sourceKind).toBe(
        'manifest_bound_ledger',
      )
      const c = body.sampledCashPaths.current
      expect(
        selectedConditionalGrossFlowHeadroom(
          r,
          {
            currentSource: {
              chainId: 1,
              routeKey: market.routeKey,
              destination: market.destination.toLowerCase(),
              asset: market.underlying.toLowerCase(),
              assetDecimals: 6,
              cashRaw: c.cashRaw,
              blockNumber: Number(c.block),
              blockHash: c.blockHash,
              blockTime: c.blockAt,
              readAt: c.firstLocalReceiptAt,
              finalized: true,
            },
            request: { requestedRaw: '1000000', asOf: r.request.asOf },
          },
          (s) => createHash('sha256').update(s).digest('hex'),
        ),
      ).not.toBeNull()
      for (const scenario of r.scenarios)
        expect(BigInt(scenario.userHeadroomRaw)).toBe(BigInt(scenario.capacityRaw) - 1000000n)
      expect(r.holderExecutableExit).toBe(false)
    },
  )
  it.each([
    [1800000, 'estimated'],
    [1800001, 'unavailable'],
  ] as const)(
    'reages native source at inclusive boundary%i without retiming',
    async (age, status) => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(receipt.blockAt) + age)
      const { body } = await response()
      expect(body.conditionalGrossFlowHeadroom.status).toBe(status)
      if (status === 'unavailable')
        expect(body.conditionalGrossFlowHeadroom.reason).toBe('source_stale')
      else expect(body.conditionalGrossFlowHeadroom.currentSource.blockTime).toBe(receipt.blockAt)
      expect(body.sampledCashPaths.historyCoverage.observedAnchorCount).toBe(120)
      expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
    },
  )
  it('refreshes once when native C2 is older than30min and accepts a truly newer agreed header', async () => {
    const now = Date.parse(receipt.blockAt) + 1800001
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue({
      status: 'available',
      sourceKind: 'live_read_only_two_origin_finalized',
      routeKey: market.routeKey,
      destination: market.destination.toLowerCase(),
      asset: market.underlying.toLowerCase(),
      assetDecimals: 6,
      cashRaw: '100000000',
      block: (BigInt(receipt.block) + 1000n).toString(),
      blockHash: `0x${'a'.repeat(64)}`,
      blockAt: new Date(now - 1000).toISOString(),
      readAtUtc: new Date(now).toISOString(),
    })
    const { body } = await response('1')
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledTimes(1)
    expect(body.conditionalGrossFlowHeadroom.status).toBe('estimated')
    expect(body.conditionalGrossFlowHeadroom.currentSource.blockNumber).toBe(
      Number(receipt.block) + 1000,
    )
  })
  it('invalid amount remains HTTP400 before enrichment', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(fresh)
    expect((await response('1', 'bad')).code).toBe(400)
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
  })
})
