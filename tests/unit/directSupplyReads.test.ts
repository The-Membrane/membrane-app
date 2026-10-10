import { describe, expect, it, vi } from 'vitest'
import { isAddress, type PublicClient } from 'viem'

import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { readDirectSupplyCash, readDirectSupplyCashForRoute } from '@/lib/carry/directSupplyReads'

const USDC = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const ATOKEN = '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c'
const COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const SPARK_ATOKEN = '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f'
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const USDE_ATOKEN = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
const BLOCK = { number: 26_080_000n, hash: `0x${'a'.repeat(64)}`, timestamp: 1_800_000_000n }
const NOW = Number(BLOCK.timestamp) * 1000 + 10_000

function mockClient(
  options: {
    chainId?: number
    stale?: boolean
    badHash?: boolean
    wrongIdentity?: boolean
    wrongDecimals?: boolean
    missing?: string
  } = {},
) {
  const getBlock = vi.fn(async (query: { blockTag?: string; blockNumber?: bigint }) => {
    if (query.blockTag === 'finalized')
      return options.stale ? { ...BLOCK, timestamp: BLOCK.timestamp - 7200n } : BLOCK
    if (options.badHash && getBlock.mock.calls.length === 3)
      return { ...BLOCK, hash: `0x${'b'.repeat(64)}` }
    return BLOCK
  })
  const readContract = vi.fn(
    async (call: {
      address: string
      functionName: string
      args?: unknown[]
      blockNumber?: bigint
    }) => {
      if (call.functionName === options.missing) throw new Error('provider URL and token secret')
      if (call.functionName === 'UNDERLYING_ASSET_ADDRESS')
        return options.wrongIdentity
          ? ATOKEN
          : call.address.toLowerCase() === SPARK_ATOKEN
            ? USDT
            : call.address.toLowerCase() === USDE_ATOKEN
              ? USDE
              : USDC
      if (call.functionName === 'baseToken') return options.wrongIdentity ? COMET : USDC
      if (call.functionName === 'decimals')
        return options.wrongDecimals
          ? call.address.toLowerCase() === USDE || call.address.toLowerCase() === USDE_ATOKEN
            ? 6
            : 18
          : call.address.toLowerCase() === USDE || call.address.toLowerCase() === USDE_ATOKEN
            ? 18
            : 6
      if (call.functionName === 'totalSupply')
        return call.address.toLowerCase() === ATOKEN.toLowerCase()
          ? 10_000_000n
          : call.address.toLowerCase() === SPARK_ATOKEN
            ? 30_000_000n
            : call.address.toLowerCase() === USDE_ATOKEN
              ? 40n * 10n ** 18n
              : 20_000_000n
      if (call.functionName === 'balanceOf') {
        if (call.address.toLowerCase() === USDE)
          return call.args?.[0]?.toString().toLowerCase() === USDE_ATOKEN ? 12n * 10n ** 18n : 0n
        if (call.address.toLowerCase() === USDT)
          return call.args?.[0]?.toString().toLowerCase() === SPARK_ATOKEN ? 3_500_000n : 0n
        if (call.address.toLowerCase() !== USDC.toLowerCase()) throw new Error('wrong asset')
        return call.args?.[0]?.toString().toLowerCase() === ATOKEN.toLowerCase()
          ? 1_500_000n
          : 2_500_000n
      }
      throw new Error('unexpected call')
    },
  )
  const client = {
    getChainId: vi.fn(async () => options.chainId ?? 1),
    getBlock,
    readContract,
  } as unknown as Pick<PublicClient, 'getChainId' | 'getBlock' | 'readContract'>
  return { client, getBlock, readContract }
}

