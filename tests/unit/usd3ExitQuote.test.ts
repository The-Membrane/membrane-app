import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, keccak256, parseAbi, type Address } from 'viem'

import {
  readUsd3ExitQuote,
  resolveUsd3ExitTarget,
  USD3_ROUTE_KEY,
  USD3_VAULT,
  USD3_IMPLEMENTATION,
  USDC_ASSET,
  USD3_TOKENIZED_STRATEGY,
  type Usd3ExitClient,
} from '@/lib/carry/usd3ExitQuote'

const HOLDER = '0x0000000000000000000000000000000000000001' as Address
const DELEGATED_EOA_CODE = `0xef0100${'2'.repeat(40)}`
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
const AMOUNT = 1_000_000n
const IMPLEMENTATION_SLOT = `0x${'0'.repeat(24)}${USD3_IMPLEMENTATION.slice(2)}` as `0x${string}`
const withdrawAbi = parseAbi([
  'function withdraw(uint256 assets,address receiver,address owner) returns (uint256)',
])
const nativeAbi = parseAbi([
  'function availableWithdrawLimit(address) view returns (uint256)',
  'function isShutdown() view returns (bool)',
])
const input = () => ({
  routeKey: USD3_ROUTE_KEY,
  destinationAddress: USD3_VAULT,
  owner: HOLDER,
  assetsRaw: AMOUNT.toString(),
})

function mockClient(
  options: {
    balance?: bigint
    preview?: bigint
    maxWithdraw?: bigint
    revert?: boolean
    rpcError?: boolean
    contract?: boolean
    holderCode?: unknown
    changedHash?: boolean
    historicalMismatch?: boolean
    wrongAsset?: boolean
    wrongImplementation?: boolean
    returnedShares?: bigint
    chainId?: number
    entitlement?: bigint
    nativeWord?: unknown
    nativeRevert?: boolean
    shutdownWord?: unknown
    shutdownRevert?: boolean
    delegate?: string
    runtimeCode?: { address: string; code: string | undefined }
    wrongDecimals?: boolean
    onPreviewRedeem?: () => void | Promise<void>
  } = {},
) {
  const getBlock = vi.fn(async (query: { blockTag?: string; blockNumber?: bigint }) => {
    if (query.blockNumber === HISTORICAL.number)
      return options.historicalMismatch
        ? { ...HISTORICAL, hash: `0x${'d'.repeat(64)}` }
        : HISTORICAL
    return options.changedHash && !query.blockTag && getBlock.mock.calls.length === 3
      ? { ...BLOCK, hash: `0x${'b'.repeat(64)}` }
      : BLOCK
  })
  const readContract = vi.fn(async (args: { functionName: string; address: string }) => {
    switch (args.functionName) {
      case 'asset':
        return options.wrongAsset ? HOLDER : USDC_ASSET
      case 'decimals':
        return options.wrongDecimals ? 18n : 6n
      case 'balanceOf':
        return options.balance ?? 2n * AMOUNT
      case 'maxWithdraw':
        return options.maxWithdraw ?? 2n * AMOUNT
      case 'previewWithdraw':
        return options.preview ?? AMOUNT
      case 'previewRedeem':
        if (options.onPreviewRedeem) await options.onPreviewRedeem()
        return options.entitlement ?? 10n * AMOUNT
      case 'tokenizedStrategyAddress':
        return options.delegate ?? USD3_TOKENIZED_STRATEGY
      default:
        throw new Error(`unexpected ${args.functionName}`)
    }
  })
  const call = vi.fn(async (_args: { data: `0x${string}` }) => {
    if (options.rpcError) throw new Error('secret RPC URL transport failed')
    if (options.revert) {
      throw Object.assign(new Error('execution reverted'), {
        name: 'ContractFunctionRevertedError',
      })
    }
    return { data: `0x${(options.returnedShares ?? AMOUNT).toString(16).padStart(64, '0')}` }
  })
  const client = {
    getChainId: vi.fn(async () => options.chainId ?? 1),
    getBlock,
    getCode: vi.fn(async (query: { address: Address }) =>
      query.address.toLowerCase() === options.runtimeCode?.address
        ? options.runtimeCode.code
        : [USD3_VAULT, USD3_IMPLEMENTATION, USD3_TOKENIZED_STRATEGY, USDC_ASSET].includes(
              query.address.toLowerCase() as Address,
            )
          ? '0x6001'
          : undefined,
    ),
    request: vi.fn(async (query: { method: string; params?: unknown[] }) => {
      if (query.method === 'eth_call') {
        const tx = query.params![0] as { data: `0x${string}` }
        if (decodeFunctionData({ abi: nativeAbi, data: tx.data }).functionName === 'isShutdown') {
          if (options.shutdownRevert) throw new Error('execution reverted')
          return Object.hasOwn(options, 'shutdownWord')
            ? options.shutdownWord
            : `0x${'0'.repeat(64)}`
        }
        if (options.nativeRevert)
          throw Object.assign(new Error('execution reverted'), {
            name: 'ContractFunctionRevertedError',
          })
        return 'nativeWord' in options
          ? options.nativeWord
          : `0x${(99n * AMOUNT).toString(16).padStart(64, '0')}`
      }
      return 'holderCode' in options ? options.holderCode : options.contract ? '0x6002' : '0x'
    }),
    getStorageAt: vi.fn(async () =>
      options.wrongImplementation
        ? (`0x${'0'.repeat(24)}${HOLDER.slice(2)}` as `0x${string}`)
        : IMPLEMENTATION_SLOT,
    ),
    readContract,
    call,
  } as unknown as Usd3ExitClient
  return { client, getBlock, readContract, call }
}

