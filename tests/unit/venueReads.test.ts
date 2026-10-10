import { describe, expect, it, vi } from 'vitest'

import {
  aTokenSuppliedUsd,
  readDepthMarkets,
  readVenueState,
} from '../../scripts/lib/venue-reads.mjs'

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

function mockClient({
  failReserve = false,
  failDecimals = false,
  failCoins = false,
  changedCoins = false,
} = {}) {
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
      if (call.functionName === 'coins') {
        if (failCoins) throw new Error('coin identity RPC failed')
        if (changedCoins && call.args?.[0] === 0n)
          return '0x0000000000000000000000000000000000000099'
        return call.args?.[0] === 0n ? venue.depthMarkets[0].token0 : venue.depthMarkets[0].token1
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
      coin0Onchain: venue.depthMarkets[0].token0,
      coin1Onchain: venue.depthMarkets[0].token1,
      coinsIdentity: 'match',
      exitIdentity: 'match',
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

  it('fails closed when Curve coins changed or identity reads fail at the pinned block', async () => {
    for (const input of [{ changedCoins: true }, { failCoins: true }]) {
      const result = await readDepthMarkets(mockClient(input), venue, blockNumber)
      expect(result.depth_usd).toBeNull()
      expect(result.depth_complete).toBe(false)
      expect(result.depthMarkets[0].exitableUsd).toBeNull()
      expect(result.depthMarkets[0].coinsIdentity).toBe(input.changedCoins ? 'mismatch' : 'unknown')
    }
  })

  it('retains PSM buffer identity, precision, price assumption, and read status', async () => {
    const psmVenue = {
      underlying: '0x0000000000000000000000000000000000000044',
      depthMarkets: [
        {
          enabled: true,
          name: 'USDS to USDC',
          kind: 'psm-buffer',
          address: '0x0000000000000000000000000000000000000041',
          wrapper: '0x0000000000000000000000000000000000000045',
          buffer: '0x0000000000000000000000000000000000000042',
          bufferToken: '0x0000000000000000000000000000000000000043',
          exitFrom: '0x0000000000000000000000000000000000000044',
        },
      ],
    }
    const client = {
      readContract: vi.fn(
        async (call: { functionName: string; address: string; blockNumber: bigint }) => {
          if (call.address === psmVenue.depthMarkets[0].wrapper) {
            if (call.functionName === 'psm') return psmVenue.depthMarkets[0].address
            if (call.functionName === 'pocket') return psmVenue.depthMarkets[0].buffer
            if (call.functionName === 'usds') return psmVenue.underlying
          }
          if (call.functionName === 'pocket') return psmVenue.depthMarkets[0].buffer
          if (call.functionName === 'gem') return psmVenue.depthMarkets[0].bufferToken
          if (call.functionName === 'tout') return 0n
          if (call.functionName === 'decimals') return 6n
          if (call.functionName === 'balanceOf') return 8_000_000n
          throw new Error('unexpected call')
        },
      ),
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
      pocketIdentity: 'match',
      gemIdentity: 'match',
      exitIdentity: 'match',
      wrapperIdentity: 'match',
      wrapperPsmOnchain: psmVenue.depthMarkets[0].address,
      wrapperPocketOnchain: psmVenue.depthMarkets[0].buffer,
      wrapperUsdsOnchain: psmVenue.underlying,
      buyGemState: 'open',
      toutRaw: '0',
      reads: {
        wrapperPsm: true,
        wrapperPocket: true,
        wrapperUsds: true,
        pocket: true,
        gem: true,
        buffer: true,
        decimals: true,
      },
    })
    expect(client.readContract.mock.calls.every(([call]) => call.blockNumber === blockNumber)).toBe(
      true,
    )
    const changedPocket = {
      readContract: vi.fn(async (call: { functionName: string; address: string }) => {
        if (call.address === psmVenue.depthMarkets[0].wrapper) {
          if (call.functionName === 'psm') return psmVenue.depthMarkets[0].address
          if (call.functionName === 'pocket') return psmVenue.depthMarkets[0].buffer
          if (call.functionName === 'usds') return psmVenue.underlying
        }
        if (call.functionName === 'pocket') return '0x0000000000000000000000000000000000000099'
        if (call.functionName === 'gem') return psmVenue.depthMarkets[0].bufferToken
        if (call.functionName === 'tout') return 0n
        if (call.functionName === 'decimals') return 6n
        if (call.functionName === 'balanceOf') return 8_000_000n
        throw new Error('unexpected call')
      }),
    }
    const mismatch = await readDepthMarkets(changedPocket, psmVenue, blockNumber)
    expect(mismatch.depth_usd).toBeNull()
    expect(mismatch.depth_complete).toBe(false)
    expect(mismatch.depthMarkets[0].pocketIdentity).toBe('mismatch')

    const withoutWrapper = await readDepthMarkets(
      client,
      {
        ...psmVenue,
        depthMarkets: [{ ...psmVenue.depthMarkets[0], wrapper: undefined }],
      },
      blockNumber,
    )
    expect(withoutWrapper.depth_usd).toBeNull()
    expect(withoutWrapper.depthMarkets[0]).toMatchObject({
      wrapperIdentity: 'unknown',
      bufferBalanceRaw: '8000000',
      exitableUsd: null,
    })

    for (const changedFunction of ['psm', 'pocket', 'usds']) {
      const changedWrapper = {
        readContract: vi.fn(async (call: { functionName: string; address: string }) => {
          if (call.address === psmVenue.depthMarkets[0].wrapper) {
            if (call.functionName === changedFunction)
              return '0x0000000000000000000000000000000000000099'
            if (call.functionName === 'psm') return psmVenue.depthMarkets[0].address
            if (call.functionName === 'pocket') return psmVenue.depthMarkets[0].buffer
            if (call.functionName === 'usds') return psmVenue.underlying
          }
          if (call.functionName === 'pocket') return psmVenue.depthMarkets[0].buffer
          if (call.functionName === 'gem') return psmVenue.depthMarkets[0].bufferToken
          if (call.functionName === 'tout') return 0n
          if (call.functionName === 'decimals') return 6n
          if (call.functionName === 'balanceOf') return 8_000_000n
          throw new Error('unexpected call')
        }),
      }
      const rejected = await readDepthMarkets(changedWrapper, psmVenue, blockNumber)
      expect(rejected.depth_usd).toBeNull()
      expect(rejected.depth_complete).toBe(false)
      expect(rejected.depthMarkets[0].wrapperIdentity).toBe('mismatch')
      expect(rejected.depthMarkets[0].bufferBalanceRaw).toBe('8000000')
    }

    const haltedClient = {
      readContract: vi.fn(
        async (call: { functionName: string; address: string; blockNumber: bigint }) =>
          call.functionName === 'tout' ? 2n ** 256n - 1n : client.readContract(call),
      ),
    }
    const halted = await readDepthMarkets(haltedClient, psmVenue, blockNumber)
    expect(halted.depth_usd).toBe(0)
    expect(halted.depth_complete).toBe(true)
    expect(halted.depthMarkets[0]).toMatchObject({
      buyGemState: 'halted',
      bufferBalanceRaw: '8000000',
      exitableUsd: 0,
    })

    const unreadableTout = {
      readContract: vi.fn(
        async (call: { functionName: string; address: string; blockNumber: bigint }) => {
          if (call.functionName === 'tout') throw new Error('unavailable')
          return client.readContract(call)
        },
      ),
    }
    const unknownFee = await readDepthMarkets(unreadableTout, psmVenue, blockNumber)
    expect(unknownFee.depth_usd).toBeNull()
    expect(unknownFee.depthMarkets[0]).toMatchObject({
      buyGemState: 'unknown',
      bufferBalanceRaw: '8000000',
      exitableUsd: null,
    })
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
  failDecimals = false,
  failSupply = false,
  failBalance = false,
  balance = 5_000_000n,
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
      if (call.functionName === 'decimals') {
        if (failDecimals) throw new Error('decimals RPC failed')
        return underlyingDecimals
      }
      if (call.functionName === 'balanceOf') {
        if (failBalance) throw new Error('balance RPC failed')
        return balance
      }
      if (call.functionName === 'totalSupply') {
        if (failSupply) throw new Error('supply RPC failed')
        return 20_000_000n
      }
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
      totalSupply: '20000000',
      decimals: 6,
      priceAssumptionUsd: 1,
      reads: {
        underlyingAsset: true,
        underlyingDecimals: true,
        underlyingBalance: true,
        totalSupply: true,
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
    expect(aTokenSuppliedUsd(result.params)).toBe(20)
    expect(result.instantUsd).toBe(5)
  })

  it('leaves TVL unknown after a failed supply read, without substituting withdrawable cash', async () => {
    const result = await readVenueState(
      mockATokenClient({ failSupply: true }),
      aTokenVenue,
      blockNumber,
    )
    expect(result.instantUsd).toBe(5)
    expect(result.params.totalSupply).toBeNull()
    expect(result.params.reads.totalSupply).toBe(false)
    expect(aTokenSuppliedUsd(result.params)).toBeNull()
  })

  it('retains supplied stock when the separate immediate-cash read fails', async () => {
    const result = await readVenueState(
      mockATokenClient({ failBalance: true }),
      aTokenVenue,
      blockNumber,
    )
    expect(result.instantUsd).toBeNull()
    expect(result.params.reads.underlyingBalance).toBe(false)
    expect(aTokenSuppliedUsd(result.params)).toBe(20)
  })

  it('does not publish old, mismatched, malformed, or unpriced supply as USD TVL', async () => {
    expect(aTokenSuppliedUsd({ totalSupply: '20000000', decimals: 6 })).toBeNull()
    const result = await readVenueState(
      mockATokenClient({ underlyingOnchain: '0x0000000000000000000000000000000000000033' }),
      aTokenVenue,
      blockNumber,
    )
    expect(result.params.totalSupply).toBe('20000000')
    expect(aTokenSuppliedUsd(result.params)).toBeNull()
    expect(
      aTokenSuppliedUsd({ ...result.params, underlyingIdentity: 'match', totalSupply: '-1' }),
    ).toBeNull()
    expect(
      aTokenSuppliedUsd({
        ...result.params,
        underlyingIdentity: 'match',
        priceAssumptionUsd: null,
      }),
    ).toBeNull()
  })

  it('retains the raw cash observation while marking an on-chain address mismatch', async () => {
    const otherUnderlying = '0x0000000000000000000000000000000000000033'
    const result = await readVenueState(
      mockATokenClient({ underlyingOnchain: otherUnderlying }),
      aTokenVenue,
      blockNumber,
    )

    expect(result.instantUsd).toBeNull()
    expect(result.params.underlyingBalance).toBe('5000000')
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
      expect(result.instantUsd).toBeNull()
      expect(result.params.underlyingIdentity).toBe('unknown')
    }
  })

  it('marks mismatched underlying decimals without changing the recorded cash units', async () => {
    const result = await readVenueState(
      mockATokenClient({ underlyingDecimals: 18n }),
      aTokenVenue,
      blockNumber,
    )
    expect(result.instantUsd).toBeNull()
    expect(result.params.underlyingDecimalsOnchain).toBe(18)
    expect(result.params.decimalsIdentity).toBe('mismatch')
  })

  it('retains raw cash but leaves USD capacity unknown when decimals cannot be verified', async () => {
    const result = await readVenueState(
      mockATokenClient({ failDecimals: true }),
      aTokenVenue,
      blockNumber,
    )
    expect(result.instantUsd).toBeNull()
    expect(result.params.underlyingBalance).toBe('5000000')
    expect(result.params.decimalsIdentity).toBe('unknown')
  })

  it('rejects a negative or nonfinite scaled balance as USD capacity', async () => {
    for (const balance of [-1n, 2n ** 2048n]) {
      const result = await readVenueState(mockATokenClient({ balance }), aTokenVenue, blockNumber)
      expect(result.instantUsd).toBeNull()
    }
  })
})

