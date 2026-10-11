import { describe, expect, it, vi } from 'vitest'
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionResult,
  parseAbi,
  type Abi,
} from 'viem'

import {
  APXUSD_ASSET,
  APXUSD_RECEIPT,
  APYUSD_ROUTE,
  APYUSD_VAULT,
  readApyUsdExit,
  type ApyUsdExitClient,
} from '@/lib/carry/apyUsdExit'

vi.mock('viem', async (original) => {
  const actual = await original<typeof import('viem')>()
  const hashes: Record<string, `0x${string}`> = {
    '0x6001': '0x748fde5d195af5984cc16c81df36137e6599c6f50f9f5113d05994c1b90ebad7',
    '0x6002': '0x76f9f10f52a301cd5472850a4ac1f5421c8bb57f126e7bd171bd9d3ae70dc30b',
    '0x6003': '0x7427a665f82e79f9e1e3a5592339de70bffab25517bbad2f7127549874fbf670',
    '0x6004': '0xae89d4b99f8590a5045c314350c7e1a0a7fdd69fd1adeb11aa554d6e2edeb1eb',
  }
  return { ...actual, keccak256: (code: `0x${string}`) => hashes[code] ?? actual.keccak256(code) }
})

const nativeReceiptAbi = parseAbi([
  'function feeCurve() view returns (uint256 minFee,uint256 maxFee,uint48 minDuration,uint48 maxDuration,uint256 curvature)',
  'function getReceipt(uint256) view returns (uint208,uint208,uint48,uint48)',
  'function claim(uint256,address) returns (uint256)',
])
const vaultAbi = parseAbi([
  'function withdrawForReceipt(uint256,address,address) returns (uint256,uint256)',
])
const hash = `0x${'a'.repeat(64)}` as const
const timestamp = 1790814551
const block = { number: 26093883n, hash, timestamp: BigInt(timestamp) }
const holder = '0x03aaa2081d2dcab61ae20bedafacf2a5e44bbbe6' as const
const createdAt = timestamp - 700_000
const claimableAt = timestamp - 440_800
const escrow = 9_000_000_000_000_000_000n
const fee = 200_000_000_000_000_000n
const claimPayout = 8_790_000_000_000_000_000n
const request = {
  routeKey: APYUSD_ROUTE,
  destinationAddress: APYUSD_VAULT,
  holder,
  assetsRaw: '1000000000000000000',
  receiptTokenId: '1000',
}
type FeeTuple = readonly [bigint, bigint, number, number, bigint]
type ReceiptTuple = readonly [bigint, bigint, number, number]
const nativeCurve: FeeTuple = [
  0n,
  34_000_000_000_000_000n,
  259_200,
  1_728_000,
  1_000_000_000_000_000_000n,
]
type NativeClientOptions = {
  curve?: FeeTuple | 'unavailable' | 'undecodable'
  position?: ReceiptTuple
  decodedCreatedAt?: unknown
  missingReceipt?: boolean
}

