import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'

import {
  APYUSD_ROUTE,
  APYUSD_VAULT,
  APXUSD_ASSET,
  APXUSD_RECEIPT,
  readApyUsdExit,
  type ApyUsdExitClient,
} from '@/lib/carry/apyUsdExit'

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  const hashes: Record<string, `0x${string}`> = {
    '0x6001': '0x748fde5d195af5984cc16c81df36137e6599c6f50f9f5113d05994c1b90ebad7',
    '0x6002': '0x76f9f10f52a301cd5472850a4ac1f5421c8bb57f126e7bd171bd9d3ae70dc30b',
    '0x6003': '0x7427a665f82e79f9e1e3a5592339de70bffab25517bbad2f7127549874fbf670',
    '0x6004': '0xae89d4b99f8590a5045c314350c7e1a0a7fdd69fd1adeb11aa554d6e2edeb1eb',
  }
  return { ...actual, keccak256: (code: `0x${string}`) => hashes[code] ?? actual.keccak256(code) }
})

const vaultAbi = parseAbi([
  'function withdrawForReceipt(uint256,address,address) returns (uint256,uint256)',
])
const receiptAbi = parseAbi(['function claim(uint256,address) returns (uint256)'])

const blockHash = `0x${'a'.repeat(64)}` as const
const block = { number: 26093883n, hash: blockHash, timestamp: 1790814551n }
const holder = '0x03aaa2081d2dcab61ae20bedafacf2a5e44bbbe6' as const
const request = {
  routeKey: APYUSD_ROUTE,
  destinationAddress: APYUSD_VAULT,
  holder,
  assetsRaw: '1000000000000000000',
}

function driftedClient() {
  return {
    getChainId: vi.fn().mockResolvedValue(1),
    getBlock: vi.fn().mockResolvedValue(block),
    getStorageAt: vi.fn().mockResolvedValue(`0x${'0'.repeat(64)}`),
    getCode: vi.fn().mockResolvedValue('0x6000'),
    request: vi.fn().mockResolvedValue('0x'),
    readContract: vi.fn(),
    call: vi.fn(),
  }
}

