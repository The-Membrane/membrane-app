import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionResult, parseAbi, type Address } from 'viem'
import {
  ORIGINAL_GHO,
  UMBRELLA_GHO_ROUTE,
  UMBRELLA_STKGHO,
  VERIFIED_STKGHO_IMPLEMENTATION,
  readUmbrellaGhoExit,
  type UmbrellaGhoExitClient,
} from '../../../lib/carry/umbrellaGhoExit'

const holder = '0x1111111111111111111111111111111111111111' as Address
const DELEGATED_EOA_CODE = `0xef0100${'2'.repeat(40)}`
const hash = `0x${'ab'.repeat(32)}` as const
const timestamp = 1_800_000_000
const request = { routeKey: UMBRELLA_GHO_ROUTE, destinationAddress: UMBRELLA_STKGHO, holder }

function fixture(
  overrides: Record<string, unknown> = {},
  implementation = VERIFIED_STKGHO_IMPLEMENTATION,
  rawOptions: { holderCode?: unknown } = {},
) {
  const reads: Record<string, unknown> = {
    asset: ORIGINAL_GHO,
    paused: false,
    balanceOf: 100n,
    totalAssets: 900n,
    totalSupply: 1000n,
    getCooldown: 86_400n,
    getUnstakeWindow: 86_400n,
    getStakerCooldown: [100n, timestamp, 86_400],
    maxRedeem: 100n,
    previewRedeem: 90n,
    previewWithdraw: 100n,
    getMaxSlashableAssets: 800n,
    ...overrides,
  }
  const calls: Array<{
    functionName?: string
    blockHash?: string
    requireCanonical?: boolean
    account?: Address
    data?: string
  }> = []
  const rawRequest = vi.fn(async () => ('holderCode' in rawOptions ? rawOptions.holderCode : '0x'))
  const client = {
    getChainId: async () => 1,
    getBlock: async () => ({ number: 26_100_000n, hash, timestamp: BigInt(timestamp) }),
    getStorageAt: async (args: { blockHash: string; requireCanonical: boolean }) => {
      expect(args).toMatchObject({ blockHash: hash, requireCanonical: true })
      return `0x${'0'.repeat(24)}${implementation.slice(2)}`
    },
    getCode: async (args: { address: Address; blockHash: string; requireCanonical: boolean }) => {
      expect(args).toMatchObject({ blockHash: hash, requireCanonical: true })
      return args.address === holder ? undefined : '0x6001'
    },
    request: rawRequest,
    readContract: async (args: {
      functionName: string
      blockHash: string
      requireCanonical: boolean
    }) => {
      calls.push(args)
      return reads[args.functionName]
    },
    call: async (args: {
      account: Address
      blockHash: string
      requireCanonical: boolean
      data: string
    }) => {
      calls.push(args)
      return {
        data: encodeFunctionResult({
          abi: parseAbi(['function redeem(uint256,address,address) returns (uint256)']),
          functionName: 'redeem',
          result: 90n,
        }),
      }
    },
  } as unknown as UmbrellaGhoExitClient
  return { client, calls, rawRequest }
}

