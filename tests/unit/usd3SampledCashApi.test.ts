import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { carryForecastRequest } from '@/pages/api/carry/forecast'
import { selectedConditionalSampledCashPathProjection } from '@/lib/carry/conditionalSampledCashPathProjection'
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
const native = receipt.rows.find((r: any) => r.routeKey === 'USDC → USD3 [USDC]')
const now = Date.parse(receipt.firstLocalReceiptAt)
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
async function response(
  horizon: number,
  routeKey = native.routeKey,
  destination = native.destination,
) {
  vi.stubEnv('NODE_ENV', 'development')
  let body: any, status: number | undefined
  const setHeader = vi.fn()
  await carryForecastRequest(
    {
      method: 'GET',
      query: {
        routeKey,
        destination,
        amountUnits: '1',
        horizonHours: String(horizon),
        includeLiveCurrent: '0',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as any,
    {
      setHeader,
      status(code: number) {
        status = code
        return this
      },
      json(v: any) {
        body = v
      },
    } as any,
    async () => ({ status: 'unavailable' }) as any,
    async () => ({ status: 'unavailable' }) as any,
  )
  expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  return { body, status }
}
describe('registered USD3 native history at any requested horizon', () => {
  it.each([1, 24, 48, 168])(
    'H%s preserves independently sealed native cash and actual daily targets',
    async (horizon) => {
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const { body, status } = await response(horizon)
      expect(status).toBe(200)
      const projection = body.conditionalSampledCashPathProjection
      expect(projection.status).toBe('estimated')
      const currentSource = {
        routeKey: native.routeKey,
        destination: native.destination,
        asset: native.asset,
        assetDecimals: native.assetDecimals,
        chainId: 1 as const,
        cashRaw: native.cashRaw,
        block: receipt.block,
        blockHash: receipt.blockHash,
        blockTime: receipt.blockAt,
        readAt: receipt.firstLocalReceiptAt,
        sourceKind: 'manifest_bound_ledger' as const,
        manifestSha256: receipt.manifestSha256,
        receiptSha256: receipt.sha256,
      }
      expect(
        selectedConditionalSampledCashPathProjection(
          projection,
          {
            identity: {
              routeKey: native.routeKey,
              destination: native.destination,
              asset: native.asset,
              assetDecimals: 6,
            },
            requestedRaw: '1000000',
            currentSource,
            asOfMs: now,
          },
          hash,
        ),
      ).toEqual(projection)
      expect(projection.counts.samples).toBe(120)
      expect(projection.counts.eligibleEpisodes).toBe(17)
      expect(projection.horizons[0].target.lowerSeconds).toBeGreaterThan(80000)
      expect(projection.horizons[0].target.upperSeconds).toBeLessThan(92000)
      expect(body.sampledCashPaths.current.cashRaw).toBe(native.cashRaw)
      expect(body.sampledCashPaths.current.blockHash).toBe(receipt.blockHash)
      expect(body.sampledCashPaths.current.manifestSha256).toBe(receipt.manifestSha256)
      expect(body.sampledCashPaths.current.receiptSha256).toBe(receipt.sha256)
      expect(projection.holderExecutableExit).toBe(false)
      expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
    },
    10000,
  )
  it('does not enable a foreign registered staged subject at H1', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const foreign = receipt.rows.find((r: any) => r.routeKey === 'apxUSD → ApyUSD [apxUSD]')
    const { body, status } = await response(1, foreign.routeKey, foreign.destination)
    expect(status).toBe(200)
    expect(body.conditionalSampledCashPathProjection.status).toBe('unavailable')
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
  }, 10000)
  it('rejects a foreign destination instead of granting USD3 eligibility', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { status, body } = await response(48, native.routeKey, `0x${'f'.repeat(40)}`)
    expect(status).toBe(404)
    expect(body.error).toBe('unknown_route_destination')
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
  })
})