function attestedClient(assetDecimals = 18) {
  const vaultImplementation = '0xfd616567ecc1607f61073951a1e822f7315bb112'
  const receiptImplementation = '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
  const slot = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`
  const client = {
    getChainId: vi.fn().mockResolvedValue(1),
    getBlock: vi.fn().mockResolvedValue(block),
    getStorageAt: vi
      .fn()
      .mockImplementation(({ address }) =>
        Promise.resolve(
          slot(address === APYUSD_VAULT ? vaultImplementation : receiptImplementation),
        ),
      ),
    getCode: vi
      .fn()
      .mockImplementation(({ address }) =>
        Promise.resolve(
          address === APYUSD_VAULT
            ? '0x6001'
            : address === APXUSD_RECEIPT
              ? '0x6002'
              : address === vaultImplementation
                ? '0x6003'
                : '0x6004',
        ),
      ),
    request: vi.fn().mockResolvedValue('0x'),
    readContract: vi.fn().mockImplementation(({ address, functionName }) => {
      if (functionName === 'asset') return Promise.resolve(APXUSD_ASSET)
      if (functionName === 'receipt') return Promise.resolve(APXUSD_RECEIPT)
      if (functionName === 'decimals') return Promise.resolve(assetDecimals)
      if (functionName === 'balanceOf') return Promise.resolve(100n)
      if (functionName === 'maxWithdraw') return Promise.resolve(90n)
      if (functionName === 'previewWithdraw') return Promise.resolve(4n)
      if (functionName === 'paused') return Promise.resolve(false)
      if (functionName === 'feeCurve')
        return Promise.resolve([0n, 34000000000000000n, 259200, 1728000, 1000000000000000000n])
      if (address === APXUSD_RECEIPT && functionName === 'ownerOf') return Promise.resolve(holder)
      if (functionName === 'getReceipt') return Promise.resolve([9n, 1n, 1790810000, 1790813000])
      if (functionName === 'isClaimable') return Promise.resolve(true)
      if (functionName === 'previewClaim') return Promise.resolve(8n)
      throw new Error(`unexpected_${functionName}`)
    }),
    call: vi.fn().mockImplementation(({ to, account, data }) => {
      expect(account).toBe(holder)
      if (to === APYUSD_VAULT) {
        const decoded = decodeFunctionData({ abi: vaultAbi, data })
        expect(decoded.functionName).toBe('withdrawForReceipt')
        expect(
          decoded.args?.map((value) => (typeof value === 'string' ? value.toLowerCase() : value)),
        ).toEqual([9n, holder, holder])
        return Promise.resolve({
          data: encodeFunctionResult({
            abi: vaultAbi,
            functionName: 'withdrawForReceipt',
            result: [4n, 1001n],
          }),
        })
      }
      expect(to).toBe(APXUSD_RECEIPT)
      const decoded = decodeFunctionData({ abi: receiptAbi, data })
      expect(decoded.functionName).toBe('claim')
      expect(
        decoded.args?.map((value) => (typeof value === 'string' ? value.toLowerCase() : value)),
      ).toEqual([1000n, holder])
      return Promise.resolve({
        data: encodeFunctionResult({ abi: receiptAbi, functionName: 'claim', result: 7n }),
      })
    }),
  }
  return client
}

describe('ApyUSD finalized holder assay', () => {
  it('rejects malformed target, amount and receipt ID before RPC', async () => {
    const client = driftedClient()
    await expect(
      readApyUsdExit(client as unknown as ApyUsdExitClient, {
        ...request,
        routeKey: 'some other route',
      }),
    ).rejects.toThrow('apyusd_exit_request_invalid')
    await expect(
      readApyUsdExit(client as unknown as ApyUsdExitClient, { ...request, assetsRaw: '0' }),
    ).rejects.toThrow('apyusd_exit_request_invalid')
    await expect(
      readApyUsdExit(client as unknown as ApyUsdExitClient, {
        ...request,
        receiptTokenId: '-1',
      }),
    ).rejects.toThrow('apyusd_exit_request_invalid')
    expect(client.getChainId).not.toHaveBeenCalled()
  })

  it('refuses a changed implementation before any amount or receipt read', async () => {
    const client = driftedClient()
    const result = await readApyUsdExit(
      client as unknown as ApyUsdExitClient,
      request,
      1790814600000,
    )
    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'deployment_unattested',
      evidence: { blockNumber: 26093883, blockHash },
    })
    expect(result.current).toBeUndefined()
    expect(client.readContract).not.toHaveBeenCalled()
    expect(client.call).not.toHaveBeenCalled()
  })

  it('rejects stale and changed finalized block evidence', async () => {
    const client = driftedClient()
    await expect(
      readApyUsdExit(client as unknown as ApyUsdExitClient, request, 1790824551000),
    ).rejects.toThrow('apyusd_exit_finalized_block_unavailable')
    client.getBlock
      .mockResolvedValueOnce(block)
      .mockResolvedValueOnce({ ...block, hash: `0x${'b'.repeat(64)}` })
    await expect(
      readApyUsdExit(client as unknown as ApyUsdExitClient, request, 1790814600000),
    ).rejects.toThrow('apyusd_exit_block_changed')
  })

  it('simulates receipt initiation and existing receipt claim as separate holder actions', async () => {
    const client = attestedClient()
    const result = await readApyUsdExit(
      client as unknown as ApyUsdExitClient,
      { ...request, assetsRaw: '9', receiptTokenId: '1000' },
      1790814600000,
    )
    expect(result.status).toBe('observed')
    expect(result.evidence.assetDecimals).toBe(18)
    expect(result.current).toMatchObject({
      requestedEscrowRaw: '9',
      previewSharesToBurnRaw: '4',
      initiation: { status: 'success', sharesRaw: '4', receiptTokenId: '1001' },
      currentFeeCurve: {
        minFeeWad: '0',
        maxFeeWad: '34000000000000000',
        minDurationSeconds: 259200,
        maxDurationSeconds: 1728000,
        curvatureWad: '1000000000000000000',
      },
      currentMinimumClaimDelaySeconds: 259200,
      ifInitiatedAtCheckedBlockClaimableAt: 1791073751,
      ifInitiatedAtCheckedBlockEarliestNetRaw: '8',
      ifInitiatedAtCheckedBlockMinimumFeeAt: 1792542551,
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: '9',
      payout: 'not_delivered_by_initiation',
      existingReceipt: {
        tokenId: '1000',
        ownership: 'holder',
        escrowRaw: '9',
        currentFeeRaw: '1',
        claimableNow: true,
        currentPreviewPayoutRaw: '8',
        claimSimulation: 'success',
        simulatedClaimPayoutRaw: '7',
        delivery: 'not_observed',
      },
    })
    expect(client.call).toHaveBeenCalledTimes(2)
    expect(client.request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [holder, { blockHash, requireCanonical: true }],
    })
  })

  it('allows an EIP-7702 delegated EOA to simulate initiation and claim', async () => {
    const client = attestedClient()
    client.request.mockResolvedValue(`0xef0100${'1'.repeat(40)}`)
    const result = await readApyUsdExit(
      client as unknown as ApyUsdExitClient,
      { ...request, assetsRaw: '9', receiptTokenId: '1000' },
      1790814600000,
    )
    expect(result.current?.initiation.status).toBe('success')
    expect(result.current?.existingReceipt?.claimSimulation).toBe('success')
    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it('fails closed before simulations for contract, malformed delegation, or missing holder code', async () => {
    for (const code of [
      '0x6001',
      `0xef0100${'1'.repeat(39)}`,
      `0xef0100${'1'.repeat(41)}`,
      undefined,
    ]) {
      const client = attestedClient()
      client.request.mockResolvedValue(code)
      await expect(
        readApyUsdExit(
          client as unknown as ApyUsdExitClient,
          { ...request, assetsRaw: '9', receiptTokenId: '1000' },
          1790814600000,
        ),
      ).rejects.toThrow('apyusd_exit_holder_control_unverified')
      expect(client.call).not.toHaveBeenCalled()
    }
  })

  it('refuses a live asset with noncanonical decimals before holder simulation', async () => {
    const client = attestedClient(6)
    const result = await readApyUsdExit(
      client as unknown as ApyUsdExitClient,
      request,
      1790814600000,
    )
    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'identity_mismatch',
      evidence: { assetDecimals: 6 },
    })
    expect(client.call).not.toHaveBeenCalled()
  })
})
