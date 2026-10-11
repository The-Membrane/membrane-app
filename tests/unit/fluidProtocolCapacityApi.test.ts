import { afterEach, describe, it, expect, vi } from 'vitest'
import receipt from '@/data/research/venue-signals/fluid-protocol-capacity-current-usdc-2026-10-07T11-15.json'
import { FLUID_PROTOCOL_CAPACITY_HISTORY_PINS } from '@/lib/carry/fluidProtocolCapacityHistoryPins'
import {
  readFluidProtocolCapacityProjection,
  readVerifiedFluidProtocolHistory,
  carryForecastRequest,
} from '@/pages/api/carry/forecast'
import { captureFluidCapacityProngs } from '@/scripts/research/carry-fluid-capacity-prongs.mjs'
vi.mock('@/scripts/research/carry-fluid-capacity-prongs.mjs', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  captureFluidCapacityProngs: vi.fn(),
}))
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'
vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(),
}))
let serial = 0
function fixture() {
  const source = {
    ...receipt.source,
    blockNumber: receipt.source.blockNumber + ++serial,
    blockHash: '0x' + serial.toString(16).padStart(64, '0'),
  }
  const prongs = structuredClone(receipt.prongs)
  prongs.source = source
  for (const o of prongs.origins) o.source = structuredClone(source)
  const now = Date.parse(source.blockTime) + 1700000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  return {
    source,
    now,
    subject: receipt.subject,
    result: { ...receipt, source, prongs, capturedAt: new Date(now).toISOString() },
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
describe('Fluid independent protocol prong API seam', () => {
  it('replays all three pinned full historical receipts offline', async () => {
    for (const p of FLUID_PROTOCOL_CAPACITY_HISTORY_PINS)
      expect(await readVerifiedFluidProtocolHistory(p.compact.subject)).toBe(true)
  })
  it('deduplicates current exact-source28 read independently of Q and caches facts only', async () => {
    const f = fixture()
    vi.mocked(captureFluidCapacityProngs).mockResolvedValue(f.result)
    const a = readFluidProtocolCapacityProjection(f.subject, f.source, '1000000000', 24)
    const b = readFluidProtocolCapacityProjection(f.subject, f.source, '2000000000', 48)
    const [one, two] = await Promise.all([a, b])
    expect(one.status).toBe('fluid_protocol_capacity_projection')
    expect(two.status).toBe(one.status)
    expect(captureFluidCapacityProngs).toHaveBeenCalledTimes(1)
    expect(captureFluidCapacityProngs).toHaveBeenCalledWith(
      f.subject,
      expect.arrayContaining([
        expect.objectContaining({ host: 'eth-mainnet.g.alchemy.com' }),
        expect.objectContaining({ host: 'rpc.ankr.com' }),
      ]),
      { source: f.source, maxRequests: 28 },
    )
    expect((one as any).request.requestedRaw).toBe('1000000000')
    expect((two as any).request.requestedRaw).toBe('2000000000')
    expect((one as any).projection.horizons[0].elapsedSeconds).toEqual({
      lower: 10884,
      upper: 10884,
    })
    await readFluidProtocolCapacityProjection(f.subject, f.source, '1', 24)
    expect(captureFluidCapacityProngs).toHaveBeenCalledTimes(1)
    vi.mocked(Date.now).mockReturnValue(Date.parse(f.source.blockTime) + 1800001)
    expect((await readFluidProtocolCapacityProjection(f.subject, f.source, '1', 24)).status).toBe(
      'unavailable',
    )
  })
  it('source expiry after await discards current projection, retaining no future claims', async () => {
    const f = fixture()
    vi.mocked(captureFluidCapacityProngs).mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(Date.parse(f.source.blockTime) + 1800001)
      return f.result
    })
    expect(await readFluidProtocolCapacityProjection(f.subject, f.source, '1', 24)).toEqual({
      status: 'unavailable',
      reason: 'current_prongs_unavailable',
    })
  })
  it('invalid or foreign native identity/Q/source fails before any reader', async () => {
    const f = fixture()
    for (const [s, src, q] of [
      [{ ...f.subject, assetDecimals: 18 }, f.source, '1'],
      [f.subject, f.source, ['1']],
      [f.subject, { ...f.source, blockNumber: [1] }, '1'],
      [f.subject, { ...f.source, blockTime: [f.source.blockTime] }, '1'],
    ])
      expect(
        (await readFluidProtocolCapacityProjection(s as any, src as any, q as any, 24)).status,
      ).toBe('unavailable')
    expect(captureFluidCapacityProngs).not.toHaveBeenCalled()
  })
  it.each([1, 24, 48, 168])(
    'opt-in H%s joins exact source without rescaling10884s donor',
    async (horizonHours) => {
      const f = fixture(),
        now = Date.parse('2026-10-07T12:00:00.000Z')
      f.source.blockNumber = 26190000
      f.source.blockTime = '2026-10-07T11:50:00.000Z'
      f.result.source = structuredClone(f.source)
      f.result.prongs.source = structuredClone(f.source)
      for (const origin of f.result.prongs.origins) origin.source = structuredClone(f.source)
      f.result.capturedAt = new Date(now).toISOString()
      vi.mocked(Date.now).mockReturnValue(now)
      vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue({
        status: 'available',
        ...f.subject,
        cashRaw: '0',
        block: String(f.source.blockNumber),
        blockHash: f.source.blockHash,
        blockAt: f.source.blockTime,
        readAtUtc: new Date(now).toISOString(),
        sourceKind: 'live_read_only_two_origin_finalized',
      })
      vi.mocked(captureFluidCapacityProngs).mockResolvedValue(f.result)
      vi.stubEnv('NODE_ENV', 'development')
      let body: any
      await carryForecastRequest(
        {
          method: 'GET',
          query: {
            routeKey: f.subject.routeKey,
            destination: f.subject.destination,
            amountUnits: '1000',
            horizonHours: String(horizonHours),
            includeLiveCurrent: '1',
          },
          socket: { remoteAddress: '127.0.0.1' },
        } as any,
        {
          setHeader() {},
          status(n: number) {
            expect(n).toBe(200)
            return this
          },
          json(v: any) {
            body = v
          },
        } as any,
        async () => ({ status: 'unavailable' }) as any,
        async () => ({ status: 'unavailable' }) as any,
      )
      expect(readConfiguredLiveCurrentCash).toHaveBeenCalledTimes(1)
      expect(captureFluidCapacityProngs).toHaveBeenCalledTimes(1)
      expect(body.fluidProtocolCapacityProjection.status).toBe('fluid_protocol_capacity_projection')
      expect(body.fluidProtocolCapacityProngs.currentProngs.source).toEqual(f.source)
      expect(body.fluidProtocolCapacityProjection.projection.horizons[0].elapsedSeconds).toEqual({
        lower: 10884,
        upper: 10884,
      })
      expect(body.fluidProtocolCapacityProjection.request.horizonHours).toBe(horizonHours)
      expect(body.fluidProtocolCapacityProjection.request.requestedRaw).toBe('1000000000')
      expect(body.fluidProtocolCapacityProjection.projection.holderExecutableExit).toBe(false)
    },
  )
  it('normal include0 handler remains network-free and historical cash usable', async () => {
    const f = fixture()
    vi.stubEnv('NODE_ENV', 'development')
    let body: any
    const headers = vi.fn()
    await carryForecastRequest(
      {
        method: 'GET',
        query: {
          routeKey: f.subject.routeKey,
          destination: f.subject.destination,
          amountUnits: '1000',
          horizonHours: '24',
          includeLiveCurrent: '0',
        },
        socket: { remoteAddress: '127.0.0.1' },
      } as any,
      {
        setHeader: headers,
        status(n: number) {
          expect(n).toBe(200)
          return this
        },
        json(v: any) {
          body = v
        },
      } as any,
      async () => ({ status: 'unavailable' }) as any,
      async () => ({ status: 'unavailable' }) as any,
    )
    expect(body.fluidProtocolCapacityProjection).toEqual({
      status: 'unavailable',
      reason: 'live_current_not_requested',
    })
    expect(body.sampledCashPaths.status).toBe('conditional_historical_sampled_cash_paths')
    expect(captureFluidCapacityProngs).not.toHaveBeenCalled()
    expect(headers).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
})
