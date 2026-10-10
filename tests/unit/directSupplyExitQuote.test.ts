import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionResult, encodeFunctionResult, getAddress, parseAbi } from 'viem'
import type { Address } from 'viem'

import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import {
  readDirectSupplyExitQuote,
  resolveDirectSupplyExitTarget,
  type DirectSupplyExitClient,
} from '@/lib/carry/directSupplyExitQuote'

const HOLDER = '0x0000000000000000000000000000000000000001' as Address
const DELEGATION_CODE = `0xef0100${'1'.repeat(40)}`
const BLOCK = {
  number: 26_080_000n,
  hash: `0x${'a'.repeat(64)}` as `0x${string}`,
  timestamp: 1_800_000_000n,
}
const HISTORICAL = {
  number: BLOCK.number - 1_000n,
  hash: `0x${'c'.repeat(64)}` as `0x${string}`,
  timestamp: BLOCK.timestamp - 4n * 60n * 60n,
}
const HISTORICAL_SELECTION = {
  mode: 'internal_historical_finalized_block' as const,
  blockNumber: HISTORICAL.number,
  blockHash: HISTORICAL.hash,
}
const NOW = Number(BLOCK.timestamp) * 1000 + 10_000
const subjects = Object.values(DIRECT_SUPPLY_MARKETS)
const input = (market: (typeof subjects)[number]) => ({
  routeKey: market.routeKey,
  destinationAddress: market.destination as Address,
  owner: HOLDER,
  assetsRaw: (10n ** BigInt(market.decimals)).toString(),
})

function mockClient(
  market: (typeof subjects)[number],
  options: {
    balance?: bigint
    revert?: boolean
    rpcError?: boolean
    contract?: boolean
    changedHash?: boolean
    historicalMismatch?: boolean
    wrongUnderlying?: boolean
    wrongReserve?: boolean
    returnAmount?: bigint
    chainId?: number
    staleCode?: boolean
    reserve?: Record<string, unknown>
    delegatedHolder?: boolean
  } = {},
) {
  const isCompound = market.routeKey.includes('Compound')
  const getBlock = vi.fn(async (query: { blockTag?: string; blockNumber?: bigint }) => {
    if (query.blockNumber === HISTORICAL.number)
      return options.historicalMismatch
        ? { ...HISTORICAL, hash: `0x${'d'.repeat(64)}` }
        : HISTORICAL
    return options.changedHash && !query.blockTag && getBlock.mock.calls.length === 3
      ? { ...BLOCK, hash: `0x${'b'.repeat(64)}` }
      : BLOCK
  })
  const readContract = vi.fn(async (args: { functionName: string }) => {
    switch (args.functionName) {
      case 'decimals':
        return BigInt(market.decimals)
      case 'balanceOf':
        return options.balance ?? 5n * 10n ** BigInt(market.decimals)
      case 'baseToken':
      case 'UNDERLYING_ASSET_ADDRESS':
        return options.wrongUnderlying ? HOLDER : market.underlying
      case 'getReserveData':
        return {
          ...options.reserve,
          aTokenAddress: options.wrongReserve ? HOLDER : market.destination,
        }
      default:
        throw new Error('unexpected read')
    }
  })
  const call = vi.fn(async () => {
    if (options.rpcError) throw new Error('secret RPC URL transport failed')
    if (options.revert)
      throw Object.assign(new Error('execution reverted'), {
        name: 'ContractFunctionRevertedError',
      })
    return {
      data: isCompound
        ? '0x'
        : `0x${(options.returnAmount ?? 10n ** BigInt(market.decimals)).toString(16).padStart(64, '0')}`,
    }
  })
  const client = {
    getChainId: vi.fn(async () => options.chainId ?? 1),
    getBlock,
    request: vi.fn(async () =>
      options.contract
        ? '0x6001'
        : options.staleCode
          ? undefined
          : options.delegatedHolder
            ? DELEGATION_CODE
            : '0x',
    ),
    readContract,
    call,
  } as unknown as DirectSupplyExitClient
  return { client, getBlock, readContract, call }
}

