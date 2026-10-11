import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, parseAbi, type PublicClient } from 'viem'

import { readSghoExit } from '@/lib/carry/sghoExit'
import {
  formatWalletGho,
  isWalletExitReading,
  sizeWithinWalletExitLimit,
} from '@/lib/carry/sghoExitPublic'

const OWNER = '0x0000000000000000000000000000000000000001'
const DELEGATED_EOA_CODE = `0xef0100${'2'.repeat(40)}`
const VAULT = '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
const GHO = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
const BLOCK = { number: 26_070_000n, hash: `0x${'a'.repeat(64)}`, timestamp: 1_800_000_000n }
const NOW = Number(BLOCK.timestamp) * 1000 + 10_000
const UNIT = 10n ** 18n
const withdrawAbi = parseAbi([
  'function withdraw(uint256 assets,address receiver,address owner) returns (uint256)',
])

function mockClient(
  options: {
    shares?: bigint
    maxRedeem?: bigint
    maxWithdraw?: bigint
    paused?: boolean
    missing?: string
    asset?: string
    shareDecimals?: bigint
    assetDecimals?: bigint
    preview?: bigint
    fullPreview?: unknown
    fullPreviewRevert?: boolean
    previewWithdraw?: bigint
    callRevert?: boolean
    rpcError?: boolean
    returnedShares?: bigint
    contractHolder?: boolean
    holderCode?: unknown
    chainId?: number
    changedHash?: boolean
  } = {},
) {
  const getBlock = vi.fn(async (query: { blockTag?: string; blockNumber?: bigint }) => {
    if (query.blockTag === 'finalized') return BLOCK
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
    }) => {
      if (call.functionName === options.missing)
        throw new Error('provider URL and key must not escape')
      if (call.functionName === 'asset') return options.asset ?? GHO
      if (call.functionName === 'decimals')
        return call.address.toLowerCase() === VAULT
          ? (options.shareDecimals ?? 18n)
          : (options.assetDecimals ?? 18n)
      if (call.functionName === 'balanceOf')
        return call.address.toLowerCase() === VAULT ? (options.shares ?? 10n * UNIT) : 100n * UNIT
      if (call.functionName === 'maxRedeem') return options.maxRedeem ?? 10n * UNIT
      if (call.functionName === 'maxWithdraw') return options.maxWithdraw ?? 10n * UNIT
      if (call.functionName === 'totalAssets') return 200n * UNIT
      if (call.functionName === 'paused') return options.paused ?? false
      if (call.functionName === 'previewRedeem') {
        if (options.maxRedeem !== undefined && call.args?.[0] === (options.shares ?? 10n * UNIT)) {
          if (options.fullPreviewRevert) throw Error('optional failed')
          if ('fullPreview' in options) return options.fullPreview
        }
        return options.preview ?? (call.args?.[0] as bigint)
      }
      if (call.functionName === 'previewWithdraw') return options.previewWithdraw ?? UNIT
      throw new Error('unexpected read')
    },
  )
  const rawRequest = vi.fn(async () =>
    'holderCode' in options ? options.holderCode : options.contractHolder ? '0x6002' : '0x',
  )
  return {
    client: {
      getChainId: vi.fn(async () => options.chainId ?? 1),
      getBlock,
      getCode: vi.fn(async ({ address }: { address: string }) =>
        address.toLowerCase() === VAULT ? '0x6001' : undefined,
      ),
      request: rawRequest,
      readContract,
      call: vi.fn(async () => {
        if (options.rpcError) throw new Error('secret RPC URL transport failed')
        if (options.callRevert || options.paused || options.shares === 0n)
          throw Object.assign(new Error('execution reverted'), {
            name: 'ContractFunctionRevertedError',
          })
        return { data: `0x${(options.returnedShares ?? UNIT).toString(16).padStart(64, '0')}` }
      }),
    } as unknown as Pick<
      PublicClient,
      'getChainId' | 'getBlock' | 'getCode' | 'request' | 'readContract' | 'call'
    >,
    getBlock,
    readContract,
    rawRequest,
  }
}