function nativeClient(options: NativeClientOptions = {}) {
  const vaultImplementation = '0xfd616567ecc1607f61073951a1e822f7315bb112'
  const receiptImplementation = '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
  const position: ReceiptTuple = options.position ?? [escrow, fee, createdAt, claimableAt]
  const slot = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`
  const decodedNativeGetters: string[] = []
  const decodeNative = (abi: Abi, functionName: 'feeCurve' | 'getReceipt', data: `0x${string}`) => {
    const decoded = decodeFunctionResult({ abi, functionName, data })
    decodedNativeGetters.push(functionName)
    return decoded
  }
  return {
    decodedNativeGetters,
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
    readContract: vi.fn().mockImplementation(async ({ abi, functionName }) => {
      if (functionName === 'asset') return Promise.resolve(APXUSD_ASSET)
      if (functionName === 'receipt') return Promise.resolve(APXUSD_RECEIPT)
      if (functionName === 'decimals') return Promise.resolve(18)
      if (functionName === 'balanceOf') return Promise.resolve(500_000_000_000_000_000n)
      if (functionName === 'maxWithdraw') return Promise.resolve(2_000_000_000_000_000_000n)
      if (functionName === 'previewWithdraw') return Promise.resolve(90_000_000_000_000_000n)
      if (functionName === 'paused') return Promise.resolve(false)
      if (functionName === 'feeCurve') {
        if (options.curve === 'unavailable')
          return Promise.reject(new Error('HTTP request timed out'))
        const data =
          options.curve === 'undecodable'
            ? '0x'
            : encodeFunctionResult({
                abi: nativeReceiptAbi,
                functionName: 'feeCurve',
                result: options.curve ?? nativeCurve,
              })
        return Promise.resolve(decodeNative(abi, 'feeCurve', data))
      }
      if (functionName === 'ownerOf') {
        if (options.missingReceipt) return Promise.reject(new Error('execution reverted'))
        return Promise.resolve(holder)
      }
      if (functionName === 'getReceipt') {
        const data = encodeFunctionResult({
          abi: nativeReceiptAbi,
          functionName: 'getReceipt',
          result: position,
        })
        const decoded = decodeNative(abi, 'getReceipt', data) as unknown[]
        if (Object.prototype.hasOwnProperty.call(options, 'decodedCreatedAt'))
          decoded[2] = options.decodedCreatedAt
        return Promise.resolve(decoded)
      }
      if (functionName === 'isClaimable') return Promise.resolve(true)
      if (functionName === 'previewClaim') return Promise.resolve(escrow - fee)
      throw new Error(`unexpected_${functionName}`)
    }),
    call: vi.fn().mockImplementation(({ to, account, data }) => {
      expect(account).toBe(holder)
      if (to === APYUSD_VAULT) {
        expect(
          decodeFunctionData({ abi: vaultAbi, data }).args?.map((value) =>
            typeof value === 'string' ? value.toLowerCase() : value,
          ),
        ).toEqual([BigInt(request.assetsRaw), holder, holder])
        return Promise.resolve({
          data: encodeFunctionResult({
            abi: vaultAbi,
            functionName: 'withdrawForReceipt',
            result: [90_000_000_000_000_000n, 1001n],
          }),
        })
      }
      expect(to).toBe(APXUSD_RECEIPT)
      expect(
        decodeFunctionData({ abi: nativeReceiptAbi, data }).args?.map((value) =>
          typeof value === 'string' ? value.toLowerCase() : value,
        ),
      ).toEqual([1000n, holder])
      return Promise.resolve({
        data: encodeFunctionResult({
          abi: nativeReceiptAbi,
          functionName: 'claim',
          result: claimPayout,
        }),
      })
    }),
  }
}

const read = (client: ReturnType<typeof nativeClient>) =>
  readApyUsdExit(client as unknown as ApyUsdExitClient, request, (timestamp + 49) * 1000)

describe('ApyUSD native getter facts', () => {
  it('decodes the full native fee curve and original receipt clock independently from new Q', async () => {
    const client = nativeClient()
    const result = await read(client)
    expect(client.decodedNativeGetters).toEqual(['feeCurve', 'getReceipt'])
    expect(result.current).toMatchObject({
      requestedEscrowRaw: request.assetsRaw,
      holderSharesRaw: '500000000000000000',
      maxWithdrawEscrowRaw: '2000000000000000000',
      currentFeeCurve: {
        minFeeWad: '0',
        maxFeeWad: '34000000000000000',
        minDurationSeconds: 259_200,
        maxDurationSeconds: 1_728_000,
        curvatureWad: '1000000000000000000',
      },
      existingReceipt: {
        tokenId: '1000',
        ownership: 'holder',
        escrowRaw: escrow.toString(),
        createdAt,
        claimableAt,
        currentFeeRaw: fee.toString(),
        currentPreviewPayoutRaw: (escrow - fee).toString(),
        claimSimulation: 'success',
        simulatedClaimPayoutRaw: claimPayout.toString(),
        delivery: 'not_observed',
      },
    })
    expect(result.current?.existingReceipt?.createdAt).not.toBe(claimableAt)
    expect(result.current?.existingReceipt?.createdAt).not.toBe(timestamp)
    expect(result.current?.ifInitiatedAtCheckedBlockClaimableAt).toBe(timestamp + nativeCurve[2])
  })

  it('reuses exactly the finalized canonical read plan for native getter facts', async () => {
    const client = nativeClient()
    await read(client)
    expect(client.getBlock.mock.calls.map(([args]) => args)).toEqual([
      { blockTag: 'finalized' },
      { blockNumber: block.number },
      { blockNumber: block.number },
    ])
    expect(client.readContract.mock.calls.map(([args]) => args.functionName)).toEqual([
      'asset',
      'receipt',
      'asset',
      'decimals',
      'balanceOf',
      'maxWithdraw',
      'previewWithdraw',
      'paused',
      'paused',
      'feeCurve',
      'ownerOf',
      'getReceipt',
      'isClaimable',
      'previewClaim',
    ])
    for (const method of [client.getStorageAt, client.getCode, client.readContract, client.call]) {
      for (const [args] of method.mock.calls) {
        expect(args).toMatchObject({ blockHash: hash, requireCanonical: true })
        expect(args).not.toHaveProperty('blockNumber')
        expect(args).not.toHaveProperty('blockTag')
      }
    }
    expect(client.getStorageAt).toHaveBeenCalledTimes(2)
    expect(client.getCode).toHaveBeenCalledTimes(4)
    expect(client.getChainId).toHaveBeenCalledTimes(1)
    expect(client.call).toHaveBeenCalledTimes(2)
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(client.request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [holder, { blockHash: hash, requireCanonical: true }],
    })
    for (const name of ['feeCurve', 'getReceipt']) {
      const args = client.readContract.mock.calls.find(([args]) => args.functionName === name)![0]
      expect(args.address).toBe(APXUSD_RECEIPT)
      if (name === 'getReceipt') expect(args.args).toEqual([1000n])
      else expect(args.args).toBeUndefined()
    }
  })

  it.each([
    ['zero creation clock', 0, claimableAt],
    ['creation after the finalized block', timestamp + 1, timestamp + 260_000],
    ['creation after claimability', claimableAt + 1, claimableAt],
    ['unknown claimable clock', createdAt, 0],
  ] as const)(
    'retains initiation and claim while marking %s unknown',
    async (_, clock, claimable) => {
      const client = nativeClient({ position: [escrow, fee, clock, claimable] })
      const result = await read(client)
      expect(result.current?.existingReceipt).toMatchObject({
        createdAt: null,
        escrowRaw: escrow.toString(),
        claimSimulation: 'success',
        simulatedClaimPayoutRaw: claimPayout.toString(),
      })
      expect(result.current?.initiation.status).toBe('success')
      expect(client.call).toHaveBeenCalledTimes(2)
      expect(client.decodedNativeGetters).toEqual(['feeCurve', 'getReceipt'])
    },
  )

  it.each(['unknown', -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1, null, undefined])(
    'does not accept malformed decoded creation clock %s',
    async (clock) => {
      const client = nativeClient({ decodedCreatedAt: clock })
      const result = await read(client)
      expect(result.current?.existingReceipt?.createdAt).toBeNull()
      expect(result.current?.existingReceipt?.claimSimulation).toBe('success')
      expect(result.current?.initiation.status).toBe('success')
    },
  )

  it.each([
    ['unavailable', 'unavailable'],
    ['undecodable', 'undecodable'],
    ['zero minimum duration', [0n, nativeCurve[1], 0, nativeCurve[3], nativeCurve[4]]],
    [
      'inverted fee range',
      [nativeCurve[1] + 1n, nativeCurve[1], nativeCurve[2], nativeCurve[3], nativeCurve[4]],
    ],
    ['invalid curvature', [nativeCurve[0], nativeCurve[1], nativeCurve[2], nativeCurve[3], 0n]],
  ] as const)('keeps independent assays when the native fee curve is %s', async (_, curve) => {
    const client = nativeClient({ curve })
    const result = await read(client)
    expect(result.current).toMatchObject({
      currentFeeCurve: null,
      currentMinimumClaimDelaySeconds: null,
      ifInitiatedAtCheckedBlockClaimableAt: null,
      ifInitiatedAtCheckedBlockEarliestNetRaw: null,
      ifInitiatedAtCheckedBlockMinimumFeeAt: null,
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: null,
      initiation: { status: 'success' },
      existingReceipt: {
        createdAt,
        escrowRaw: escrow.toString(),
        claimSimulation: 'success',
        simulatedClaimPayoutRaw: claimPayout.toString(),
      },
    })
    expect(client.call).toHaveBeenCalledTimes(2)
    expect(
      client.readContract.mock.calls.filter(([args]) => args.functionName === 'feeCurve'),
    ).toHaveLength(1)
  })

  it('keeps a missing receipt clock unknown without inventing a timestamp', async () => {
    const client = nativeClient({ missingReceipt: true })
    const result = await read(client)
    expect(result.current?.existingReceipt).toMatchObject({
      tokenId: '1000',
      ownership: 'not_found',
      createdAt: null,
      claimableAt: null,
      escrowRaw: null,
      claimSimulation: 'not_found',
    })
    expect(result.current?.initiation.status).toBe('success')
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})