describe('direct supply holder exit quote', () => {
  it('simulates an exact EIP-7702 delegated EOA holder', async () => {
    const market = DIRECT_SUPPLY_MARKETS.sparkLendUsdt
    const quote = await readDirectSupplyExitQuote(
      mockClient(market, { delegatedHolder: true }).client,
      input(market),
      NOW,
    )
    expect(quote.simulation.status).toBe('success')
  })

  it('accepts only each exact route and destination pair', () => {
    for (const market of subjects) {
      expect(
        resolveDirectSupplyExitTarget(market.routeKey, market.destination as Address).underlying,
      ).toBe(market.underlying)
      expect(() => resolveDirectSupplyExitTarget(market.routeKey, HOLDER)).toThrow(
        'direct_supply_exit_target_unknown',
      )
    }
    expect(() =>
      resolveDirectSupplyExitTarget(subjects[0].routeKey, subjects[1].destination as Address),
    ).toThrow('direct_supply_exit_target_unknown')
  })

  it.each(subjects)('pins identity and exact-holder simulation for $routeKey', async (market) => {
    const { client, getBlock, readContract, call } = mockClient(market)
    const reading = await readDirectSupplyExitQuote(client, input(market), NOW)
    expect(reading.status).toBe('checked_at_finalized_block')
    expect(reading.owner).toBe(HOLDER.toLowerCase())
    expect(reading.simulation).toEqual({ status: 'success' })
    expect(reading.source).toMatchObject({ blockHash: BLOCK.hash, ageSeconds: 10 })
    expect(reading.forecast).toEqual({
      futureExit: 'unavailable',
      exitDuration: 'unavailable',
      prospectiveValidated: false,
    })
    expect(getBlock).toHaveBeenCalledTimes(3)
    expect(
      readContract.mock.calls.every(
        ([args]) =>
          (args as never as { blockHash: string; requireCanonical: boolean }).blockHash ===
            BLOCK.hash &&
          (args as never as { blockHash: string; requireCanonical: boolean }).requireCanonical ===
            true,
      ),
    ).toBe(true)
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        account: HOLDER,
        blockHash: BLOCK.hash,
        requireCanonical: true,
      }),
    )
  })

  it('returns the requested holder in normalized form', async () => {
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
    const owner = getAddress(`0x${'ab'.repeat(20)}`)
    const reading = await readDirectSupplyExitQuote(
      mockClient(market).client,
      { ...input(market), owner },
      NOW,
    )
    expect(reading.owner).toBe(owner.toLowerCase())
  })

  it('keeps Aave USDe separate from USDC with 18-decimal whole-asset Q and the exact Pool', async () => {
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usde
    const { client, readContract, call } = mockClient(market)
    const reading = await readDirectSupplyExitQuote(client, input(market), NOW)
    expect(reading.market).toMatchObject({
      address: market.destination,
      assetAddress: market.underlying,
      assetDecimals: 18,
      pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    })
    expect(reading.request.assetsRaw).toBe('1000000000000000000')
    expect(reading.simulation).toEqual({ status: 'success' })
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'getReserveData',
        args: [market.underlying],
      }),
    )
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        account: HOLDER,
        to: reading.market.pool,
      }),
    )
  })

  it('uses an internal historical finalized block for the same holder/Q', async () => {
    const market = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
    const { client, getBlock, readContract, call } = mockClient(market)
    const reading = await readDirectSupplyExitQuote(
      client,
      input(market),
      NOW,
      HISTORICAL_SELECTION,
    )
    expect(reading.source).toMatchObject({
      blockNumber: Number(HISTORICAL.number),
      blockHash: HISTORICAL.hash,
    })
    expect(reading.source.ageSeconds).toBeGreaterThan(60 * 60)
    expect(getBlock).toHaveBeenCalledTimes(4)
    expect(getBlock.mock.calls[0][0]).toEqual({ blockTag: 'finalized' })
    expect(getBlock.mock.calls[1][0]).toEqual({ blockNumber: HISTORICAL.number })
    expect(
      readContract.mock.calls.every(
        ([args]) =>
          (args as never as { blockHash: string; requireCanonical: boolean }).blockHash ===
            HISTORICAL.hash &&
          (args as never as { blockHash: string; requireCanonical: boolean }).requireCanonical ===
            true,
      ),
    ).toBe(true)
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'eth_getCode',
        params: [HOLDER, { blockHash: HISTORICAL.hash, requireCanonical: true }],
      }),
    )
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        account: HOLDER,
        blockHash: HISTORICAL.hash,
        requireCanonical: true,
      }),
    )
  })

  it('rejects historical hash disagreement and targets beyond finalized head', async () => {
    const market = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
    await expect(
      readDirectSupplyExitQuote(
        mockClient(market, { historicalMismatch: true }).client,
        input(market),
        NOW,
        HISTORICAL_SELECTION,
      ),
    ).rejects.toThrow('direct_supply_exit_block_hash_changed')
    await expect(
      readDirectSupplyExitQuote(mockClient(market).client, input(market), NOW, {
        ...HISTORICAL_SELECTION,
        blockNumber: BLOCK.number + 1n,
      }),
    ).rejects.toThrow('direct_supply_exit_historical_block_invalid')
    await expect(
      readDirectSupplyExitQuote(
        mockClient(market).client,
        input(market),
        NOW + 3 * 60 * 60 * 1000,
        HISTORICAL_SELECTION,
      ),
    ).rejects.toThrow('direct_supply_exit_finalized_block_unavailable')
  })

  it('does not classify a successful Comet borrow as a supplied-asset exit', async () => {
    const market = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
    const { client, call } = mockClient(market, { balance: 900_000n })
    const reading = await readDirectSupplyExitQuote(client, input(market), NOW)
    expect(call).toHaveBeenCalledTimes(1)
    expect(reading.status).toBe('checked_at_finalized_block')
    expect(reading.simulation).toEqual({
      status: 'not_holder_exit',
      reason: 'requested_amount_exceeds_holder_supply',
    })
  })

  it('distinguishes EVM revert from provider failure', async () => {
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
    const reverted = await readDirectSupplyExitQuote(
      mockClient(market, { revert: true }).client,
      input(market),
      NOW,
    )
    expect(reverted.simulation).toEqual({
      status: 'evm_revert',
      reason: 'unknown_execution_constraint',
    })
    await expect(
      readDirectSupplyExitQuote(mockClient(market, { rpcError: true }).client, input(market), NOW),
    ).rejects.toThrow('secret RPC URL')
  })

  it('fails closed for identity, incoherent return, contract holder, chain, block, and age', async () => {
    const market = DIRECT_SUPPLY_MARKETS.sparkLendUsdt
    for (const options of [
      { wrongUnderlying: true },
      { wrongReserve: true },
      { returnAmount: 999_999n },
      { contract: true },
      { staleCode: true },
      { chainId: 10 },
      { changedHash: true },
    ]) {
      await expect(
        readDirectSupplyExitQuote(mockClient(market, options).client, input(market), NOW),
      ).rejects.toThrow()
    }
    await expect(
      readDirectSupplyExitQuote(mockClient(market).client, input(market), NOW + 3 * 60 * 60 * 1000),
    ).rejects.toThrow('finalized_block_unavailable')
    const { client, call } = mockClient(market)
    await expect(
      readDirectSupplyExitQuote(client, { ...input(market), assetsRaw: '0' }, NOW),
    ).rejects.toThrow('request_invalid')
    expect(call).not.toHaveBeenCalled()
  })
})