describe('sGHO wallet exit read', () => {
  it('pins every contract read to the same finalized block and caps preview to maxRedeem', async () => {
    const { client, readContract, getBlock, rawRequest } = mockClient({
      maxRedeem: 3n * UNIT,
      maxWithdraw: (29n * UNIT) / 10n,
    })
    const reading = await readSghoExit(client, OWNER, UNIT.toString(), NOW)
    expect(reading.position).toMatchObject({
      sharesRaw: (10n * UNIT).toString(),
      maxRedeemSharesRaw: (3n * UNIT).toString(),
      redeemableSharesRaw: (3n * UNIT).toString(),
      previewRedeemGho: '3',
      maxWithdrawGho: '2.9',
    })
    expect(readContract.mock.calls.every(([call]) => call.blockHash === BLOCK.hash)).toBe(true)
    expect(
      readContract.mock.calls.find(([call]) => call.functionName === 'previewRedeem')?.[0].args,
    ).toEqual([3n * UNIT])
    expect(getBlock).toHaveBeenCalledTimes(3)
    expect(rawRequest).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: BLOCK.hash, requireCanonical: true }],
    })
    expect(reading.source).toMatchObject({
      chainId: 1,
      blockNumber: Number(BLOCK.number),
      ageSeconds: 10,
    })
    expect(isWalletExitReading(reading)).toBe(true)
    expect(reading.simulation.status).toBe('success')
    expect(reading.forecast.futureExit).toBe('unavailable')
    const simulated = vi.mocked(client.call).mock.calls[0][0]
    expect(simulated).toMatchObject({
      account: OWNER,
      to: VAULT,
      blockHash: BLOCK.hash,
      requireCanonical: true,
    })
    expect(decodeFunctionData({ abi: withdrawAbi, data: simulated.data! })).toEqual({
      functionName: 'withdraw',
      args: [UNIT, OWNER, OWNER],
    })
  })

  it('keeps zero shares at zero without inventing wallet capital', async () => {
    const { client, readContract } = mockClient({ shares: 0n, maxRedeem: 0n, maxWithdraw: 0n })
    const reading = await readSghoExit(client, OWNER, UNIT.toString(), NOW)
    expect(reading.position.previewRedeemGho).toBe('0')
    expect(reading.simulation.status).toBe('position_insufficient')
    expect(
      readContract.mock.calls.find(([call]) => call.functionName === 'previewRedeem')?.[0].args,
    ).toEqual([0n])
  })

  it('forces effective availability to zero when paused even if raw limits are positive', async () => {
    const { client } = mockClient({
      paused: true,
      maxRedeem: UNIT,
      maxWithdraw: UNIT,
      preview: UNIT,
    })
    const reading = await readSghoExit(client, OWNER, UNIT.toString(), NOW)
    expect(reading.vault.withdrawalsPaused).toBe(true)
    expect(reading.position.previewRedeemGho).toBe('1')
    expect(reading.position.maxWithdrawGho).toBe('1')
    expect(reading.position.effectiveExitGhoRaw).toBe('0')
    expect(reading.simulation.status).toBe('evm_revert')
  })

  it('does not treat previewRedeem as a liquidity limit', async () => {
    const { client } = mockClient({ maxRedeem: 2n * UNIT, maxWithdraw: UNIT, preview: 2n * UNIT })
    const reading = await readSghoExit(client, OWNER, UNIT.toString(), NOW)
    expect(reading.position.previewRedeemGho).toBe('2')
    expect(reading.position.maxWithdrawGho).toBe('1')
    expect(reading.position.effectiveExitGho).toBe('1')
  })

  it('uses the same-holder simulation instead of an optimistic holder limit', async () => {
    const reverted = await readSghoExit(
      mockClient({ maxWithdraw: 10n * UNIT, callRevert: true }).client,
      OWNER,
      UNIT.toString(),
      NOW,
    )
    expect(reverted.simulation.status).toBe('evm_revert')
    const executable = await readSghoExit(
      mockClient({
        maxWithdraw: 0n,
        previewWithdraw: 11n * UNIT,
        shares: 10n * UNIT,
        returnedShares: 9n * UNIT,
      }).client,
      OWNER,
      UNIT.toString(),
      NOW,
    )
    expect(executable.simulation.status).toBe('success')
    await expect(
      readSghoExit(mockClient({ rpcError: true }).client, OWNER, UNIT.toString(), NOW),
    ).rejects.toThrow('secret RPC URL')
    await expect(
      readSghoExit(mockClient({ returnedShares: 11n * UNIT }).client, OWNER, UNIT.toString(), NOW),
    ).rejects.toThrow('sgho_exit_result_invalid')
  })

  it('simulates an exact EIP-7702 delegated EOA without claiming a mined exit', async () => {
    const { client, rawRequest } = mockClient({ holderCode: DELEGATED_EOA_CODE })
    const reading = await readSghoExit(client, OWNER, UNIT.toString(), NOW)
    expect(reading.simulation.status).toBe('success')
    expect(reading.forecast.futureExit).toBe('unavailable')
    expect(rawRequest).toHaveBeenCalledOnce()
  })

  it('rejects missing raw holder code before simulation', async () => {
    const { client } = mockClient({ holderCode: undefined })
    await expect(readSghoExit(client, OWNER, UNIT.toString(), NOW)).rejects.toThrow(
      'sgho_contract_holder_unavailable',
    )
    expect(client.call).not.toHaveBeenCalled()
  })

  it('fails the entire reading if identity, precision, pause, or preview is missing', async () => {
    for (const options of [
      { asset: OWNER },
      { shareDecimals: 6n },
      { assetDecimals: 6n },
      { missing: 'paused' },
      { missing: 'previewRedeem' },
      { contractHolder: true },
    ]) {
      const { client } = mockClient(options)
      await expect(readSghoExit(client, OWNER, UNIT.toString(), NOW)).rejects.toThrow()
    }
  })

  it('rejects a wrong chain, changed block hash, or stale finalized block', async () => {
    await expect(
      readSghoExit(mockClient({ chainId: 10 }).client, OWNER, UNIT.toString(), NOW),
    ).rejects.toThrow('sgho_chain_mismatch')
    await expect(
      readSghoExit(mockClient({ changedHash: true }).client, OWNER, UNIT.toString(), NOW),
    ).rejects.toThrow('sgho_block_hash_changed')
    await expect(
      readSghoExit(mockClient().client, OWNER, UNIT.toString(), NOW + 3 * 60 * 60 * 1000),
    ).rejects.toThrow('sgho_finalized_block_unavailable')
  })

  it('does not seal a wallet limit after a slow read ages the block out', async () => {
    let calls = 0
    await expect(
      readSghoExit(mockClient().client, OWNER, UNIT.toString(), () =>
        calls++ === 0 ? NOW : NOW + 3 * 60 * 60 * 1000,
      ),
    ).rejects.toThrow('sgho_finalized_block_unavailable')
  })

  it('keeps a fractional wallet limit legible beside an exact-size comparison', () => {
    expect(formatWalletGho('0.999')).toBe('0.999 GHO')
    expect(formatWalletGho('0.999999999999999999')).toBe('≈0.999999 GHO')
    expect(formatWalletGho('0.000000000000000001')).toBe('<0.000001 GHO')
    expect(sizeWithinWalletExitLimit('0.999', '999000000000000000')).toBe(true)
    expect(sizeWithinWalletExitLimit('1', '999000000000000000')).toBe(false)
    expect(isWalletExitReading({ status: 'ok', source: {}, position: { maxWithdrawGho: 1 } })).toBe(
      false,
    )
  })
})

