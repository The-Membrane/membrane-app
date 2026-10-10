import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, parseAbi, type Address } from 'viem'

import {
  readSusdsExitQuote,
  resolveSusdsExitTarget,
  SUSDS_ROUTE_KEY,
  SUSDS_VAULT,
  USDS_ASSET,
  type SusdsExitClient,
} from '@/lib/carry/susdsExitQuote'

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
const AMOUNT = 1_000_000_000_000_000_000n
const withdrawAbi = parseAbi([
  'function withdraw(uint256 assets,address receiver,address owner) returns (uint256)',
])
const input = () => ({
  routeKey: SUSDS_ROUTE_KEY,
  destinationAddress: SUSDS_VAULT,
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
    returnedShares?: bigint
    chainId?: number
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
        return options.wrongAsset ? HOLDER : USDS_ASSET
      case 'decimals':
        return 18n
      case 'balanceOf':
        return options.balance ?? 2n * AMOUNT
      case 'maxWithdraw':
        return options.maxWithdraw ?? 2n * AMOUNT
      case 'previewWithdraw':
        return options.preview ?? AMOUNT
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
      query.address.toLowerCase() === SUSDS_VAULT ? '0x6001' : undefined,
    ),
    request: vi.fn(async () =>
      'holderCode' in options ? options.holderCode : options.contract ? '0x6002' : '0x',
    ),
    readContract,
    call,
  } as unknown as SusdsExitClient
  return { client, getBlock, readContract, call }
}

describe('sUSDS exact-holder exit quote', () => {
  it('accepts only the pinned route and vault', () => {
    expect(resolveSusdsExitTarget(SUSDS_ROUTE_KEY, SUSDS_VAULT).asset).toBe(USDS_ASSET)
    expect(() => resolveSusdsExitTarget('USDS → other', SUSDS_VAULT)).toThrow('target_unknown')
    expect(() => resolveSusdsExitTarget(SUSDS_ROUTE_KEY, HOLDER)).toThrow('target_unknown')
    expect(() =>
      resolveSusdsExitTarget('USDS → StUsds [USDS]', '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'),
    ).toThrow('target_unknown')
    expect(() =>
      resolveSusdsExitTarget(SUSDS_ROUTE_KEY, '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'),
    ).toThrow('target_unknown')
  })

  it('pins every read and simulates exact amount as holder', async () => {
    const { client, getBlock, readContract, call } = mockClient()
    const reading = await readSusdsExitQuote(client, input(), NOW)
    expect(reading.status).toBe('checked_at_finalized_block')
    expect(reading.simulation).toEqual({ status: 'success', sharesBurnedRaw: AMOUNT.toString() })
    expect(reading.forecast).toEqual({
      futureExit: 'unavailable',
      exitDuration: 'unavailable',
      prospectiveValidated: false,
    })
    expect(reading.source).toMatchObject({ blockHash: BLOCK.hash, ageSeconds: 10 })
    expect(getBlock).toHaveBeenCalledTimes(3)
    expect(client.request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [HOLDER, { blockHash: BLOCK.hash, requireCanonical: true }],
    })
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
        to: SUSDS_VAULT,
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
  })

  it('uses an internal canonical historical block for exact-holder withdrawal', async () => {
    const { client, getBlock, readContract, call } = mockClient()
    const reading = await readSusdsExitQuote(client, input(), NOW, HISTORICAL_SELECTION)
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
      readSusdsExitQuote(
        mockClient({ historicalMismatch: true }).client,
        input(),
        NOW,
        HISTORICAL_SELECTION,
      ),
    ).rejects.toThrow('susds_exit_block_hash_changed')
    await expect(
      readSusdsExitQuote(mockClient().client, input(), NOW, {
        ...HISTORICAL_SELECTION,
        blockNumber: BLOCK.number + 1n,
      }),
    ).rejects.toThrow('susds_exit_historical_block_invalid')
    await expect(
      readSusdsExitQuote(
        mockClient().client,
        input(),
        NOW + 2 * 60 * 60 * 1000,
        HISTORICAL_SELECTION,
      ),
    ).rejects.toThrow('susds_exit_finalized_block_unavailable')
  })

  it('reports insufficient holder shares separately from an EVM revert', async () => {
    const insufficient = await readSusdsExitQuote(
      mockClient({ balance: 0n, revert: true }).client,
      input(),
      NOW,
    )
    expect(insufficient.simulation).toEqual({
      status: 'position_insufficient',
      reason: 'requested_amount_exceeds_holder_shares',
    })
    const reverted = await readSusdsExitQuote(mockClient({ revert: true }).client, input(), NOW)
    expect(reverted.simulation).toEqual({
      status: 'evm_revert',
      reason: 'unknown_execution_constraint',
    })
    await expect(
      readSusdsExitQuote(mockClient({ rpcError: true }).client, input(), NOW),
    ).rejects.toThrow('secret RPC URL')
  })

  it('keeps a successful exact withdrawal when the preview overestimates burned shares', async () => {
    const reading = await readSusdsExitQuote(
      mockClient({ balance: 99n, preview: 100n, returnedShares: 99n }).client,
      input(),
      NOW,
    )
    expect(reading.simulation).toEqual({ status: 'success', sharesBurnedRaw: '99' })
  })

  it('simulates an exact EIP-7702 delegated EOA without claiming a future payout', async () => {
    const { client, call } = mockClient({ holderCode: DELEGATED_EOA_CODE })
    const reading = await readSusdsExitQuote(client, input(), NOW)
    expect(reading.simulation.status).toBe('success')
    expect(reading.forecast.futureExit).toBe('unavailable')
    expect(call).toHaveBeenCalledOnce()
  })

  it('rejects missing raw holder code before simulation', async () => {
    const { client, call } = mockClient({ holderCode: undefined })
    await expect(readSusdsExitQuote(client, input(), NOW)).rejects.toThrow(
      'susds_exit_contract_holder_unavailable',
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('fails closed for identity, holder, return, chain, block and freshness errors', async () => {
    for (const options of [
      { wrongAsset: true },
      { contract: true },
      { returnedShares: 0n },
      { returnedShares: 3n * AMOUNT },
      { chainId: 10 },
      { changedHash: true },
    ]) {
      await expect(readSusdsExitQuote(mockClient(options).client, input(), NOW)).rejects.toThrow()
    }
    await expect(
      readSusdsExitQuote(mockClient().client, input(), NOW + 2 * 60 * 60 * 1000),
    ).rejects.toThrow('finalized_block_unavailable')
    const { client, call } = mockClient()
    await expect(readSusdsExitQuote(client, { ...input(), assetsRaw: '0' }, NOW)).rejects.toThrow(
      'request_invalid',
    )
    expect(call).not.toHaveBeenCalled()
  })
})
