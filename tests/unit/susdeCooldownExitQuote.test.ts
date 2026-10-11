import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address } from 'viem'

import {
  readSusdeCooldownExitQuote,
  resolveSusdeCooldownExitTarget,
  type SusdeCooldownExitClient,
} from '@/lib/carry/susdeCooldownExitQuote'

const VAULT = '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497' as Address
const USDE = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3' as Address
const SILO = '0x7FC7c91D556B400AFa565013E3F32055a0713425' as Address
const HOLDER = '0x0000000000000000000000000000000000000001' as Address
const DELEGATED_EOA_CODE = `0xef0100${'2'.repeat(40)}`
const BLOCK = {
  number: 26_080_000n,
  hash: `0x${'a'.repeat(64)}` as `0x${string}`,
  timestamp: 1_800_000_000n,
}
const NOW = Number(BLOCK.timestamp) * 1000 + 10_000
const REQUEST = {
  routeKey: 'USDe → Staked USDe [USDe]',
  destinationAddress: VAULT,
  owner: HOLDER,
  assetsRaw: '1000000000000000000',
}
const CALL_ABI = parseAbi([
  'function cooldownAssets(uint256) returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
  'function unstake(address)',
])
const CLAIM_SELECTOR = encodeFunctionData({
  abi: CALL_ABI,
  functionName: 'unstake',
  args: [HOLDER],
}).slice(0, 10)
const DIRECT_WITHDRAWAL_SELECTOR = encodeFunctionData({
  abi: CALL_ABI,
  functionName: 'withdraw',
  args: [1n, HOLDER, HOLDER],
}).slice(0, 10)

function mockClient(
  options: {
    queueAmount?: bigint
    queueEnd?: bigint
    initiationRevert?: boolean
    directWithdrawalRevert?: boolean
    directWithdrawalSharesBurned?: bigint
    claimRevert?: boolean
    rpcError?: boolean
    wrongAsset?: boolean
    wrongSilo?: boolean
    changedHash?: boolean
    holderCode?: unknown
    duration?: number
    maxWithdraw?: bigint
    siloUsdeBalance?: unknown
    activeEntitlement?: unknown
    activeEntitlementError?: boolean
  } = {},
) {
  const getBlock = vi.fn(async (query: { blockTag?: string }) =>
    options.changedHash && !query.blockTag && getBlock.mock.calls.length === 3
      ? { ...BLOCK, hash: `0x${'b'.repeat(64)}` }
      : BLOCK,
  )
  const readContract = vi.fn(async (args: { address: Address; functionName: string }) => {
    switch (args.functionName) {
      case 'asset':
        return options.wrongAsset ? HOLDER : USDE
      case 'silo':
        return options.wrongSilo ? HOLDER : SILO
      case 'decimals':
        return 18
      case 'cooldownDuration':
        return options.duration ?? 86_400
      case 'balanceOf':
        if (args.address === USDE) {
          return 'siloUsdeBalance' in options
            ? options.siloUsdeBalance
            : 17_000_000_000_000_000_000n
        }
        return 5_000_000_000_000_000_000n
      case 'maxWithdraw':
        return options.maxWithdraw ?? 5_000_000_000_000_000_000n
      case 'previewWithdraw':
        return 900_000_000_000_000_000n
      case 'previewRedeem':
        if (options.activeEntitlementError) throw new Error('optional getter failed')
        return 'activeEntitlement' in options
          ? options.activeEntitlement
          : 5_500_000_000_000_000_000n
      case 'cooldowns':
        return [options.queueEnd ?? 0n, options.queueAmount ?? 0n]
      default:
        throw new Error('unexpected read')
    }
  })
  const call = vi.fn(async (args: { data: string }) => {
    if (options.rpcError) throw new Error('secret RPC transport failed')
    const claim = args.data.slice(0, 10) === CLAIM_SELECTOR
    const directWithdrawal = args.data.slice(0, 10) === DIRECT_WITHDRAWAL_SELECTOR
    if (
      (claim && options.claimRevert) ||
      (directWithdrawal && options.directWithdrawalRevert) ||
      (!claim && !directWithdrawal && options.initiationRevert)
    ) {
      throw Object.assign(new Error('execution reverted'), {
        name: 'ContractFunctionRevertedError',
      })
    }
    return claim
      ? { data: '0x' }
      : {
          data: `0x${(directWithdrawal
            ? (options.directWithdrawalSharesBurned ?? 900_000_000_000_000_000n)
            : 900_000_000_000_000_000n
          )
            .toString(16)
            .padStart(64, '0')}`,
        }
  })
  const client = {
    getChainId: vi.fn(async () => 1),
    getBlock,
    request: vi.fn(async () => ('holderCode' in options ? options.holderCode : '0x')),
    readContract,
    call,
  } as unknown as SusdeCooldownExitClient
  return { client, getBlock, readContract, call }
}