describe('USD3 exact-holder exit quote', () => {
  it('accepts only the pinned route and vault', () => {
    expect(resolveUsd3ExitTarget(USD3_ROUTE_KEY, USD3_VAULT)).toMatchObject({
      asset: USDC_ASSET,
      implementation: USD3_IMPLEMENTATION,
      assetDecimals: 6,
      shareDecimals: 6,
    })
    expect(() => resolveUsd3ExitTarget('USDS → other', USD3_VAULT)).toThrow('target_unknown')
    expect(() => resolveUsd3ExitTarget(USD3_ROUTE_KEY, HOLDER)).toThrow('target_unknown')
    expect(() => resolveUsd3ExitTarget('USDC → VaultV2 [USDC]', USD3_VAULT)).toThrow(
      'target_unknown',
    )
  })

  it('pins every read and simulates exact amount as holder', async () => {
    const { client, getBlock, readContract, call } = mockClient()
    const reading = await readUsd3ExitQuote(client, input(), NOW)
    expect(reading.status).toBe('checked_at_finalized_block')
    expect(reading.simulation).toEqual({ status: 'success', sharesBurnedRaw: AMOUNT.toString() })
    expect(reading.forecast).toEqual({
      futureExit: 'unavailable',
      exitDuration: 'unavailable',
      prospectiveValidated: false,
    })
    expect(reading.source).toMatchObject({ blockHash: BLOCK.hash, ageSeconds: 10 })
    expect(reading.request.assets).toBe('1')
    expect(reading.vault).toMatchObject({
      identity: 'pinned_vault_asset_and_implementation',
      implementation: USD3_IMPLEMENTATION,
    })
    expect(getBlock).toHaveBeenCalledTimes(3)
    expect(client.request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [HOLDER, { blockHash: BLOCK.hash, requireCanonical: true }],
    })
    expect(client.getStorageAt).toHaveBeenCalledWith(
      expect.objectContaining({
        address: USD3_VAULT,
        blockHash: BLOCK.hash,
        requireCanonical: true,
      }),
    )
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
        to: USD3_VAULT,
        blockHash: BLOCK.hash,
        requireCanonical: true,
      }),
    )
    const callData = call.mock.calls[0][0].data
    expect(decodeFunctionData({ abi: withdrawAbi, data: callData })).toEqual({
      functionName: 'withdraw',
      args: [AMOUNT, HOLDER, HOLDER],
    })
    expect(JSON.stringify(reading)).not.toContain(HOLDER)
    expect(reading.usd3NativeCapacity).toBeUndefined()
    expect(readContract).toHaveBeenCalledTimes(6)
    expect(client.getCode).toHaveBeenCalledTimes(2)
    expect(client.request).toHaveBeenCalledTimes(1)
  })

  it('records separate native C, full holder shares, entitlement and Q at the exact hash', async () => {
    const { client, readContract } = mockClient({ balance: 9876543210n, maxWithdraw: 9n * AMOUNT })
    const reading = await readUsd3ExitQuote(client, input(), NOW, undefined, {
      includeCapacityFacts: true,
    })
    expect(reading.position).toMatchObject({
      balanceSharesRaw: '9876543210',
      entitlementAssetsRaw: '10000000',
      maxWithdrawAssetsRaw: '9000000',
      previewSharesRaw: '1000000',
    })
    const fact = reading.usd3NativeCapacity!
    expect(fact).toMatchObject({
      owner: HOLDER,
      method: 'availableWithdrawLimit(address)',
      capacityRaw: '99000000',
      asset: USDC_ASSET,
      assetDecimals: 6,
      unit: 'raw_usdc_6',
      resultStatus: 'quoted',
      source: { blockHash: BLOCK.hash, blockNumber: Number(BLOCK.number), finalized: true },
    })
    expect(fact.runtimeProfile).toEqual({
      sourceClass: 'pinned_usd3_native_runtime',
      shareDecimals: 6,
      contracts: [USD3_VAULT, USD3_IMPLEMENTATION, USD3_TOKENIZED_STRATEGY, USDC_ASSET].map(
        (address) => ({ address, code: '0x6001', keccak256: keccak256('0x6001') }),
      ),
    })
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'previewRedeem',
        args: [9876543210n],
        blockHash: BLOCK.hash,
        requireCanonical: true,
      }),
    )
    const native = vi
      .mocked(client.request)
      .mock.calls.find(([p]) => p.method === 'eth_call')![0] as any
    expect(native.params[1]).toEqual({ blockHash: BLOCK.hash, requireCanonical: true })
    expect(native.params[0].to).toBe(USD3_VAULT)
    expect(decodeFunctionData({ abi: nativeAbi, data: native.params[0].data })).toEqual({
      functionName: 'availableWithdrawLimit',
      args: [HOLDER],
    })
    for (const address of [USD3_TOKENIZED_STRATEGY, USDC_ASSET])
      expect(client.getCode).toHaveBeenCalledWith({
        address,
        blockHash: BLOCK.hash,
        requireCanonical: true,
      })
    expect(reading.forecast.prospectiveValidated).toBe(false)
  })

  it('binds full S, native C and simulation to the original owner/Q across awaited caller mutation', async () => {
    const request = input()
    const other = '0x0000000000000000000000000000000000000002' as Address
    const { client, readContract, call } = mockClient({
      balance: 9876543210n,
      onPreviewRedeem: async () => {
        await Promise.resolve()
        request.owner = other
        request.assetsRaw = '999999'
        request.routeKey = 'mutated route'
        request.destinationAddress = other
      },
    })
    const reading = await readUsd3ExitQuote(client, request, NOW, undefined, {
      includeCapacityFacts: true,
    })
    expect(request.owner).toBe(other)
    expect(reading.routeKey).toBe(USD3_ROUTE_KEY)
    expect(reading.vault.address).toBe(USD3_VAULT)
    expect(reading.request.assetsRaw).toBe(AMOUNT.toString())
    expect(reading.position.balanceSharesRaw).toBe('9876543210')
    expect(reading.usd3NativeCapacity?.owner).toBe(HOLDER)
    for (const functionName of ['balanceOf', 'maxWithdraw'])
      expect(readContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName, args: [HOLDER] }),
      )
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'previewWithdraw',
        args: [AMOUNT],
      }),
    )
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'previewRedeem',
        args: [9876543210n],
      }),
    )
    const native = vi
      .mocked(client.request)
      .mock.calls.find(([p]) => p.method === 'eth_call')![0] as any
    expect(decodeFunctionData({ abi: nativeAbi, data: native.params[0].data }).args).toEqual([
      HOLDER,
    ])
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ account: HOLDER, to: USD3_VAULT }))
    expect(decodeFunctionData({ abi: withdrawAbi, data: call.mock.calls[0][0].data }).args).toEqual(
      [AMOUNT, HOLDER, HOLDER],
    )
  })

  it('captures the historical pin and capacity flag before the first await and retains clock function semantics', async () => {
    const selected = { ...HISTORICAL_SELECTION }
    const capacity = { includeCapacityFacts: true } as { includeCapacityFacts: true }
    const { client, getBlock } = mockClient()
    vi.mocked(client.getChainId).mockImplementationOnce(async () => {
      await Promise.resolve()
      selected.blockNumber = BLOCK.number + 1n
      selected.blockHash = `0x${'f'.repeat(64)}`
      capacity.includeCapacityFacts = false as unknown as true
      return 1
    })
    const clock = vi
      .fn()
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW + 1000)
    const reading = await readUsd3ExitQuote(client, input(), clock, selected, capacity)
    expect(getBlock).toHaveBeenCalledWith({ blockNumber: HISTORICAL.number })
    expect(reading.source.blockHash).toBe(HISTORICAL.hash)
    expect(reading.usd3NativeCapacity?.source.blockHash).toBe(HISTORICAL.hash)
    expect(reading.usd3NativeCapacity?.capacityRaw).toBe('99000000')
    expect(reading.source.observedAt).toBe(new Date(NOW + 1000).toISOString())
    expect(reading.usd3NativeCapacity?.readAtUtc).toBe(reading.source.observedAt)
    expect(clock).toHaveBeenCalledTimes(2)
  })

  it.each(['owner', 'assetsRaw', 'routeKey', 'destinationAddress'] as const)(
    'rejects accessor request %s before any RPC without invoking the getter',
    async (key) => {
      const request = input()
      const getter = vi.fn(() => request[key])
      Object.defineProperty(request, key, { get: getter })
      const { client } = mockClient()
      await expect(
        readUsd3ExitQuote(client, request, NOW, undefined, { includeCapacityFacts: true }),
      ).rejects.toThrow('usd3_exit_request_invalid')
      expect(getter).not.toHaveBeenCalled()
      expect(client.getChainId).not.toHaveBeenCalled()
    },
  )

  it.each(['mode', 'blockNumber', 'blockHash'] as const)(
    'rejects accessor source pin %s before any RPC without invoking the getter',
    async (key) => {
      const selected = { ...HISTORICAL_SELECTION }
      const getter = vi.fn(() => selected[key])
      Object.defineProperty(selected, key, { get: getter })
      const { client } = mockClient()
      await expect(
        readUsd3ExitQuote(client, input(), NOW, selected, { includeCapacityFacts: true }),
      ).rejects.toThrow('usd3_exit_historical_block_invalid')
      expect(getter).not.toHaveBeenCalled()
      expect(client.getChainId).not.toHaveBeenCalled()
    },
  )

  it('rejects accessor capacity flags and nonprimitive request addresses without evaluating them', async () => {
    const getter = vi.fn(() => true)
    const capacity = Object.defineProperty({}, 'includeCapacityFacts', { get: getter })
    const { client } = mockClient()
    await expect(
      readUsd3ExitQuote(client, input(), NOW, undefined, capacity as never),
    ).rejects.toThrow('usd3_exit_capacity_options_invalid')
    expect(getter).not.toHaveBeenCalled()
    const stringify = vi.fn(() => HOLDER)
    for (const key of ['owner', 'destinationAddress'])
      await expect(
        readUsd3ExitQuote(client, { ...input(), [key]: { toString: stringify } } as never, NOW),
      ).rejects.toThrow('usd3_exit_request_invalid')
    expect(stringify).not.toHaveBeenCalled()
    expect(client.getChainId).not.toHaveBeenCalled()
  })

  it('retains canonical native zero independently of a successful withdrawal', async () => {
    const reading = await readUsd3ExitQuote(
      mockClient({ nativeWord: `0x${'0'.repeat(64)}` }).client,
      input(),
      NOW,
      undefined,
      { includeCapacityFacts: true },
    )
    expect(reading.usd3NativeCapacity).toMatchObject({ capacityRaw: '0', resultStatus: 'quoted' })
    expect(reading.simulation.status).toBe('success')
  })

  it('stores the original completed read clock after the final source confirmation', async () => {
    const { client, getBlock } = mockClient()
    const completed = NOW + 2345
    const clock = vi
      .fn()
      .mockImplementationOnce(() => NOW)
      .mockImplementationOnce(() => {
        expect(getBlock).toHaveBeenCalledTimes(3)
        return completed
      })
    const reading = await readUsd3ExitQuote(client, input(), clock, undefined, {
      includeCapacityFacts: true,
    })
    expect(reading.usd3NativeCapacity?.readAtUtc).toBe(new Date(completed).toISOString())
    expect(reading.usd3NativeCapacity?.readAtUtc).toBe(reading.source.observedAt)
    expect(clock).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'reads the exact optional shutdown ABI bool %s at the source hash',
    async (shutdown) => {
      const { client } = mockClient({ shutdownWord: `0x${'0'.repeat(63)}${shutdown ? '1' : '0'}` })
      const reading = await readUsd3ExitQuote(client, input(), NOW, undefined, {
        includeCapacityFacts: true,
      })
      expect(reading.usd3NativeCapacity).toMatchObject({
        shutdown,
        capacityRaw: '99000000',
        resultStatus: 'quoted',
      })
      const shutdownCall = vi
        .mocked(client.request)
        .mock.calls.find(
          ([p]) =>
            p.method === 'eth_call' &&
            decodeFunctionData({ abi: nativeAbi, data: (p as any).params[0].data }).functionName ===
              'isShutdown',
        )![0] as any
      expect(shutdownCall.params[0].to).toBe(USD3_VAULT)
      expect(shutdownCall.params[1]).toEqual({ blockHash: BLOCK.hash, requireCanonical: true })
      expect(
        decodeFunctionData({ abi: nativeAbi, data: shutdownCall.params[0].data }).args,
      ).toBeUndefined()
      expect(reading.simulation.status).toBe('success')
      expect(reading.position.entitlementAssetsRaw).toBe('10000000')
    },
  )

  it.each([
    undefined,
    null,
    false,
    0n,
    '0x',
    '0x00',
    `0x${'0'.repeat(63)}2`,
    `0x${'0'.repeat(65)}`,
    `0x${'g'.repeat(64)}`,
  ])(
    'retains null for missing or malformed shutdown words %s without inventing false',
    async (shutdownWord) => {
      const reading = await readUsd3ExitQuote(
        mockClient({ shutdownWord }).client,
        input(),
        NOW,
        undefined,
        { includeCapacityFacts: true },
      )
      expect(Object.hasOwn(reading.usd3NativeCapacity!, 'shutdown')).toBe(true)
      expect(reading.usd3NativeCapacity?.shutdown).toBeNull()
      expect(reading.usd3NativeCapacity?.capacityRaw).toBe('99000000')
      expect(reading.position.entitlementAssetsRaw).toBe('10000000')
      expect(reading.simulation.status).toBe('success')
    },
  )

  it('retains null on an unsupported shutdown getter with independent withdrawal evidence', async () => {
    const reading = await readUsd3ExitQuote(
      mockClient({ shutdownRevert: true }).client,
      input(),
      NOW,
      undefined,
      { includeCapacityFacts: true },
    )
    expect(reading.usd3NativeCapacity?.shutdown).toBeNull()
    expect(reading.usd3NativeCapacity?.capacityRaw).toBe('99000000')
    expect(reading.position.entitlementAssetsRaw).toBe('10000000')
    expect(reading.simulation.status).toBe('success')
  })

  it.each([
    undefined,
    null,
    '0x',
    '0x01',
    `0x${'0'.repeat(63)}`,
    `0x1${'0'.repeat(64)}`,
    `0x${'g'.repeat(64)}`,
    1n,
  ])(
    'censors malformed or overflowing native ABI words %s without inventing zero',
    async (nativeWord) => {
      const reading = await readUsd3ExitQuote(
        mockClient({ nativeWord }).client,
        input(),
        NOW,
        undefined,
        { includeCapacityFacts: true },
      )
      expect(reading.usd3NativeCapacity).toMatchObject({
        capacityRaw: null,
        resultStatus: 'unavailable',
      })
      expect(reading.simulation.status).toBe('success')
      expect(reading.position.entitlementAssetsRaw).toBe('10000000')
    },
  )

  it('censors an unsupported native getter and retains the default withdrawal evidence', async () => {
    const reading = await readUsd3ExitQuote(
      mockClient({ nativeRevert: true }).client,
      input(),
      NOW,
      undefined,
      { includeCapacityFacts: true },
    )
    expect(reading.usd3NativeCapacity).toMatchObject({
      capacityRaw: null,
      resultStatus: 'unsupported',
    })
    expect(reading.simulation.status).toBe('success')
  })

  it.each([USD3_VAULT, USD3_IMPLEMENTATION, USD3_TOKENIZED_STRATEGY, USDC_ASSET])(
    'does not qualify malformed runtime bytes at %s',
    async (address) => {
      const reading = await readUsd3ExitQuote(
        mockClient({ runtimeCode: { address, code: '0x600' } }).client,
        input(),
        NOW,
        undefined,
        { includeCapacityFacts: true },
      )
      expect(reading.usd3NativeCapacity).toMatchObject({
        capacityRaw: '99000000',
        runtimeProfile: null,
      })
      expect(reading.simulation.status).toBe('success')
    },
  )
  it.each([
    ['missing', undefined],
    ['empty', '0x'],
    ['nonhex', '0x6G'],
    ['uppercase', '0x60AA'],
    ['oversized', `0x${'60'.repeat(32768)}`],
  ] as const)('does not qualify %s asset runtime', async (_name, code) => {
    const reading = await readUsd3ExitQuote(
      mockClient({ runtimeCode: { address: USDC_ASSET, code } }).client,
      input(),
      NOW,
      undefined,
      { includeCapacityFacts: true },
    )
    expect(reading.usd3NativeCapacity?.runtimeProfile).toBeNull()
    expect(reading.simulation.status).toBe('success')
  })
  it('censors an unpinned delegate and rejects changed required asset/share decimals', async () => {
    const reading = await readUsd3ExitQuote(
      mockClient({ delegate: HOLDER }).client,
      input(),
      NOW,
      undefined,
      { includeCapacityFacts: true },
    )
    expect(reading.usd3NativeCapacity?.runtimeProfile).toBeNull()
    expect(reading.simulation.status).toBe('success')
    await expect(
      readUsd3ExitQuote(mockClient({ wrongDecimals: true }).client, input(), NOW, undefined, {
        includeCapacityFacts: true,
      }),
    ).rejects.toThrow('identity_or_position_invalid')
  })

  it('uses an internal canonical historical block with pinned implementation and holder', async () => {
    const { client, getBlock, readContract, call } = mockClient()
    const reading = await readUsd3ExitQuote(client, input(), NOW, HISTORICAL_SELECTION)
    expect(reading.source).toMatchObject({
      blockNumber: Number(HISTORICAL.number),
      blockHash: HISTORICAL.hash,
    })
    expect(reading.source.ageSeconds).toBeGreaterThan(60 * 60)
    expect(getBlock).toHaveBeenCalledTimes(4)
    expect(getBlock.mock.calls[0][0]).toEqual({ blockTag: 'finalized' })
    expect(getBlock.mock.calls[1][0]).toEqual({ blockNumber: HISTORICAL.number })
    expect(client.getStorageAt).toHaveBeenCalledWith(
      expect.objectContaining({
        address: USD3_VAULT,
        blockHash: HISTORICAL.hash,
        requireCanonical: true,
      }),
    )
    expect(
      readContract.mock.calls.every(
        ([args]) =>
          (args as never as { blockHash: string; requireCanonical: boolean }).blockHash ===
            HISTORICAL.hash &&
          (args as never as { blockHash: string; requireCanonical: boolean }).requireCanonical ===
            true,
      ),
    ).toBe(true)
    expect(client.request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [HOLDER, { blockHash: HISTORICAL.hash, requireCanonical: true }],
    })
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        account: HOLDER,
        blockHash: HISTORICAL.hash,
        requireCanonical: true,
      }),
    )
  })

  it('rejects noncanonical and unfinalized historical blocks', async () => {
    await expect(
      readUsd3ExitQuote(
        mockClient({ historicalMismatch: true }).client,
        input(),
        NOW,
        HISTORICAL_SELECTION,
      ),
    ).rejects.toThrow('usd3_exit_block_hash_changed')
    await expect(
      readUsd3ExitQuote(mockClient().client, input(), NOW, {
        ...HISTORICAL_SELECTION,
        blockNumber: BLOCK.number + 1n,
      }),
    ).rejects.toThrow('usd3_exit_historical_block_invalid')
    await expect(
      readUsd3ExitQuote(
        mockClient().client,
        input(),
        NOW + 2 * 60 * 60 * 1000,
        HISTORICAL_SELECTION,
      ),
    ).rejects.toThrow('usd3_exit_finalized_block_unavailable')
  })

  it('reports insufficient holder shares separately from an EVM revert', async () => {
    const insufficient = await readUsd3ExitQuote(
      mockClient({ balance: 0n, revert: true }).client,
      input(),
      NOW,
    )
    expect(insufficient.simulation).toEqual({
      status: 'position_insufficient',
      reason: 'requested_amount_exceeds_holder_shares',
    })
    const reverted = await readUsd3ExitQuote(mockClient({ revert: true }).client, input(), NOW)
    expect(reverted.simulation).toEqual({
      status: 'evm_revert',
      reason: 'unknown_execution_constraint',
    })
    await expect(
      readUsd3ExitQuote(mockClient({ rpcError: true }).client, input(), NOW),
    ).rejects.toThrow('secret RPC URL')
  })

  it('keeps a successful exact withdrawal when the preview overestimates burned shares', async () => {
    const reading = await readUsd3ExitQuote(
      mockClient({ balance: 99n, preview: 100n, returnedShares: 99n }).client,
      input(),
      NOW,
    )
    expect(reading.simulation).toEqual({ status: 'success', sharesBurnedRaw: '99' })
  })

  it('simulates an exact EIP-7702 delegated EOA without claiming a future payout', async () => {
    const { client, call } = mockClient({ holderCode: DELEGATED_EOA_CODE })
    const reading = await readUsd3ExitQuote(client, input(), NOW)
    expect(reading.simulation.status).toBe('success')
    expect(reading.forecast.futureExit).toBe('unavailable')
    expect(call).toHaveBeenCalledOnce()
  })

  it('rejects missing raw holder code before simulation', async () => {
    const { client, call } = mockClient({ holderCode: undefined })
    await expect(readUsd3ExitQuote(client, input(), NOW)).rejects.toThrow(
      'usd3_exit_contract_holder_unavailable',
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('fails closed for identity, holder, return, chain, block and freshness errors', async () => {
    for (const options of [
      { wrongAsset: true },
      { wrongImplementation: true },
      { contract: true },
      { returnedShares: 0n },
      { returnedShares: 3n * AMOUNT },
      { chainId: 10 },
      { changedHash: true },
    ]) {
      await expect(readUsd3ExitQuote(mockClient(options).client, input(), NOW)).rejects.toThrow()
    }
    await expect(
      readUsd3ExitQuote(mockClient().client, input(), NOW + 2 * 60 * 60 * 1000),
    ).rejects.toThrow('finalized_block_unavailable')
    const { client, call } = mockClient()
    await expect(readUsd3ExitQuote(client, { ...input(), assetsRaw: '0' }, NOW)).rejects.toThrow(
      'request_invalid',
    )
    expect(call).not.toHaveBeenCalled()
  })
})
