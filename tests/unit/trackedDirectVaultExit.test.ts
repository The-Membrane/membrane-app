import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, parseAbi, type Address } from 'viem'

import {
  readTrackedDirectVaultExit,
  resolveTrackedDirectVaultExitTarget,
  type TrackedDirectVaultExitClient,
} from '@/lib/carry/trackedDirectVaultExit'

const HOLDER = '0x0000000000000000000000000000000000000001' as Address
const DELEGATION_CODE = `0xef0100${'1'.repeat(40)}`
const BLOCK = {
  number: 26_080_000n,
  hash: `0x${'a'.repeat(64)}` as `0x${string}`,
  timestamp: 1_800_000_000n,
}
const NOW = Number(BLOCK.timestamp) * 1000 + 10_000
const ABI = parseAbi(['function withdraw(uint256,address,address) returns (uint256)'])
const TARGETS = [
  [
    'USDS → StUsds [USDS]',
    '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    18,
  ],
  [
    'USDC → Fluid USD Coin [USDC]',
    '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    6,
  ],
  [
    'USDT → fToken [USDT]',
    '0x5c20b550819128074fd538edf79791733ccedd18',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
    6,
  ],
  [
    'GHO → fToken [GHO]',
    '0x6a29a46e21c730dca1d8b23d637c101cec605c5b',
    '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    18,
  ],
  [
    'USDC → FluidBridgeAggregatorProxy [USDC]',
    '0x273da948aca9261043fbdb2a857bc255ecc29012',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    6,
  ],
  [
    'USDT → FluidBridgeAggregatorProxy [USDC]',
    '0x273da948aca9261043fbdb2a857bc255ecc29012',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    6,
  ],
] as const

function request(index = 0) {
  const [routeKey, destinationAddress, , decimals] = TARGETS[index]
  return {
    routeKey,
    destinationAddress: destinationAddress as Address,
    owner: HOLDER,
    assetsRaw: (10n ** BigInt(decimals)).toString(),
    ...(index === 5 ? { assetUnit: 'USDC' as const } : {}),
  }
}

function mockClient(
  index = 0,
  options: {
    wrongAsset?: boolean
    wrongDecimals?: boolean
    noVaultCode?: boolean
    noAssetCode?: boolean
    contractHolder?: boolean
    missingHolderCode?: boolean
    delegatedHolder?: boolean
    balance?: bigint
    preview?: bigint
    burned?: bigint
    revert?: boolean
    gasError?: boolean
    rpcError?: boolean
    changedHash?: boolean
    chainId?: number
  } = {},
) {
  const [, vault, asset, decimals] = TARGETS[index]
  const amount = 10n ** BigInt(decimals)
  let blockReads = 0
  const getBlock = vi.fn(async ({ blockTag }: { blockTag?: string }) => {
    blockReads += 1
    return options.changedHash && !blockTag && blockReads === 3
      ? { ...BLOCK, hash: `0x${'b'.repeat(64)}` }
      : BLOCK
  })
  const readContract = vi.fn(async (args: { address: Address; functionName: string }) => {
    if (args.functionName === 'asset') return options.wrongAsset ? HOLDER : asset
    if (args.functionName === 'decimals')
      return args.address.toLowerCase() === asset
        ? options.wrongDecimals
          ? decimals + 1
          : decimals
        : 18
    if (args.functionName === 'balanceOf') return options.balance ?? amount * 2n
    if (args.functionName === 'maxWithdraw') return amount * 2n
    if (args.functionName === 'previewWithdraw') return options.preview ?? amount
    throw new Error('unexpected_read')
  })
  const call = vi.fn(async (_args: { account: Address; to: Address; data: `0x${string}` }) => {
    if (options.rpcError) throw new Error('secret RPC transport failed')
    if (options.gasError) throw new Error('gas required exceeds allowance')
    if (options.revert)
      throw Object.assign(new Error('execution reverted'), {
        name: 'ContractFunctionRevertedError',
      })
    return { data: `0x${(options.burned ?? amount).toString(16).padStart(64, '0')}` }
  })
  const getCode = vi.fn(async ({ address }: { address: Address }) => {
    if (address.toLowerCase() === vault) return options.noVaultCode ? undefined : '0x6001'
    if (address.toLowerCase() === asset) return options.noAssetCode ? undefined : '0x6002'
    return options.contractHolder ? '0x6003' : undefined
  })
  const rawCode = vi.fn(async ({ method, params }: { method: string; params: unknown[] }) => {
    expect(method).toBe('eth_getCode')
    expect(params).toEqual([HOLDER, { blockHash: BLOCK.hash, requireCanonical: true }])
    return options.missingHolderCode
      ? undefined
      : options.contractHolder
        ? '0x6003'
        : options.delegatedHolder
          ? DELEGATION_CODE
          : '0x'
  })
  return {
    client: {
      getChainId: vi.fn(async () => options.chainId ?? 1),
      getBlock,
      getCode,
      request: rawCode,
      readContract,
      call,
    } as unknown as TrackedDirectVaultExitClient,
    getBlock,
    getCode,
    rawCode,
    readContract,
    call,
  }
}