describe('sUSDe holder cooldown exit quote', () => {
  it('does not read full active entitlement unless capacity facts are requested', async () => {
    const { client, readContract } = mockClient()
    const result = await readSusdeCooldownExitQuote(client, REQUEST, NOW)
    expect(result.susdeHolderFacts).toBeUndefined()
    expect(readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'previewRedeem' }),
    )
  })

  it('converts the full active shares after their read, pins the source, and separates queued M', async () => {
    const { client, readContract } = mockClient({
      queueAmount: 2_000_000_000_000_000_000n,
      queueEnd: BLOCK.timestamp + 10_000n,
    })
    const result = await readSusdeCooldownExitQuote(client, REQUEST, NOW, {
      includeCapacityFacts: true,
    })
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VAULT,
        functionName: 'previewRedeem',
        args: [5_000_000_000_000_000_000n],
        blockHash: BLOCK.hash,
        requireCanonical: true,
      }),
    )
    const functionNames = readContract.mock.calls.map(([args]) => args.functionName)
    expect(functionNames.indexOf('previewRedeem')).toBeGreaterThan(
      functionNames.indexOf('balanceOf'),
    )
    expect(result.susdeHolderFacts).toEqual({
      owner: HOLDER,
      originAgreement: 'not_compared',
      status: 'observed',
      activeSharesRaw: '5000000000000000000',
      activeEntitlementRaw: '5500000000000000000',
      method: 'preview_redeem_full_active_position',
      semanticQualification: 'UNQUALIFIED',
      sourceQualification: 'UNQUALIFIED',
      ceilingQualification: 'getter_only_not_callability',
      source: {
        chainId: 1,
        vaultAddress: VAULT,
        assetAddress: USDE,
        blockNumber: Number(BLOCK.number),
        blockHash: BLOCK.hash,
        blockTime: new Date(Number(BLOCK.timestamp) * 1000).toISOString(),
      },
      pendingAssetsRaw: '2000000000000000000',
      storedCooldownEndUnix: String(BLOCK.timestamp + 10_000n),
      cooldownDurationSeconds: '86400',
      maxInitiationAssetsRaw: '5000000000000000000',
    })
    expect(result.susdeHolderFacts?.activeEntitlementRaw).not.toBe(result.request.assetsRaw)
    expect(result.forecast.prospectiveValidated).toBe(false)
    expect(() => JSON.stringify(result.susdeHolderFacts)).not.toThrow()
  })

  it('retains a valid zero full active entitlement', async () => {
    const { client } = mockClient({ activeEntitlement: 0n })
    const result = await readSusdeCooldownExitQuote(client, REQUEST, NOW, {
      includeCapacityFacts: true,
    })
    expect(result.susdeHolderFacts).toMatchObject({
      status: 'observed',
      activeEntitlementRaw: '0',
      semanticQualification: 'UNQUALIFIED',
    })
  })

  it.each([
    { activeEntitlementError: true },
    { activeEntitlement: -1n },
    { activeEntitlement: 1n << 256n },
    { activeEntitlement: '0' },
  ])('keeps the core quote usable when the optional conversion is unknown', async (options) => {
    const { client } = mockClient(options)
    const result = await readSusdeCooldownExitQuote(client, REQUEST, NOW, {
      includeCapacityFacts: true,
    })
    expect(result.susdeHolderFacts).toMatchObject({
      status: 'unknown_active_entitlement',
      activeEntitlementRaw: null,
      sourceQualification: 'UNQUALIFIED',
    })
    expect(result.initiation.status).toBe('success')
    expect(result.canInitiateNow).toBe(true)
    expect(result.forecast.futureExit).toBe('unavailable')
  })

  it('reports maxWithdraw as only the ceiling for the active duration phase', async () => {
    const { client } = mockClient({ duration: 0 })
    const result = await readSusdeCooldownExitQuote(client, REQUEST, NOW, {
      includeCapacityFacts: true,
    })
    expect(result.susdeHolderFacts?.maxDirectWithdrawalAssetsRaw).toBe('5000000000000000000')
    expect(result.susdeHolderFacts).not.toHaveProperty('maxInitiationAssetsRaw')
    expect(result.directWithdrawal?.status).toBe('success')
  })

  it('accepts only the exact route and vault', () => {
    expect(resolveSusdeCooldownExitTarget(REQUEST.routeKey, VAULT).silo).toBe(SILO)
    expect(() => resolveSusdeCooldownExitTarget(REQUEST.routeKey, HOLDER)).toThrow('target_unknown')
    expect(() => resolveSusdeCooldownExitTarget('USDe → other', VAULT)).toThrow('target_unknown')
  })

  it('pins owner initiation and reports a new request as a queue reset, not a completed exit', async () => {
    const { client, getBlock, readContract, call } = mockClient({
      queueAmount: 2_000_000_000_000_000_000n,
      queueEnd: BLOCK.timestamp + 10_000n,
    })
    const reading = await readSusdeCooldownExitQuote(client, REQUEST, NOW)
    expect(reading.status).toBe('checked_at_finalized_block')
    expect(reading.canInitiateNow).toBe(true)
    expect(reading.canClaimNow).toBe(false)
    expect(reading.claim.status).toBe('not_yet_eligible')
    expect(reading.newRequestWouldResetPending).toBe(true)
    expect(reading.currentClaimEarliestAt).toBe(
      new Date(Number(BLOCK.timestamp + 10_000n) * 1000).toISOString(),
    )
    expect(reading.ifInitiatedAtCheckedBlockEarliestAt).toBe(
      new Date(Number(BLOCK.timestamp + 86_400n) * 1000).toISOString(),
    )
    expect(reading.forecast.futureExit).toBe('unavailable')
    expect(reading.aggregateSiloUsde).toEqual({
      balanceRaw: '17000000000000000000',
      balance: '17',
    })
    expect(reading.position.sharesRaw).toBe('5000000000000000000')
    expect(reading.position.maxInitiationAssetsRaw).toBe('5000000000000000000')
    expect(reading.pending.assetsRaw).toBe('2000000000000000000')
    expect(getBlock).toHaveBeenCalledTimes(3)
    expect(call).toHaveBeenCalledTimes(1)
    expect(client.request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [HOLDER, { blockHash: BLOCK.hash, requireCanonical: true }],
    })
    expect(call.mock.calls[0][0]).toMatchObject({
      account: HOLDER,
      blockHash: BLOCK.hash,
      requireCanonical: true,
    })
    expect(call.mock.calls[0][0].data.slice(0, 10)).toBe('0xcdac52ed')
    expect(
      decodeFunctionData({
        abi: CALL_ABI,
        data: call.mock.calls[0][0].data as `0x${string}`,
      }),
    ).toEqual({ functionName: 'cooldownAssets', args: [1_000_000_000_000_000_000n] })
    expect(
      readContract.mock.calls.every(
        ([args]) =>
          (args as never as { blockHash: string; requireCanonical: boolean }).blockHash ===
            BLOCK.hash &&
          (args as never as { blockHash: string; requireCanonical: boolean }).requireCanonical ===
            true,
      ),
    ).toBe(true)
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: USDE,
        functionName: 'balanceOf',
        args: [SILO],
        blockHash: BLOCK.hash,
        requireCanonical: true,
      }),
    )
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VAULT,
        functionName: 'balanceOf',
        args: [HOLDER],
        blockHash: BLOCK.hash,
        requireCanonical: true,
      }),
    )
    expect(JSON.stringify(reading)).not.toContain(HOLDER)
  })

  it('simulates the mature queue claim separately, with full queued assets', async () => {
    const { client, call } = mockClient({
      queueAmount: 3_000_000_000_000_000_000n,
      queueEnd: BLOCK.timestamp - 1n,
    })
    const reading = await readSusdeCooldownExitQuote(client, REQUEST, NOW)
    expect(reading.canClaimNow).toBe(true)
    expect(reading.claim).toEqual({ status: 'success' })
    expect(reading.pending.assetsRaw).toBe('3000000000000000000')
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[1][0]).toMatchObject({
      account: HOLDER,
      to: VAULT,
      blockHash: BLOCK.hash,
    })
  })

  it('treats a future-dated queue as immediately claimable when cooldown is disabled', async () => {
    const { client, call } = mockClient({
      duration: 0,
      queueAmount: 3_000_000_000_000_000_000n,
      queueEnd: BLOCK.timestamp + 86_400n,
    })
    const reading = await readSusdeCooldownExitQuote(client, REQUEST, NOW)
    expect(reading.exitMode).toBe('direct_withdrawal')
    expect(reading.source.method).toBe(
      'eth_call_direct_withdraw_and_pending_claim_at_finalized_block',
    )
    expect(reading.initiation).toEqual({ status: 'not_applicable' })
    expect(reading.canInitiateNow).toBe(false)
    expect(reading.directWithdrawal).toEqual({
      status: 'success',
      sharesBurnedRaw: '900000000000000000',
    })
    expect(reading.canWithdrawNow).toBe(true)
    expect(reading.position.maxInitiationAssetsRaw).toBe('0')
    expect(reading.position.maxDirectWithdrawalAssetsRaw).toBe('5000000000000000000')
    expect(reading.ifInitiatedAtCheckedBlockEarliestAt).toBeNull()
    expect(reading.newRequestWouldResetPending).toBe(false)
    expect(reading.pending.cooldownEnd).toBe(
      new Date(Number(BLOCK.timestamp + 86_400n) * 1000).toISOString(),
    )
    expect(reading.currentClaimEarliestAt).toBe(
      new Date(Number(BLOCK.timestamp) * 1000).toISOString(),
    )
    expect(reading.canClaimNow).toBe(true)
    expect(reading.claim).toEqual({ status: 'success' })
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[0][0]).toMatchObject({
      account: HOLDER,
      to: VAULT,
      blockHash: BLOCK.hash,
      requireCanonical: true,
    })
    expect(call.mock.calls[0][0].data).toHaveLength(202)
    expect(
      decodeFunctionData({
        abi: CALL_ABI,
        data: call.mock.calls[0][0].data as `0x${string}`,
      }),
    ).toEqual({
      functionName: 'withdraw',
      args: [1_000_000_000_000_000_000n, HOLDER, HOLDER],
    })
    expect(call.mock.calls[1][0].data).toHaveLength(74)
  })

  it('keeps direct Q withdrawal and existing-queue claim failures independent', async () => {
    const { client, call } = mockClient({
      duration: 0,
      queueAmount: 1n,
      queueEnd: BLOCK.timestamp + 86_400n,
      directWithdrawalRevert: true,
    })
    const reading = await readSusdeCooldownExitQuote(client, REQUEST, NOW)
    expect(reading.directWithdrawal?.status).toBe('evm_revert')
    expect(reading.canWithdrawNow).toBe(false)
    expect(reading.claim.status).toBe('success')
    expect(reading.canClaimNow).toBe(true)
    expect(call).toHaveBeenCalledTimes(2)

    const claimRevert = await readSusdeCooldownExitQuote(
      mockClient({
        duration: 0,
        queueAmount: 1n,
        queueEnd: BLOCK.timestamp + 86_400n,
        claimRevert: true,
      }).client,
      REQUEST,
      NOW,
    )
    expect(claimRevert.directWithdrawal?.status).toBe('success')
    expect(claimRevert.claim.status).toBe('evm_revert')
    expect(claimRevert.canClaimNow).toBe(false)
  })

  it('has no queue claim when cooldown is disabled and pending assets are zero', async () => {
    const { client, call } = mockClient({ duration: 0 })
    const reading = await readSusdeCooldownExitQuote(client, REQUEST, NOW)
    expect(reading.directWithdrawal?.status).toBe('success')
    expect(reading.claim.status).toBe('no_pending_claim')
    expect(reading.currentClaimEarliestAt).toBeNull()
    expect(call).toHaveBeenCalledOnce()
  })

  it('rejects inconsistent direct withdrawal evidence at the pinned block', async () => {
    for (const options of [
      { duration: 0, directWithdrawalSharesBurned: 800_000_000_000_000_000n },
      { duration: 0, maxWithdraw: 1n },
    ]) {
      const { client, call } = mockClient(options)
      await expect(readSusdeCooldownExitQuote(client, REQUEST, NOW)).rejects.toThrow(
        'susde_exit_direct_withdrawal_result_invalid',
      )
      expect(call).toHaveBeenCalledOnce()
    }
  })

  it('keeps initiation and mature claim failures distinct', async () => {
    const initiation = await readSusdeCooldownExitQuote(
      mockClient({ initiationRevert: true, queueAmount: 1n, queueEnd: BLOCK.timestamp + 10n })
        .client,
      REQUEST,
      NOW,
    )
    expect(initiation.canInitiateNow).toBe(false)
    expect(initiation.newRequestWouldResetPending).toBe(false)
    const claim = await readSusdeCooldownExitQuote(
      mockClient({ claimRevert: true, queueAmount: 1n, queueEnd: BLOCK.timestamp - 10n }).client,
      REQUEST,
      NOW,
    )
    expect(claim.canInitiateNow).toBe(true)
    expect(claim.canClaimNow).toBe(false)
    expect(claim.claim.status).toBe('evm_revert')
  })

  it('accepts an empty EOA code read returned as raw 0x', async () => {
    const reading = await readSusdeCooldownExitQuote(
      mockClient({ holderCode: '0x' }).client,
      REQUEST,
      NOW,
    )
    expect(reading.canInitiateNow).toBe(true)
    expect(reading.forecast.futureExit).toBe('unavailable')
  })

  it('simulates initiation for an exact EIP-7702 delegated EOA without claiming exit', async () => {
    const { client, call } = mockClient({ holderCode: DELEGATED_EOA_CODE })
    const reading = await readSusdeCooldownExitQuote(client, REQUEST, NOW)
    expect(reading.canInitiateNow).toBe(true)
    expect(reading.canClaimNow).toBe(false)
    expect(reading.forecast.futureExit).toBe('unavailable')
    expect(call).toHaveBeenCalledOnce()
  })

  it('rejects a missing raw holder-code response before simulation', async () => {
    const { client, call } = mockClient({ holderCode: undefined })
    await expect(readSusdeCooldownExitQuote(client, REQUEST, NOW)).rejects.toThrow(
      'susde_exit_holder_unavailable',
    )
    expect(call).not.toHaveBeenCalled()
  })

  it.each([undefined, null, -1n, 1, 1n << 256n])(
    'fails closed when the pinned silo USDe balance is invalid: %s',
    async (siloUsdeBalance) => {
      const { client, call } = mockClient({ siloUsdeBalance })
      await expect(readSusdeCooldownExitQuote(client, REQUEST, NOW)).rejects.toThrow(
        'susde_exit_identity_or_state_invalid',
      )
      expect(call).not.toHaveBeenCalled()
    },
  )

  it('does not read silo cash when the pinned vault identity is invalid', async () => {
    const { client, readContract } = mockClient({ wrongSilo: true })
    await expect(readSusdeCooldownExitQuote(client, REQUEST, NOW)).rejects.toThrow(
      'susde_exit_identity_or_state_invalid',
    )
    expect(
      readContract.mock.calls.some(
        ([args]) => args.address === USDE && args.functionName === 'balanceOf',
      ),
    ).toBe(false)
  })

  it('fails closed on identity, cooldown mode, block hash, and provider errors', async () => {
    for (const options of [
      { wrongAsset: true },
      { wrongSilo: true },
      { changedHash: true },
      { holderCode: '0x6000' },
      { maxWithdraw: 1n },
    ]) {
      await expect(
        readSusdeCooldownExitQuote(mockClient(options).client, REQUEST, NOW),
      ).rejects.toThrow()
    }
    await expect(
      readSusdeCooldownExitQuote(mockClient({ rpcError: true }).client, REQUEST, NOW),
    ).rejects.toThrow('secret RPC')
    await expect(
      readSusdeCooldownExitQuote(mockClient().client, { ...REQUEST, assetsRaw: '0' }, NOW),
    ).rejects.toThrow('request_invalid')
    await expect(
      readSusdeCooldownExitQuote(mockClient().client, REQUEST, NOW + 3 * 60 * 60 * 1000),
    ).rejects.toThrow('finalized_block_unavailable')
  })
})