describe('retained direct reserve getter facts', () => {
  it('preserves raw configuration and indexes at exact source despite requestedQ revert, with no extra getter', async () => {
    const market = DIRECT_SUPPLY_MARKETS.sparkLendUsdt
    const mocked = mockClient(market, {
      revert: true,
      reserve: {
        configuration: 123n,
        liquidityIndex: 456n,
        variableBorrowIndex: 789n,
        lastUpdateTimestamp: 1800000000n,
        unbacked: 9n,
      },
    })
    const result = await readDirectSupplyExitQuote(mocked.client, input(market), NOW)
    expect(result.simulation.status).toBe('evm_revert')
    expect(result.reserveFacts).toMatchObject({
      configurationRaw: '123',
      liquidityIndexRaw: '456',
      variableBorrowIndexRaw: '789',
      reserveLastUpdateTimestampRaw: '1800000000',
      unbackedRaw: '9',
      restrictionInterpretation: 'unverified',
      active: null,
      withdrawalsPaused: null,
      source: { blockNumber: Number(BLOCK.number), blockHash: BLOCK.hash, finalized: true },
    })
    expect(
      mocked.readContract.mock.calls.filter(([args]) => args.functionName === 'getReserveData'),
    ).toHaveLength(1)
  })
  it('missing or malformed optionalfields stay unknown rather than fabricated or coercivelyparsed', async () => {
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
    const mocked = mockClient(market, {
      reserve: {
        configuration: ['123'],
        liquidityIndex: 1n << 128n,
        variableBorrowIndex: '12',
        lastUpdateTimestamp: -1n,
      },
    })
    const result = await readDirectSupplyExitQuote(mocked.client, input(market), NOW)
    expect(result.simulation.status).toBe('success')
    expect(result.reserveFacts).toMatchObject({
      configurationRaw: null,
      liquidityIndexRaw: null,
      variableBorrowIndexRaw: null,
      reserveLastUpdateTimestampRaw: null,
      unbackedRaw: null,
      active: null,
      withdrawalsPaused: null,
    })
  })
  it('retains the installed ABI decoder uint40 primitive number without widening large getter fields', async () => {
    const abi = parseAbi(['function stamp() view returns (uint40)'])
    const stamp = decodeFunctionResult({
      abi,
      functionName: 'stamp',
      data: encodeFunctionResult({ abi, functionName: 'stamp', result: 1800000000 }),
    })
    expect(typeof stamp).toBe('number')
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
    const mocked = mockClient(market, {
      reserve: {
        lastUpdateTimestamp: stamp,
        configuration: 123,
        liquidityIndex: 456,
        variableBorrowIndex: 789,
        unbacked: 9,
      },
    })
    const result = await readDirectSupplyExitQuote(mocked.client, input(market), NOW)
    expect(result.reserveFacts).toMatchObject({
      reserveLastUpdateTimestampRaw: '1800000000',
      configurationRaw: null,
      liquidityIndexRaw: null,
      variableBorrowIndexRaw: null,
      unbackedRaw: null,
    })
    expect(
      mocked.readContract.mock.calls.filter(([args]) => args.functionName === 'getReserveData'),
    ).toHaveLength(1)
  })
  it('retains uint40 number boundaries and rejects malformed or overflowing small primitives', async () => {
    const market = DIRECT_SUPPLY_MARKETS.sparkLendUsdt
    for (const [value, expected] of [
      [0, '0'],
      [2 ** 40 - 1, String(2 ** 40 - 1)],
      [2 ** 40, null],
      [-1, null],
      [1.5, null],
      [Number.MAX_SAFE_INTEGER + 1, null],
      [NaN, null],
      [Infinity, null],
      ['1800000000', null],
      [[1800000000], null],
      [{ value: 1800000000 }, null],
    ] as const) {
      const mocked = mockClient(market, { reserve: { lastUpdateTimestamp: value } })
      const result = await readDirectSupplyExitQuote(mocked.client, input(market), NOW)
      expect(result.reserveFacts?.reserveLastUpdateTimestampRaw).toBe(expected)
    }
  })
  it('Compound remains explicitly outside the reserve getter family', async () => {
    const market = DIRECT_SUPPLY_MARKETS.compoundV3Usdc,
      mocked = mockClient(market)
    expect(
      (await readDirectSupplyExitQuote(mocked.client, input(market), NOW)).reserveFacts,
    ).toBeNull()
  })
})