describe('tracked direct vault exact-holder exit', () => {
  it('simulates an exact EIP-7702 delegated EOA holder', async () => {
    const quote = await readTrackedDirectVaultExit(
      mockClient(0, { delegatedHolder: true }).client,
      request(),
      NOW,
    )
    expect(quote.simulation.status).toBe('success')
  })

  it('pins only six route, vault and asset identities', () => {
    for (const [routeKey, vault, asset] of TARGETS) {
      expect(resolveTrackedDirectVaultExitTarget(routeKey, vault as Address).asset).toBe(asset)
    }
    expect(() => resolveTrackedDirectVaultExitTarget(TARGETS[0][0], TARGETS[1][1])).toThrow(
      'target_unknown',
    )
    expect(() =>
      resolveTrackedDirectVaultExitTarget('USDT → Fluid USD Coin [USDC]', TARGETS[1][1]),
    ).toThrow('target_unknown')
    expect(() =>
      resolveTrackedDirectVaultExitTarget(
        'USDT → FluidBridgeAggregatorProxy [USDC]',
        TARGETS[1][1],
      ),
    ).toThrow('target_unknown')
  })

  it.each([0, 1, 2, 3, 4, 5])(
    'pins calls and decodes burned shares for target %i',
    async (index) => {
      const { client, getBlock, getCode, rawCode, readContract, call } = mockClient(index)
      const quote = await readTrackedDirectVaultExit(client, request(index), NOW)
      expect(quote.simulation).toEqual({
        status: 'success',
        sharesBurnedRaw: request(index).assetsRaw,
      })
      expect(quote.forecast).toEqual({
        futureExit: 'unavailable',
        exitDuration: 'unavailable',
        prospectiveValidated: false,
      })
      expect(quote.source.blockHash).toBe(BLOCK.hash)
      expect(quote.vault.assetAddress).toBe(TARGETS[index][2])
      expect(quote.vault.implementationSourceAttested).toBe(false)
      expect(getBlock).toHaveBeenCalledTimes(3)
      expect(rawCode).toHaveBeenCalledTimes(1)
      for (const [args] of [
        ...getCode.mock.calls,
        ...readContract.mock.calls,
        ...call.mock.calls,
      ]) {
        expect(args).toMatchObject({ blockHash: BLOCK.hash, requireCanonical: true })
      }
      const [callArgs] = call.mock.calls[0]
      expect(callArgs).toMatchObject({ account: HOLDER, to: TARGETS[index][1] })
      expect(decodeFunctionData({ abi: ABI, data: callArgs.data })).toEqual({
        functionName: 'withdraw',
        args: [BigInt(request(index).assetsRaw), HOLDER, HOLDER],
      })
      expect(JSON.stringify(quote)).not.toContain(HOLDER)
      if (index === 5) {
        expect(quote.request.assetUnit).toBe('USDC')
        expect(quote.routeLeg).toEqual({
          checked: 'same_holder_usdc_vault_withdrawal_simulation',
          usdcToUsdtConversion: 'unassessed',
          usdtReceipt: 'unassessed',
        })
        expect(quote.caveat).toContain('USDC to USDT conversion')
      }
    },
  )

  it('requires explicit USDC units for the USDT bridge first-leg request', async () => {
    const { client, call } = mockClient(5)
    await expect(
      readTrackedDirectVaultExit(client, { ...request(5), assetUnit: undefined }, NOW),
    ).rejects.toThrow('tracked_direct_exit_request_invalid')
    expect(call).not.toHaveBeenCalled()
  })

  it('does not let a preview overrule a successful exact withdrawal', async () => {
    const quote = await readTrackedDirectVaultExit(
      mockClient(1, { balance: 99n, preview: 100n, burned: 99n }).client,
      request(1),
      NOW,
    )
    expect(quote.simulation).toEqual({ status: 'success', sharesBurnedRaw: '99' })
  })

  it('separates zero shares from preview-ambiguous EVM reverts', async () => {
    const insufficient = await readTrackedDirectVaultExit(
      mockClient(0, { balance: 0n, revert: true }).client,
      request(),
      NOW,
    )
    expect(insufficient.simulation.status).toBe('position_insufficient')
    const previewGap = await readTrackedDirectVaultExit(
      mockClient(0, { balance: 99n, preview: 100n, revert: true }).client,
      request(),
      NOW,
    )
    expect(previewGap.simulation).toEqual({
      status: 'evm_revert',
      reason: 'unknown_execution_constraint',
      holderCoverage: 'inconclusive_preview_gap',
    })
    const covered = await readTrackedDirectVaultExit(
      mockClient(0, { revert: true }).client,
      request(),
      NOW,
    )
    expect(covered.simulation).toEqual({
      status: 'evm_revert',
      reason: 'unknown_execution_constraint',
      holderCoverage: 'preview_covered_not_proven',
    })
  })

  it('fails closed on identity, code, response, gas, RPC, chain and canonical-block faults', async () => {
    for (const options of [
      { wrongAsset: true },
      { wrongDecimals: true },
      { noVaultCode: true },
      { noAssetCode: true },
      { contractHolder: true },
      { missingHolderCode: true },
      { burned: 0n },
      { burned: 3n * 10n ** 18n },
      { gasError: true },
      { rpcError: true },
      { changedHash: true },
      { chainId: 8453 },
    ]) {
      await expect(
        readTrackedDirectVaultExit(mockClient(0, options).client, request(), NOW),
      ).rejects.toThrow()
    }
  })
})