describe('direct supply cash reads', () => {
  it('keeps every runtime market address valid for viem', () => {
    for (const market of Object.values(DIRECT_SUPPLY_MARKETS)) {
      expect(isAddress(market.destination)).toBe(true)
      expect(isAddress(market.underlying)).toBe(true)
    }
  })

  it('pins both routes and USDC cash to one verified finalized block', async () => {
    const { client, getBlock, readContract } = mockClient()
    const result = await readDirectSupplyCash(client, NOW)
    expect(result.source).toMatchObject({
      chainId: 1,
      blockNumber: Number(BLOCK.number),
      blockHash: BLOCK.hash,
      finality: 'finalized',
      ageSeconds: 10,
    })
    expect(result.routes).toEqual([
      expect.objectContaining({
        routeKey: 'USDC → supply on Aave V3',
        destination: ATOKEN,
        cashUsdc: '1.5',
        totalSupplyRaw: '10000000',
      }),
      expect.objectContaining({
        routeKey: 'USDC → supply on Compound v3',
        destination: COMET,
        cashUsdc: '2.5',
        totalSupplyRaw: '20000000',
      }),
    ])
    expect(result.caveat).toContain('no holder-specific withdraw limit')
    expect(getBlock.mock.calls).toEqual([
      [{ blockTag: 'finalized' }],
      [{ blockNumber: BLOCK.number }],
      [{ blockNumber: BLOCK.number }],
    ])
    expect(readContract.mock.calls).toHaveLength(9)
    expect(readContract.mock.calls.every(([call]) => call.blockNumber === BLOCK.number)).toBe(true)
    expect(
      readContract.mock.calls
        .filter(([call]) => call.functionName === 'balanceOf')
        .map(([call]) => call.args),
    ).toEqual([[ATOKEN], [COMET]])
  })

  it('fails closed on chain, freshness, identity, precision, unavailable read, and hash change', async () => {
    for (const [options, reason] of [
      [{ chainId: 10 }, 'direct_supply_chain_mismatch'],
      [{ stale: true }, 'direct_supply_finalized_block_stale'],
      [{ wrongIdentity: true }, 'direct_supply_identity_or_state_mismatch'],
      [{ wrongDecimals: true }, 'direct_supply_identity_or_state_mismatch'],
      [{ missing: 'balanceOf' }, 'direct_supply_read_unavailable'],
      [{ badHash: true }, 'direct_supply_block_hash_changed'],
    ] as const) {
      await expect(readDirectSupplyCash(mockClient(options).client, NOW)).rejects.toThrow(reason)
    }
  })

  it('does not accept a reading that ages out during the RPC batch', async () => {
    let calls = 0
    await expect(
      readDirectSupplyCash(mockClient().client, () =>
        calls++ === 0 ? NOW : NOW + 2 * 60 * 60 * 1000,
      ),
    ).rejects.toThrow('direct_supply_finalized_block_stale')
  })

  it('keeps Aave available when Compound fails and never reads Compound', async () => {
    const { client, readContract, getBlock } = mockClient({ missing: 'baseToken' })
    const result = await readDirectSupplyCashForRoute(client, 'USDC → supply on Aave V3', NOW)
    expect(result.route).toMatchObject({
      routeKey: 'USDC → supply on Aave V3',
      destination: ATOKEN,
      cashUsdc: '1.5',
    })
    expect(readContract.mock.calls.map(([call]) => call.functionName)).toEqual([
      'UNDERLYING_ASSET_ADDRESS',
      'totalSupply',
      'decimals',
      'decimals',
      'balanceOf',
    ])
    expect(getBlock).toHaveBeenCalledTimes(3)
    expect(readContract.mock.calls.every(([call]) => call.blockNumber === BLOCK.number)).toBe(true)
  })

  it('keeps Compound available when Aave fails and never reads Aave', async () => {
    const { client, readContract } = mockClient({ missing: 'UNDERLYING_ASSET_ADDRESS' })
    const result = await readDirectSupplyCashForRoute(client, 'USDC → supply on Compound v3', NOW)
    expect(result.route).toMatchObject({
      routeKey: 'USDC → supply on Compound v3',
      destination: COMET,
      cashUsdc: '2.5',
    })
    expect(readContract.mock.calls.map(([call]) => call.functionName)).toEqual([
      'baseToken',
      'totalSupply',
      'decimals',
      'decimals',
      'balanceOf',
    ])
  })

  it('reads only the SparkLend USDT aToken at a hash-checked finalized block', async () => {
    const { client, readContract, getBlock } = mockClient({ missing: 'baseToken' })
    const result = await readDirectSupplyCashForRoute(client, 'USDT → supply on Spark', NOW)
    expect(result.asset).toEqual({ symbol: 'USDT', address: USDT, decimals: 6 })
    expect(result.route).toMatchObject({
      routeKey: 'USDT → supply on Spark',
      venueKind: 'spark_lend_atoken',
      destination: SPARK_ATOKEN,
      cashRaw: '3500000',
      cashAsset: '3.5',
      totalSupplyRaw: '30000000',
    })
    expect(result.route.cashUsdc).toBeUndefined()
    expect(result.caveat).toContain('13 of 15')
    expect(getBlock).toHaveBeenCalledTimes(3)
    expect(readContract.mock.calls.map(([call]) => call.functionName)).toEqual([
      'UNDERLYING_ASSET_ADDRESS',
      'totalSupply',
      'decimals',
      'decimals',
      'balanceOf',
    ])
    expect(readContract.mock.calls.every(([call]) => call.blockNumber === BLOCK.number)).toBe(true)
    expect(
      readContract.mock.calls.every(
        ([call]) =>
          call.address.toLowerCase() === SPARK_ATOKEN || call.address.toLowerCase() === USDT,
      ),
    ).toBe(true)
    expect(readContract.mock.calls.at(-1)?.[0]).toMatchObject({
      address: USDT,
      args: [SPARK_ATOKEN],
    })
  })

  it('reads only the distinct Aave USDe reserve cash at 18 decimals', async () => {
    const { client, readContract } = mockClient({ missing: 'baseToken' })
    const result = await readDirectSupplyCashForRoute(client, 'USDe → supply on Aave V3', NOW)
    expect(result.asset).toEqual({
      symbol: 'USDe',
      address: DIRECT_SUPPLY_MARKETS.aaveV3Usde.underlying,
      decimals: 18,
    })
    expect(result.route).toMatchObject({
      routeKey: 'USDe → supply on Aave V3',
      venueKind: 'aave_v3_atoken',
      destination: DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination,
      cashRaw: (12n * 10n ** 18n).toString(),
      cashAsset: '12',
      totalSupplyRaw: (40n * 10n ** 18n).toString(),
    })
    expect(result.route.cashUsdc).toBeUndefined()
    expect(
      readContract.mock.calls.every(
        ([call]) =>
          call.address.toLowerCase() === USDE_ATOKEN || call.address.toLowerCase() === USDE,
      ),
    ).toBe(true)
  })

  it('fails closed when the Aave USDe reserve identity or precision differs', async () => {
    for (const options of [{ wrongIdentity: true }, { wrongDecimals: true }] as const) {
      await expect(
        readDirectSupplyCashForRoute(mockClient(options).client, 'USDe → supply on Aave V3', NOW),
      ).rejects.toThrow('direct_supply_identity_or_state_mismatch')
    }
  })

  it('fails closed for Spark identity, precision, stale block, chain and hash', async () => {
    for (const [options, reason] of [
      [{ wrongIdentity: true }, 'direct_supply_identity_or_state_mismatch'],
      [{ wrongDecimals: true }, 'direct_supply_identity_or_state_mismatch'],
      [{ stale: true }, 'direct_supply_finalized_block_stale'],
      [{ chainId: 10 }, 'direct_supply_chain_mismatch'],
      [{ badHash: true }, 'direct_supply_block_hash_changed'],
      [{ missing: 'balanceOf' }, 'direct_supply_read_unavailable'],
    ] as const) {
      await expect(
        readDirectSupplyCashForRoute(mockClient(options).client, 'USDT → supply on Spark', NOW),
      ).rejects.toThrow(reason)
    }
  })

  it('rejects unknown routes and still fails closed on selected-route identity and hash', async () => {
    await expect(
      readDirectSupplyCashForRoute(mockClient().client, 'not a route' as never, NOW),
    ).rejects.toThrow('direct_supply_route_unknown')
    await expect(
      readDirectSupplyCashForRoute(
        mockClient({ wrongIdentity: true }).client,
        'USDC → supply on Compound v3',
        NOW,
      ),
    ).rejects.toThrow('direct_supply_identity_or_state_mismatch')
    await expect(
      readDirectSupplyCashForRoute(
        mockClient({ badHash: true }).client,
        'USDC → supply on Aave V3',
        NOW,
      ),
    ).rejects.toThrow('direct_supply_block_hash_changed')
  })
})