describe('Umbrella original GHO exit state', () => {
  it('marks an exact inclusive unstake window as eligible state, never delivered GHO', async () => {
    const { client, calls } = fixture()
    const result = await readUmbrellaGhoExit(client, request, timestamp * 1000)
    expect(result.status).toBe('observed')
    if (result.status !== 'observed') return
    expect(result).toMatchObject({
      state: 'window_open',
      maxRedeemSharesRaw: '100',
      previewSharesRaw: '100',
      previewGhoRawAtBlock: '90',
      cooldownStartedAt: null,
      ifStartedAtCheckedBlockEarliestAt: timestamp + 86_400,
      originalAsset: ORIGINAL_GHO,
      delivery: 'not_observed',
      holderExecution: 'not_simulated',
      futureAmount: 'unknown_slashable',
    })
    expect(calls.every((call) => call.blockHash === hash && call.requireCanonical)).toBe(true)
  })

  it('distinguishes waiting, final window second, and expiry', async () => {
    for (const [end, maxRedeem, state] of [
      [timestamp + 1, 0n, 'waiting'],
      [timestamp - 86_400, 100n, 'window_open'],
      [timestamp - 86_401, 0n, 'window_expired'],
    ] as const) {
      const { client } = fixture({ getStakerCooldown: [100n, BigInt(end), 86_400n], maxRedeem })
      const result = await readUmbrellaGhoExit(client, request, timestamp * 1000)
      expect(result.status === 'observed' && result.state).toBe(state)
    }
  })

  it('separates never-started, paused, and zero-share states', async () => {
    const cases = [
      [{ getStakerCooldown: [0n, 0n, 0n], maxRedeem: 0n }, 'cooldown_not_started'],
      [{ paused: true, maxRedeem: 0n }, 'paused'],
      [{ balanceOf: 0n, getStakerCooldown: [0n, 0n, 0n], maxRedeem: 0n }, 'no_shares'],
    ] as const
    for (const [reads, state] of cases) {
      const { client } = fixture(reads)
      const result = await readUmbrellaGhoExit(client, request, timestamp * 1000)
      expect(result.status === 'observed' && result.state).toBe(state)
      if (state === 'paused' && result.status === 'observed') {
        expect(result.maxRedeemSharesRaw).toBe('0')
      }
    }
  })

  it('withholds state when proxy implementation or asset identity differs', async () => {
    const unknown = fixture({}, '0x2222222222222222222222222222222222222222')
    expect(await readUmbrellaGhoExit(unknown.client, request, timestamp * 1000)).toMatchObject({
      status: 'unsupported',
      reason: 'implementation_unattested',
    })
    const wrongAsset = fixture({ asset: '0x3333333333333333333333333333333333333333' })
    expect(await readUmbrellaGhoExit(wrongAsset.client, request, timestamp * 1000)).toMatchObject({
      status: 'unsupported',
      reason: 'identity_mismatch',
    })
  })

  it('rejects inconsistent window eligibility and stale blocks', async () => {
    const bad = fixture({ maxRedeem: 0n })
    expect(await readUmbrellaGhoExit(bad.client, request, timestamp * 1000)).toMatchObject({
      status: 'unsupported',
      reason: 'invalid_state',
    })
    const fresh = fixture()
    await expect(
      readUmbrellaGhoExit(fresh.client, request, timestamp * 1000 + 7_200_001),
    ).rejects.toThrow('umbrella_gho_exit_finalized_block_unavailable')
  })

  it('preserves an expired cooldown snapshot after shares are transferred away', async () => {
    const { client } = fixture({
      balanceOf: 5n,
      getStakerCooldown: [100n, timestamp - 86_401, 86_400],
      maxRedeem: 0n,
    })
    const result = await readUmbrellaGhoExit(client, request, timestamp * 1000)
    expect(result.status === 'observed' && result.state).toBe('window_expired')
  })

  it('simulates exact requested shares as the holder on the finalized hash', async () => {
    const { client, calls, rawRequest } = fixture()
    const result = await readUmbrellaGhoExit(
      client,
      { ...request, sharesRaw: '50' },
      timestamp * 1000,
    )
    expect(result.status).toBe('observed')
    if (result.status !== 'observed') return
    expect(result.amountCheck).toMatchObject({
      requested: { unit: 'shares', raw: '50' },
      sharesToRedeemRaw: '50',
      maxSlashableGhoRaw: '800',
      slashExposure: 'slashable_assets_present',
      gate: 'window_open',
      simulation: { status: 'success', ghoRaw: '90' },
      delivery: 'not_observed',
    })
    expect(calls.find((entry) => entry.account === holder)).toMatchObject({
      blockHash: hash,
      requireCanonical: true,
      account: holder,
    })
    expect(rawRequest).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [holder, { blockHash: hash, requireCanonical: true }],
    })
  })

  it('simulates an exact EIP-7702 delegated holder without implying delivery', async () => {
    const { client, rawRequest } = fixture({}, VERIFIED_STKGHO_IMPLEMENTATION, {
      holderCode: DELEGATED_EOA_CODE,
    })
    const result = await readUmbrellaGhoExit(
      client,
      { ...request, sharesRaw: '50' },
      timestamp * 1000,
    )
    expect(result.status === 'observed' && result.amountCheck).toMatchObject({
      simulation: { status: 'success' },
      delivery: 'not_observed',
    })
    expect(rawRequest).toHaveBeenCalledOnce()
  })

  it('rejects contract code and missing raw code before holder simulation', async () => {
    for (const holderCode of ['0x6001', undefined]) {
      const { client, calls } = fixture({}, VERIFIED_STKGHO_IMPLEMENTATION, { holderCode })
      await expect(
        readUmbrellaGhoExit(client, { ...request, sharesRaw: '50' }, timestamp * 1000),
      ).rejects.toThrow('umbrella_gho_exit_contract_holder_unavailable')
      expect(calls.some((entry) => entry.account === holder)).toBe(false)
    }
  })

  it('uses previewWithdraw for asset requests and marks an over-window amount', async () => {
    const { client } = fixture({ previewWithdraw: 101n, previewRedeem: 100n })
    const reverting = {
      ...client,
      call: async () => {
        throw new Error('execution reverted')
      },
    } as UmbrellaGhoExitClient
    const result = await readUmbrellaGhoExit(
      reverting,
      { ...request, assetsRaw: '90' },
      timestamp * 1000,
    )
    expect(result.status === 'observed' && result.amountCheck).toMatchObject({
      sharesToRedeemRaw: '101',
      gate: 'amount_exceeds_window',
      simulation: { status: 'evm_revert' },
    })
  })

  it('rejects invalid amounts and a changed source block hash', async () => {
    const { client } = fixture()
    await expect(
      readUmbrellaGhoExit(client, { ...request, assetsRaw: '0' }, timestamp * 1000),
    ).rejects.toThrow('umbrella_gho_exit_amount_invalid')
    await expect(
      readUmbrellaGhoExit(client, { ...request, assetsRaw: '1', sharesRaw: '1' }, timestamp * 1000),
    ).rejects.toThrow('umbrella_gho_exit_amount_invalid')
    let reads = 0
    const changed = {
      ...client,
      getBlock: async () => {
        reads++
        return {
          number: 26_100_000n,
          hash: reads === 1 ? hash : `0x${'cd'.repeat(32)}`,
          timestamp: BigInt(timestamp),
        }
      },
    } as UmbrellaGhoExitClient
    await expect(readUmbrellaGhoExit(changed, request, timestamp * 1000)).rejects.toThrow(
      'umbrella_gho_exit_block_hash_changed',
    )
  })
})
