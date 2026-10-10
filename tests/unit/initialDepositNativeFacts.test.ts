import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  readInitialDepositNativeFacts,
  readConfiguredInitialDepositNativeFacts,
} from '@/scripts/research/carry-initial-deposit-native-facts.mjs'
import { INITIAL_DEPOSIT_MARKETS } from '@/lib/carry/initialDepositCapacityProjection'

const now = Date.parse('2026-10-08T12:00:00.000Z'),
  RAY = 10n ** 27n
function setup() {
  const m = INITIAL_DEPOSIT_MARKETS[0]
  const source = {
    chainId: 1 as const,
    routeKey: m.routeKey,
    destination: m.destination.toLowerCase(),
    asset: m.underlying.toLowerCase(),
    assetDecimals: 6,
    cashRaw: '123',
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(now - 1000).toISOString(),
    readAt: new Date(now).toISOString(),
    sourceKind: 'live_read_only_two_origin_finalized' as const,
  }
  const header = {
    number: BigInt(source.block),
    hash: source.blockHash,
    timestamp: BigInt((now - 1000) / 1000),
  }
  const origins = ['https://one.example/key-secret-one', 'https://two.example/key-secret-two'].map(
    (url) => ({
      url,
      client: {
        getBlock: vi.fn(async () => header),
        readContract: vi.fn(async (r: any) => {
          if (r.functionName === 'getReserveData')
            return {
              aTokenAddress: source.destination,
              configuration: (6n << 48n) | (1n << 56n),
              accruedToTreasury: 7n,
            }
          return r.functionName === 'getReserveNormalizedIncome' ? RAY : 456n
        }),
      },
    }),
  )
  return { source, origins, header }
}
describe('same-source optional initial-deposit native facts', () => {
  it('reads exactly 3 getters per origin at the unchanged checked source, with header brackets', async () => {
    const { source, origins } = setup(),
      r = await readInitialDepositNativeFacts(source, { origins, clock: () => now })
    expect(r.status).toBe('agreed_initial_deposit_native_facts')
    expect(r.currentSource).toEqual(source)
    for (const o of origins) {
      expect(o.client.getBlock).toHaveBeenCalledTimes(2)
      expect(o.client.readContract).toHaveBeenCalledTimes(3)
      for (const [call] of o.client.readContract.mock.calls)
        expect(call.blockNumber).toBe(BigInt(source.block))
    }
    const payload = JSON.stringify(r)
    expect(payload).not.toContain('key-secret')
    expect(payload).not.toContain('https:')
    expect(r.origins[0].originHostSha256).toBe(
      createHash('sha256').update('one.example').digest('hex'),
    )
  })
  it('refuses source-hash disagreement before launching native getters', async () => {
    const { source, origins, header } = setup()
    origins[1].client.getBlock.mockResolvedValue({ ...header, hash: `0x${'b'.repeat(64)}` })
    expect(await readInitialDepositNativeFacts(source, { origins, clock: () => now })).toEqual({
      status: 'unavailable',
      reason: 'native_source_header_disagreement',
    })
    expect(origins[0].client.readContract).not.toHaveBeenCalled()
  })
  it('rejects disagreement and an after-read source change', async () => {
    const a = setup()
    a.origins[1].client.readContract.mockImplementation(async (r: any) =>
      r.functionName === 'getReserveData'
        ? { aTokenAddress: a.source.destination, configuration: 6n << 48n, accruedToTreasury: 7n }
        : r.functionName === 'getReserveNormalizedIncome'
          ? RAY + 1n
          : 456n,
    )
    expect(
      (await readInitialDepositNativeFacts(a.source, { origins: a.origins, clock: () => now }))
        .status,
    ).toBe('unavailable')
    const b = setup()
    b.origins[0].client.getBlock
      .mockResolvedValueOnce(b.header)
      .mockResolvedValue({ ...b.header, number: 1n })
    expect(
      await readInitialDepositNativeFacts(b.source, { origins: b.origins, clock: () => now }),
    ).toMatchObject({ reason: 'native_source_header_changed' })
  })
  it('rejects a wrong aToken, stale source and duplicate origin host', async () => {
    const a = setup()
    a.origins[1].client.readContract.mockResolvedValue(1n)
    expect(
      (await readInitialDepositNativeFacts(a.source, { origins: a.origins, clock: () => now }))
        .status,
    ).toBe('unavailable')
    const b = setup()
    expect(
      (
        await readInitialDepositNativeFacts(b.source, {
          origins: b.origins,
          clock: () => now + 1800000,
        })
      ).status,
    ).toBe('unavailable')
    b.origins[1].url = 'https://www.one.example/different-secret'
    expect(
      await readInitialDepositNativeFacts(b.source, { origins: b.origins, clock: () => now }),
    ).toMatchObject({ reason: 'rpc_origins_unavailable' })
  })
  it('caches and deduplicates the bounded source/provider read independently of D and Q', async () => {
    const { source, origins } = setup(),
      factory = vi.fn((url: string) => origins.find((o) => o.url === url)!.client)
    const options = {
      rpcUrls: origins.map((o) => o.url).join(','),
      clock: () => now,
      clientFactory: factory,
    }
    const [a, b] = await Promise.all([
      readConfiguredInitialDepositNativeFacts(source, options),
      readConfiguredInitialDepositNativeFacts(source, options),
    ])
    expect(a).toEqual(b)
    expect(a.status).toBe('agreed_initial_deposit_native_facts')
    await readConfiguredInitialDepositNativeFacts(source, options)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(origins[0].client.readContract).toHaveBeenCalledTimes(3)
    const later = await readConfiguredInitialDepositNativeFacts(
      { ...source, readAt: new Date(now + 1000).toISOString() },
      { ...options, clock: () => now + 1000 },
    )
    expect(later.currentSource.readAt).toBe(source.readAt)
    expect(later.readAt).toBe(new Date(now).toISOString())
    expect(factory).toHaveBeenCalledTimes(2)
    a.currentSource.cashRaw = '999'
    expect(
      (await readConfiguredInitialDepositNativeFacts(source, options)).currentSource.cashRaw,
    ).toBe('123')
  })
  it('rechecks freshness after native reads without fabricating new source clocks', async () => {
    const { source, origins } = setup()
    let calls = 0
    expect(
      await readInitialDepositNativeFacts(source, {
        origins,
        clock: () => (calls++ ? now + 1800000 : now),
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'initial_deposit_source_stale' })
  })
  it('runs one request at a time per origin in the exact header/getter/header order', async () => {
    const { source, origins } = setup()
    const orders: string[][] = [[], []]
    const active = [0, 0],
      peak = [0, 0]
    for (const [i, o] of origins.entries()) {
      for (const key of ['getBlock', 'readContract'] as const) {
        const original = o.client[key].getMockImplementation()!
        o.client[key].mockImplementation(async (r: any) => {
          active[i]++
          peak[i] = Math.max(peak[i], active[i])
          orders[i].push(r.functionName ?? 'header')
          await new Promise((resolve) => setTimeout(resolve, 2))
          try {
            return await original(r)
          } finally {
            active[i]--
          }
        })
      }
    }
    expect(
      (await readInitialDepositNativeFacts(source, { origins, clock: () => now })).status,
    ).toBe('agreed_initial_deposit_native_facts')
    expect(peak).toEqual([1, 1])
    for (const order of orders)
      expect(order).toEqual([
        'header',
        'getReserveData',
        'getReserveNormalizedIncome',
        'scaledTotalSupply',
        'header',
      ])
  })
  it.each(['external', 'whole_read_budget'])(
    'stops %s acquisition without later getters or headers',
    async (kind) => {
      const { source, origins } = setup()
      const releases: Array<(value: any) => void> = []
      for (const o of origins)
        o.client.readContract.mockImplementation(
          () => new Promise((resolve) => releases.push(resolve)),
        )
      const controller = new AbortController()
      const pending = readInitialDepositNativeFacts(source, {
        origins,
        clock: () => now,
        signal: controller.signal,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(releases).toHaveLength(2)
      if (kind === 'external') controller.abort()
      expect(await pending).toMatchObject({
        status: 'unavailable',
        reason:
          kind === 'external'
            ? 'initial_deposit_native_read_cancelled'
            : 'initial_deposit_native_read_timeout',
      })
      for (const release of releases)
        release({
          aTokenAddress: source.destination,
          configuration: (6n << 48n) | (1n << 56n),
          accruedToTreasury: 7n,
        })
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (const o of origins) {
        expect(o.client.readContract).toHaveBeenCalledTimes(1)
        expect(o.client.getBlock).toHaveBeenCalledTimes(1)
      }
    },
  )
  it('passes cancellation into the actual viem transport and launches no after-headers', async () => {
    const { source } = setup()
    const controller = new AbortController()
    const methods: string[] = []
    let aborted = 0
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const request = JSON.parse(init.body)
      methods.push(request.method)
      expect(init.redirect).toBe('error')
      if (request.method === 'eth_getBlockByNumber')
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              number: `0x${BigInt(source.block).toString(16)}`,
              hash: source.blockHash,
              timestamp: `0x${(BigInt(Date.parse(source.blockTime)) / 1000n).toString(16)}`,
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            aborted++
            reject(new DOMException('Aborted', 'AbortError'))
          },
          { once: true },
        )
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const pending = readConfiguredInitialDepositNativeFacts(source, {
        rpcUrls: 'https://one.transport.example/key-one,https://two.transport.example/key-two',
        clock: () => now,
        cache: false,
        signal: controller.signal,
      })
      for (let i = 0; i < 100 && methods.filter((m) => m === 'eth_call').length < 2; i++)
        await new Promise((resolve) => setTimeout(resolve, 2))
      expect(methods.filter((m) => m === 'eth_call')).toHaveLength(2)
      controller.abort()
      expect(await pending).toMatchObject({ reason: 'initial_deposit_native_read_cancelled' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(aborted).toBe(2)
      expect(methods).toHaveLength(4)
      expect(methods.filter((m) => m === 'eth_getBlockByNumber')).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('cancels a shared waiter without extra starts or cancelling the original acquisition', async () => {
    const { source, origins } = setup()
    const releases: Array<() => void> = []
    for (const o of origins) {
      const original = o.client.readContract.getMockImplementation()!
      o.client.readContract.mockImplementation(async (r: any) => {
        if (r.functionName === 'getReserveData')
          await new Promise<void>((resolve) => releases.push(resolve))
        return original(r)
      })
    }
    const firstController = new AbortController(),
      secondController = new AbortController()
    const options = {
      rpcUrls: 'https://one.shared.example/a,https://two.shared.example/b',
      clock: () => now,
      cache: false,
      clientFactory: vi.fn((url: string) => origins[url.includes('one.') ? 0 : 1].client),
    }
    const first = readConfiguredInitialDepositNativeFacts(source, {
      ...options,
      signal: firstController.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(releases).toHaveLength(2)
    const second = readConfiguredInitialDepositNativeFacts(source, {
      ...options,
      signal: secondController.signal,
    })
    secondController.abort()
    expect(await second).toMatchObject({ reason: 'initial_deposit_native_read_cancelled' })
    expect(firstController.signal.aborted).toBe(false)
    expect(options.clientFactory).toHaveBeenCalledTimes(2)
    for (const release of releases) release()
    expect((await first).status).toBe('agreed_initial_deposit_native_facts')
    for (const o of origins) {
      expect(o.client.getBlock).toHaveBeenCalledTimes(2)
      expect(o.client.readContract).toHaveBeenCalledTimes(3)
    }
  })
})
