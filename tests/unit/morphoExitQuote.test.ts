import { describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

import morphoIdentities from '@/lib/carry/morpho-v2-asset-identities.json'
import {
  readMorphoExitQuote,
  resolveMorphoExitTarget,
  type MorphoExitClient,
} from '@/lib/carry/morphoExitQuote'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'

const IDENTITY = morphoIdentities.entries[0]
const ROUTE = seed.positions.find((entry) => entry.vault.toLowerCase() === IDENTITY.vault)!
  .routeIds[0]
const OWNER = '0x0000000000000000000000000000000000000001'
const DELEGATED_EOA_CODE = `0xef0100${'2'.repeat(40)}`
const BLOCK = { number: 26_070_000n, hash: `0x${'a'.repeat(64)}`, timestamp: 1_800_000_000n }
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
const input = {
  routeKey: ROUTE,
  destinationAddress: IDENTITY.vault as `0x${string}`,
  owner: OWNER as `0x${string}`,
  assetsRaw: '1000000',
}

function mockClient(
  options: {
    shares?: bigint
    preview?: bigint
    rawBalance?: `0x${string}`
    rawPreview?: `0x${string}`
    burned?: bigint
    asset?: string
    revert?: boolean
    rpcError?: boolean
    changedHash?: boolean
    historicalMismatch?: boolean
    contractHolder?: boolean
    holderCode?: unknown
    gasCapError?: boolean
    chainId?: number
    missing?: string
  } = {},
) {
  const getBlock = vi.fn(async (query: { blockTag?: string; blockNumber?: bigint }) => {
    if (query.blockTag === 'finalized') return BLOCK
    if (query.blockNumber === HISTORICAL.number)
      return options.historicalMismatch
        ? { ...HISTORICAL, hash: `0x${'d'.repeat(64)}` }
        : HISTORICAL
    if (options.changedHash && getBlock.mock.calls.length === 3) {
      return { ...BLOCK, hash: `0x${'b'.repeat(64)}` }
    }
    return BLOCK
  })
  const readContract = vi.fn(
    async (call: {
      address: string
      functionName: string
      args?: unknown[]
      blockHash?: string
      requireCanonical?: boolean
    }) => {
      if (call.functionName === options.missing) throw new Error('secret RPC URL')
      if (call.functionName === 'asset') return options.asset ?? IDENTITY.asset
      if (call.functionName === 'decimals') return 6n
      throw new Error('unexpected read')
    },
  )
  const call = vi.fn(async () => {
    if (options.rpcError) throw new Error('secret RPC URL transport unavailable')
    if (options.gasCapError)
      throw Object.assign(new Error('execution reverted'), {
        name: 'ExecutionRevertedError',
        details: 'gas required exceeds allowance',
      })
    if (options.revert) {
      throw Object.assign(new Error('The contract function "withdraw" reverted.'), {
        name: 'ContractFunctionRevertedError',
      })
    }
    const burned = options.burned ?? 1_000_000n
    return { data: `0x${burned.toString(16).padStart(64, '0')}` }
  })
  const client = {
    getChainId: vi.fn(async () => options.chainId ?? 1),
    getBlock,
    request: vi.fn(async (request: { method: string; params: unknown[] }) => {
      if (request.method === 'eth_getCode')
        return 'holderCode' in options
          ? options.holderCode
          : options.contractHolder
            ? '0x6001'
            : '0x'
      if (request.method !== 'eth_call') throw new Error('unexpected RPC method')
      const data = (request.params[0] as { data: string }).data
      const key = data.startsWith('0x70a08231')
        ? 'balanceOf'
        : data.startsWith('0x4cdad506')
          ? 'previewRedeem'
          : null
      if (!key) throw new Error('unexpected raw read')
      if (key === options.missing) throw new Error('secret RPC URL')
      if (key === 'balanceOf' && options.rawBalance !== undefined) return options.rawBalance
      if (key === 'previewRedeem' && options.rawPreview !== undefined) return options.rawPreview
      const result =
        key === 'balanceOf' ? (options.shares ?? 5_000_000n) : (options.preview ?? 5_000_000n)
      return `0x${result.toString(16).padStart(64, '0')}`
    }),
    readContract,
    call,
  } as unknown as MorphoExitClient
  return { client, getBlock, readContract, call }
}

describe('Morpho VaultV2 holder exit quote', () => {
  it('allows only the exact tracked route and factory-verified destination', () => {
    expect(resolveMorphoExitTarget(ROUTE, IDENTITY.vault as `0x${string}`)).toEqual({
      vault: IDENTITY.vault,
      asset: IDENTITY.asset,
    })
    expect(() =>
      resolveMorphoExitTarget('GHO → sGho [GHO]', IDENTITY.vault as `0x${string}`),
    ).toThrow('morpho_route_destination_unknown')
    expect(() => resolveMorphoExitTarget(ROUTE, OWNER)).toThrow('morpho_route_destination_unknown')
  })

  it('pins reads and same-holder withdraw simulation to one finalized block', async () => {
    const { client, getBlock, readContract, call } = mockClient()
    const reading = await readMorphoExitQuote(client, input, NOW)
    expect(reading.status).toBe('checked_at_finalized_block')
    expect(reading.simulation).toEqual({ status: 'success', sharesBurnedRaw: '1000000' })
    expect(reading.forecast).toEqual({
      futureExit: 'unavailable',
      exitDuration: 'unavailable',
      prospectiveValidated: false,
    })
    expect(reading.source).toMatchObject({ blockNumber: Number(BLOCK.number), ageSeconds: 10 })
    expect(
      readContract.mock.calls.every(
        ([args]) => args.blockHash === BLOCK.hash && args.requireCanonical === true,
      ),
    ).toBe(true)
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        account: OWNER,
        to: IDENTITY.vault,
        gas: 20_000_000n,
        blockHash: BLOCK.hash,
        requireCanonical: true,
      }),
    )
    expect(client.request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: BLOCK.hash, requireCanonical: true }],
    })
    expect(getBlock).toHaveBeenCalledTimes(3)
    expect(readContract).toHaveBeenCalledTimes(3)
    const rawCalls = vi
      .mocked(client.request)
      .mock.calls.filter(([request]) => request.method === 'eth_call')
    expect(rawCalls).toEqual([
      [
        {
          method: 'eth_call',
          params: [
            {
              to: IDENTITY.vault.toLowerCase(),
              data: `0x70a08231${OWNER.slice(2).padStart(64, '0')}`,
            },
            { blockHash: BLOCK.hash, requireCanonical: true },
          ],
        },
      ],
      [
        {
          method: 'eth_call',
          params: [
            {
              to: IDENTITY.vault.toLowerCase(),
              data: `0x4cdad506${5_000_000n.toString(16).padStart(64, '0')}`,
            },
            { blockHash: BLOCK.hash, requireCanonical: true },
          ],
        },
      ],
    ])
    expect(reading.morphoHolderPositionObservation?.traces.map((trace) => trace.result)).toEqual([
      `0x${5_000_000n.toString(16).padStart(64, '0')}`,
      `0x${5_000_000n.toString(16).padStart(64, '0')}`,
    ])
    expect(JSON.stringify(reading)).not.toContain(OWNER)
  })

  it('allows only an internal canonical historical finalization with pinned holder/Q reads', async () => {
    const { client, getBlock, readContract, call } = mockClient()
    const reading = await readMorphoExitQuote(client, input, NOW, HISTORICAL_SELECTION)
    expect(reading.source.blockNumber).toBe(Number(HISTORICAL.number))
    expect(reading.source.blockHash).toBe(HISTORICAL.hash)
    expect(reading.source.ageSeconds).toBeGreaterThan(2 * 60 * 60)
    expect(reading.morphoHolderPositionObservation).toBeUndefined()
    expect(getBlock).toHaveBeenCalledTimes(4)
    expect(getBlock.mock.calls[0][0]).toEqual({ blockTag: 'finalized' })
    expect(getBlock.mock.calls[1][0]).toEqual({ blockNumber: HISTORICAL.number })
    expect(
      readContract.mock.calls.every(
        ([args]) => args.blockHash === HISTORICAL.hash && args.requireCanonical === true,
      ),
    ).toBe(true)
    expect(client.request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: HISTORICAL.hash, requireCanonical: true }],
    })
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        account: OWNER,
        blockHash: HISTORICAL.hash,
        requireCanonical: true,
      }),
    )
  })

  it('rejects historical hash mismatch, unfinalized target, and stale finalized head', async () => {
    await expect(
      readMorphoExitQuote(
        mockClient({ historicalMismatch: true }).client,
        input,
        NOW,
        HISTORICAL_SELECTION,
      ),
    ).rejects.toThrow('morpho_block_hash_changed')
    await expect(
      readMorphoExitQuote(mockClient().client, input, NOW, {
        ...HISTORICAL_SELECTION,
        blockNumber: BLOCK.number + 1n,
      }),
    ).rejects.toThrow('morpho_historical_block_invalid')
    await expect(
      readMorphoExitQuote(
        mockClient().client,
        input,
        NOW + 3 * 60 * 60 * 1000,
        HISTORICAL_SELECTION,
      ),
    ).rejects.toThrow('morpho_finalized_block_unavailable')
  })

  it('reports an EVM revert without asserting the cause or future duration', async () => {
    const reading = await readMorphoExitQuote(mockClient({ revert: true }).client, input, NOW)
    expect(reading.status).toBe('checked_at_finalized_block')
    expect(reading.simulation).toEqual({
      status: 'evm_revert',
      reason: 'unknown_execution_constraint',
    })
    expect(reading.forecast.exitDuration).toBe('unavailable')
    expect(reading.morphoHolderPositionObservation?.traces).toHaveLength(2)
    expect(reading.position).toMatchObject({
      sharesRaw: '5000000',
      previewRedeemAssetsRaw: '5000000',
    })
  })

  it('retains the native zero position even when withdraw reverts', async () => {
    const reading = await readMorphoExitQuote(
      mockClient({ shares: 0n, preview: 0n, revert: true }).client,
      input,
      NOW,
    )
    expect(reading.simulation).toEqual({ status: 'evm_revert', reason: 'no_holder_shares' })
    expect(reading.position).toMatchObject({ sharesRaw: '0', previewRedeemAssetsRaw: '0' })
    expect(
      reading.morphoHolderPositionObservation?.traces.every(
        (trace) => trace.result === `0x${'0'.repeat(64)}`,
      ),
    ).toBe(true)
  })

  it('rejects noncanonical raw replies and omits approval observations for slow quotes', async () => {
    for (const rawPreview of ['0x01', `0x${'0'.repeat(64)}00`] as const)
      await expect(
        readMorphoExitQuote(mockClient({ rawPreview }).client, input, NOW),
      ).rejects.toThrow()
    let tick = 0
    const reading = await readMorphoExitQuote(
      mockClient().client,
      input,
      () => NOW + tick++ * 30_000,
    )
    expect(reading.simulation.status).toBe('success')
    expect(reading.morphoHolderPositionObservation).toBeUndefined()
  })

  it('does not turn an RPC error into a liquidity constraint', async () => {
    await expect(
      readMorphoExitQuote(mockClient({ rpcError: true }).client, input, NOW),
    ).rejects.toThrow('secret RPC URL')
  })

  it('simulates for an exact EIP-7702 delegated EOA without claiming a payout', async () => {
    const { client, call } = mockClient({ holderCode: DELEGATED_EOA_CODE })
    const reading = await readMorphoExitQuote(client, input, NOW)
    expect(reading.simulation.status).toBe('success')
    expect(reading.forecast.futureExit).toBe('unavailable')
    expect(call).toHaveBeenCalledOnce()
  })

  it('does not call from contract holders or classify provider gas caps as vault blocks', async () => {
    const contract = mockClient({ contractHolder: true })
    await expect(readMorphoExitQuote(contract.client, input, NOW)).rejects.toThrow(
      'morpho_contract_holder_path_unavailable',
    )
    expect(contract.call).not.toHaveBeenCalled()
    const missing = mockClient({ holderCode: undefined })
    await expect(readMorphoExitQuote(missing.client, input, NOW)).rejects.toThrow(
      'morpho_contract_holder_path_unavailable',
    )
    expect(missing.call).not.toHaveBeenCalled()
    await expect(
      readMorphoExitQuote(mockClient({ gasCapError: true }).client, input, NOW),
    ).rejects.toThrow('execution reverted')
  })

  it('fails closed on identity mismatch, incoherent success, and incomplete reads', async () => {
    for (const options of [
      { asset: OWNER },
      { shares: 0n },
      { preview: 0n },
      { burned: 0n },
      { burned: 6_000_000n },
      { missing: 'previewRedeem' },
    ]) {
      await expect(readMorphoExitQuote(mockClient(options).client, input, NOW)).rejects.toThrow()
    }
  })

  it('rejects wrong chain, stale or changed block, and malformed amount before simulation', async () => {
    await expect(
      readMorphoExitQuote(mockClient({ chainId: 10 }).client, input, NOW),
    ).rejects.toThrow('morpho_chain_mismatch')
    await expect(
      readMorphoExitQuote(mockClient({ changedHash: true }).client, input, NOW),
    ).rejects.toThrow('morpho_block_hash_changed')
    await expect(
      readMorphoExitQuote(mockClient().client, input, NOW + 3 * 60 * 60 * 1000),
    ).rejects.toThrow('morpho_finalized_block_unavailable')
    const { client, call } = mockClient()
    await expect(readMorphoExitQuote(client, { ...input, assetsRaw: '0' }, NOW)).rejects.toThrow(
      'morpho_exit_request_invalid',
    )
    expect(call).not.toHaveBeenCalled()
  })
})