const vaultCashVenue = {
  kind: 'erc4626-vault-cash',
  address: '0x0000000000000000000000000000000000000031',
  underlying: '0x0000000000000000000000000000000000000032',
  decimals: 18,
}

function mockVaultCashClient({
  asset = vaultCashVenue.underlying,
  decimals = 18n,
  paused = false,
  cash = 5n * 10n ** 18n,
  fail = '',
} = {}) {
  return {
    readContract: vi.fn(
      async (call: { address: string; functionName: string; blockNumber?: bigint }) => {
        if (call.functionName === fail) throw new Error('RPC read failed')
        if (call.functionName === 'asset') return asset
        if (call.functionName === 'decimals') return decimals
        if (call.functionName === 'totalAssets') return 100n * 10n ** 18n
        if (call.functionName === 'totalSupply') return 90n * 10n ** 18n
        if (call.functionName === 'paused') return paused
        if (call.functionName === 'balanceOf') {
          if (call.address !== vaultCashVenue.underlying) throw new Error('wrong cash token')
          return cash
        }
        throw new Error('unexpected read')
      },
    ),
  }
}

describe('recorded ERC-4626 vault cash', () => {
  it('pins each read and publishes verified GHO cash with explicit price and limits', async () => {
    const client = mockVaultCashClient()
    const result = await readVenueState(client, vaultCashVenue, blockNumber)
    expect(result.instantUsd).toBe(5)
    expect(result.params).toMatchObject({
      kind: 'erc4626-vault-cash',
      underlyingOnchain: vaultCashVenue.underlying,
      underlyingIdentity: 'match',
      decimalsIdentity: 'match',
      totalAssets: (100n * 10n ** 18n).toString(),
      totalSupply: (90n * 10n ** 18n).toString(),
      underlyingBalance: (5n * 10n ** 18n).toString(),
      withdrawalsPaused: false,
      priceAssumptionUsd: 1,
      reads: {
        asset: true,
        underlyingDecimals: true,
        vaultDecimals: true,
        totalAssets: true,
        totalSupply: true,
        paused: true,
        underlyingBalance: true,
      },
    })
    expect(client.readContract.mock.calls.every(([call]) => call.blockNumber === blockNumber)).toBe(
      true,
    )
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: vaultCashVenue.underlying,
        functionName: 'balanceOf',
        args: [vaultCashVenue.address],
      }),
    )
    expect(result.params.instant_note).toContain('upper bound')
  })

  it('retains raw cash but reports zero effective capacity when paused', async () => {
    const result = await readVenueState(
      mockVaultCashClient({ paused: true }),
      vaultCashVenue,
      blockNumber,
    )
    expect(result.params.underlyingBalance).toBe((5n * 10n ** 18n).toString())
    expect(result.params.withdrawalsPaused).toBe(true)
    expect(result.instantUsd).toBe(0)
  })

  it('abstains on identity mismatch, precision mismatch, missing pause, or missing cash', async () => {
    for (const options of [
      { asset: '0x0000000000000000000000000000000000000033' },
      { decimals: 6n },
      { fail: 'paused' },
      { fail: 'balanceOf' },
    ]) {
      const result = await readVenueState(mockVaultCashClient(options), vaultCashVenue, blockNumber)
      expect(result.instantUsd).toBeNull()
    }
  })
})
