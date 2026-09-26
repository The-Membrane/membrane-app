import { describe, expect, it, vi } from 'vitest'

import { readDepthMarkets, readVenueState } from '../../scripts/lib/venue-reads.mjs'

const blockNumber = 26_050_480n
const venue = {
  depthMarkets: [
    {
      enabled: true,
      name: 'crvUSD/USDC',
      kind: 'curve-stableswap',
      address: '0x0000000000000000000000000000000000000001',
      token0: '0x0000000000000000000000000000000000000002',
      token1: '0x0000000000000000000000000000000000000003',
      exitFrom: '0x0000000000000000000000000000000000000003',
    },
  ],
}

function mockClient({ failReserve = false, failDecimals = false } = {}) {
  const readContract = vi.fn(
    async (call: {
      functionName: string
      address: string
      args?: bigint[]
      blockNumber?: bigint
    }) => {
      if (call.functionName === 'decimals') {
        if (failDecimals && call.address === venue.depthMarkets[0].token0)
          throw new Error('RPC read failed')
        return call.address === venue.depthMarkets[0].token0 ? 6n : 18n
      }
      if (call.functionName === 'balances') {
        if (failReserve && call.args?.[0] === 0n) throw new Error('RPC read failed')
        return call.args?.[0] === 0n ? 5_000_000n * 10n ** 6n : 4_000_000n * 10n ** 18n
      }
      if (call.functionName === 'balanceOf') throw new Error('fallback also failed')
      throw new Error('unexpected call')
    },
  )
  return { readContract }
}

describe('recorded exit depth', () => {
  it('uses one pinned block and the swap-into side when all reads succeed', async () => {
    const client = mockClient()
    const result = await readDepthMarkets(client, venue, blockNumber)
    expect(result.depth_usd).toBe(5_000_000)
    expect(result.depth_complete).toBe(true)
    expect(result.depthMarkets[0]).toMatchObject({
      kind: 'curve-stableswap',
      token0: venue.depthMarkets[0].token0,
      token1: venue.depthMarkets[0].token1,
      exitFrom: venue.depthMarkets[0].exitFrom,
      decimals0: 6,
      decimals1: 18,
      priceAssumptionUsd: 1,
      reads: { reserve0: true, reserve1: true, decimals0: true, decimals1: true },
    })
    expect(client.readContract.mock.calls.every(([call]) => call.blockNumber === blockNumber)).toBe(
      true,
    )
  })

  it('keeps partial raw rows but does not publish a false zero after a reserve read fails', async () => {
    const result = await readDepthMarkets(mockClient({ failReserve: true }), venue, blockNumber)
    expect(result.depth_usd).toBeNull()
    expect(result.depth_complete).toBe(false)
    expect(result.depthMarkets[0].exitableUsd).toBeNull()
  })

  it('does not assume 18 decimals when the exit-side token precision read fails', async () => {
    const result = await readDepthMarkets(mockClient({ failDecimals: true }), venue, blockNumber)
    expect(result.depth_usd).toBeNull()
    expect(result.depth_complete).toBe(false)
    expect(result.depthMarkets[0].reads.decimals0).toBe(false)
  })

  it('retains PSM buffer identity, precision, price assumption, and read status', async () => {
    const psmVenue = {
      depthMarkets: [
        {
          enabled: true,
          name: 'USDS to USDC',
          kind: 'psm-buffer',
          address: '0x0000000000000000000000000000000000000041',
          buffer: '0x0000000000000000000000000000000000000042',
          bufferToken: '0x0000000000000000000000000000000000000043',
          exitFrom: '0x0000000000000000000000000000000000000044',
        },
      ],
    }
    const client = {
      readContract: vi.fn(async (call: { functionName: string; address: string }) => {
        if (call.functionName === 'decimals') return 6n
        if (call.functionName === 'balanceOf') return 8_000_000n
        throw new Error('unexpected call')
      }),
    }
    const result = await readDepthMarkets(client, psmVenue, blockNumber)
    expect(result.depth_usd).toBe(8)
    expect(result.depthMarkets[0]).toMatchObject({
      kind: 'psm-buffer',
      address: psmVenue.depthMarkets[0].address,
      buffer: psmVenue.depthMarkets[0].buffer,
      bufferToken: psmVenue.depthMarkets[0].bufferToken,
      exitFrom: psmVenue.depthMarkets[0].exitFrom,
      bufferDecimals: 6,
      priceAssumptionUsd: 1,
      reads: { buffer: true, decimals: true },
    })
    expect(
      client.readContract.mock.calls.every(
        ([call]) => call.address === psmVenue.depthMarkets[0].bufferToken,
      ),
    ).toBe(true)
  })
})