describe('optional sGHO full-position entitlement', () => {
  it('attests full shares separately from cash-clipped redeemable shares at the same pin', async () => {
    const m = mockClient({ maxRedeem: 3n * UNIT })
    const r = await readSghoExit(m.client, OWNER, UNIT.toString(), NOW, undefined, {
      includeCapacityFacts: true,
    })
    expect(r.position.previewRedeemGhoRaw).toBe((3n * UNIT).toString())
    expect(r.position.fullPositionEntitlementGhoRaw).toBe((10n * UNIT).toString())
    expect(r.simulation.status).toBe('success')
    const previews = m.readContract.mock.calls
      .map((c) => c[0])
      .filter((c) => c.functionName === 'previewRedeem')
    expect(previews.map((c) => c.args)).toEqual([[3n * UNIT], [10n * UNIT]])
    expect(previews.every((c) => c.blockHash === BLOCK.hash)).toBe(true)
  })
  it('reuses the required preview when all shares are currently redeemable; opt-out shape stays unchanged', async () => {
    const m = mockClient()
    const r = await readSghoExit(m.client, OWNER, UNIT.toString(), NOW, undefined, {
      includeCapacityFacts: true,
    })
    expect(r.position.fullPositionEntitlementGhoRaw).toBe(r.position.previewRedeemGhoRaw)
    expect(
      m.readContract.mock.calls.filter((c) => c[0].functionName === 'previewRedeem'),
    ).toHaveLength(1)
    const old = await readSghoExit(mockClient().client, OWNER, UNIT.toString(), NOW)
    expect(old.position).not.toHaveProperty('fullPositionEntitlementGhoRaw')
  })
  it.each([null, '100', [100n], -1n, 1n << 256n, 2n * UNIT])(
    'optional malformed/contradictory full E %s cannot invalidate current reading',
    async (fullPreview) => {
      const r = await readSghoExit(
        mockClient({ maxRedeem: 3n * UNIT, fullPreview }).client,
        OWNER,
        UNIT.toString(),
        NOW,
        undefined,
        { includeCapacityFacts: true },
      )
      expect(r.position.fullPositionEntitlementGhoRaw).toBeNull()
      expect(r.position.previewRedeemGhoRaw).toBe((3n * UNIT).toString())
      expect(r.simulation.status).toBe('success')
    },
  )
  it('optional transport failure retains current limit and successful Q', async () => {
    const r = await readSghoExit(
      mockClient({ maxRedeem: 3n * UNIT, fullPreviewRevert: true }).client,
      OWNER,
      UNIT.toString(),
      NOW,
      undefined,
      { includeCapacityFacts: true },
    )
    expect(r.position.fullPositionEntitlementGhoRaw).toBeNull()
    expect(r.position.effectiveExitGhoRaw).toBe((3n * UNIT).toString())
    expect(r.simulation.status).toBe('success')
  })
})