const aTokenVenue = {
  kind: 'atoken-liquidity',
  address: '0x0000000000000000000000000000000000000011',
  underlying: '0x0000000000000000000000000000000000000022',
  decimals: 6,
}

function mockATokenClient({
  underlyingOnchain = aTokenVenue.underlying,
  underlyingDecimals = 6n,
  failIdentity = false,
} = {}) {
  const readContract = vi.fn(
    async (call: {
      functionName: string
      address: string
      args?: string[]
      blockNumber?: bigint
    }) => {
      if (call.functionName === 'UNDERLYING_ASSET_ADDRESS') {
        if (failIdentity) throw new Error('identity RPC failed')
        return underlyingOnchain
      }
      if (call.functionName === 'decimals') return underlyingDecimals
      if (call.functionName === 'balanceOf') return 5_000_000n
      throw new Error(`unexpected call: ${call.functionName}`)
    },
  )
  return { readContract }
}

describe('recorded aToken identity', () => {
  it('saves the configured pair, independent pinned reads, decimals, and read status', async () => {
    const client = mockATokenClient()
    const result = await readVenueState(client, aTokenVenue, blockNumber)

    expect(result.instantUsd).toBe(5)
    expect(result.params).toMatchObject({
      kind: 'atoken-liquidity',
      aToken: aTokenVenue.address,
      underlying: aTokenVenue.underlying,
      underlyingOnchain: aTokenVenue.underlying,
      underlyingDecimalsOnchain: 6,
      underlyingIdentity: 'match',
      decimalsIdentity: 'match',
      underlyingBalance: '5000000',
      decimals: 6,
      priceAssumptionUsd: 1,
      reads: {
        underlyingAsset: true,
        underlyingDecimals: true,
        underlyingBalance: true,
      },
    })
    expect(client.readContract.mock.calls.every(([call]) => call.blockNumber === blockNumber)).toBe(
      true,
    )
    expect(client.readContract.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            address: aTokenVenue.address,
            functionName: 'UNDERLYING_ASSET_ADDRESS',
          }),
        ],
        [
          expect.objectContaining({
            address: aTokenVenue.underlying,
            functionName: 'balanceOf',
            args: [aTokenVenue.address],
          }),
        ],
      ]),
    )
  })

  it('retains the raw cash observation while marking an on-chain address mismatch', async () => {
    const otherUnderlying = '0x0000000000000000000000000000000000000033'
    const result = await readVenueState(
      mockATokenClient({ underlyingOnchain: otherUnderlying }),
      aTokenVenue,
      blockNumber,
    )

    expect(result.instantUsd).toBe(5)
    expect(result.params.underlyingOnchain).toBe(otherUnderlying)
    expect(result.params.underlyingIdentity).toBe('mismatch')
    expect(result.params.reads.underlyingAsset).toBe(true)
  })

  it('marks failed or malformed identity reads unknown, never verified', async () => {
    for (const client of [
      mockATokenClient({ failIdentity: true }),
      mockATokenClient({ underlyingOnchain: 'invalid' }),
    ]) {
      const result = await readVenueState(client, aTokenVenue, blockNumber)
      expect(result.instantUsd).toBe(5)
      expect(result.params.underlyingIdentity).toBe('unknown')
    }
  })

  it('marks mismatched underlying decimals without changing the recorded cash units', async () => {
    const result = await readVenueState(
      mockATokenClient({ underlyingDecimals: 18n }),
      aTokenVenue,
      blockNumber,
    )
    expect(result.instantUsd).toBe(5)
    expect(result.params.underlyingDecimalsOnchain).toBe(18)
    expect(result.params.decimalsIdentity).toBe('mismatch')
  })
})
