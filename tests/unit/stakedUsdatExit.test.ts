import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Address } from 'viem'

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    keccak256: (code: string) =>
      code === '0xab'
        ? '0xec3b77f722a89eec23e7dfb2ddfe63e4d82f37adbc5f75a269ed2c82c3ad0300'
        : code === '0xcd'
          ? '0x537d27c7b1574e4ab94867b9f5719414169c5941387346bca88b84643612256d'
          : actual.keccak256(code as `0x${string}`),
  }
})

import {
  readStakedUsdatExit,
  STAKED_USDAT_IMPLEMENTATION,
  STAKED_USDAT_QUEUE,
  STAKED_USDAT_QUEUE_IMPLEMENTATION,
  STAKED_USDAT_ROUTE,
  STAKED_USDAT_VAULT,
  USDAT_ASSET,
  type StakedUsdatExitClient,
} from '@/lib/carry/stakedUsdatExit'
import { stakedUsdatRequestBody } from '@/pages/api/carry/staked-usdat-exit'

const HOLDER = '0x1111111111111111111111111111111111111111' as Address
const HASH = `0x${'a'.repeat(64)}` as const
const NOW = 1_790_815_703_000
const UPDATE_SELECTOR = keccak256(stringToHex('updateMinSharePrice(uint256,uint256)')).slice(0, 10)
const slot = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}` as `0x${string}`
const input = {
  routeKey: STAKED_USDAT_ROUTE,
  destinationAddress: STAKED_USDAT_VAULT,
  holder: HOLDER,
  sharesRaw: '10000000000000000000',
}

function client(
  options: {
    vaultImpl?: Address
    requestReverts?: boolean
    claimReverts?: boolean
    updateReverts?: boolean
    ticketRequested?: boolean
    ticketTimeUnix?: bigint
    ticketOwed?: bigint
    ticketTuple?: unknown[]
  } = {},
) {
  const readContract = vi.fn(
    async ({ address, functionName }: { address: Address; functionName: string }) => {
      switch (functionName) {
        case 'asset':
        case 'USDAT':
          return USDAT_ASSET
        case 'getWithdrawalQueue':
          return STAKED_USDAT_QUEUE
        case 'STAKED_USDAT':
          return STAKED_USDAT_VAULT
        case 'decimals':
          return address.toLowerCase() === USDAT_ASSET ? 6 : 18
        case 'paused':
          return false
        case 'balanceOf':
        case 'maxRedeem':
          return 20n * 10n ** 18n
        case 'previewRedeem':
          return 10_334_658n
        case 'ownerOf':
          return HOLDER
        case 'requests':
          return (
            options.ticketTuple ?? [
              10n * 10n ** 18n,
              options.ticketOwed ?? 0n,
              options.ticketTimeUnix ?? BigInt(NOW / 1000),
              1_040_000n,
              options.ticketRequested ? 1 : 3,
            ]
          )
        default:
          throw new Error(`unexpected ${functionName}`)
      }
    },
  )
  const mocked = {
    getChainId: vi.fn(async () => 1),
    getBlock: vi.fn(async () => ({
      number: 26_093_978n,
      hash: HASH,
      timestamp: BigInt(NOW / 1000),
    })),
    getStorageAt: vi.fn(async ({ address }: { address: Address }) =>
      slot(
        address.toLowerCase() === STAKED_USDAT_VAULT
          ? (options.vaultImpl ?? STAKED_USDAT_IMPLEMENTATION)
          : STAKED_USDAT_QUEUE_IMPLEMENTATION,
      ),
    ),
    getCode: vi.fn(async ({ address }: { address: Address }) =>
      address.toLowerCase() === STAKED_USDAT_IMPLEMENTATION ? '0xab' : '0xcd',
    ),
    readContract,
    call: vi.fn(async ({ to, data }: { to: Address; data: `0x${string}` }) => {
      if (to.toLowerCase() === STAKED_USDAT_QUEUE) {
        if (data.startsWith(UPDATE_SELECTOR)) {
          if (options.updateReverts) throw new Error('execution reverted')
          return { data: '0x' }
        }
        if (options.claimReverts) throw new Error('execution reverted')
        return { data: encodeAbiParameters(parseAbiParameters('uint256'), [10_200_000n]) }
      }
      if (options.requestReverts) throw new Error('execution reverted')
      return { data: encodeAbiParameters(parseAbiParameters('uint256'), [1670n]) }
    }),
  }
  return mocked as unknown as StakedUsdatExitClient
}

describe('Staked USDat current exit', () => {
  it('rejects mismatched routes, negative/zero sizes, and unknown fields', () => {
    expect(stakedUsdatRequestBody({ ...input, chainId: 1 })).toEqual(input)
    expect(stakedUsdatRequestBody({ ...input, sharesRaw: '0' })).toBeNull()
    expect(stakedUsdatRequestBody({ ...input, routeKey: 'USDC → Staked USDat [USDat]' })).toBeNull()
    expect(stakedUsdatRequestBody({ ...input, unrelated: true })).toBeNull()
    expect(stakedUsdatRequestBody({ ...input, requestTokenId: '1670' })).toMatchObject({
      requestTokenId: '1670',
    })
    expect(stakedUsdatRequestBody({ ...input, requestTokenId: '-1' })).toBeNull()
  })

  it('fails closed when the finalized implementation changes', async () => {
    const c = client({ vaultImpl: '0x2222222222222222222222222222222222222222' })
    const result = await readStakedUsdatExit(c, input, NOW)
    expect(result).toMatchObject({ status: 'unsupported', reason: 'deployment_changed' })
    expect(c.call).not.toHaveBeenCalled()
  })

  it('separates a simulated queue ticket from USDat and AUSD payout', async () => {
    const c = client()
    const result = await readStakedUsdatExit(c, input, NOW)
    expect(result).toMatchObject({
      status: 'observed',
      evidence: { vaultImplementation: STAKED_USDAT_IMPLEMENTATION, underlyingDecimals: 6 },
      current: {
        requestedSharesRaw: input.sharesRaw,
        request: { status: 'success', requestTokenId: '1670' },
        requestDelivery: 'queue_ticket_only',
        originalAusdConversion: 'not_assayed',
        settlementDuration: 'unestimated',
      },
    })
    expect(JSON.stringify(result)).not.toContain(HOLDER)
  })

  it('reports a reverted same-holder request even when both paused flags are false', async () => {
    const result = await readStakedUsdatExit(client({ requestReverts: true }), input, NOW)
    expect(result).toMatchObject({
      status: 'observed',
      current: { vaultPaused: false, queuePaused: false, request: { status: 'evm_revert' } },
    })
  })

  it('checks an owned existing claim independently from a reverted new request', async () => {
    const c = client({ requestReverts: true })
    const result = await readStakedUsdatExit(c, { ...input, requestTokenId: '1669' }, NOW)
    expect(result).toMatchObject({
      status: 'observed',
      current: {
        requestMinSharePriceRaw: '0',
        request: { status: 'evm_revert' },
        existingTicket: {
          tokenId: '1669',
          ownership: 'holder',
          claimSimulation: 'success',
          simulatedUsdatRaw: '10200000',
          delivery: 'not_observed',
        },
      },
    })
    expect(c.call).toHaveBeenCalledTimes(2)
  })

  it('retains the exact owned ticket request time from the pinned queue read', async () => {
    const requestedAt = BigInt(NOW / 1000) - 27n * 3600n
    const result = await readStakedUsdatExit(
      client({ ticketTimeUnix: requestedAt }),
      { ...input, requestTokenId: '1669' },
      NOW,
    )
    expect(result.current?.existingTicket?.requestedAtUnix).toBe(requestedAt.toString())
    expect(result.evidence.blockTimestamp).toBe(NOW / 1000)
  })

  it('drops invalid recorded timestamp without falsifying independentlysimulatedrequest', async () => {
    const result = await readStakedUsdatExit(
      client({ ticketTimeUnix: BigInt(NOW / 1000) + 1n }),
      { ...input, requestTokenId: '1669' },
      NOW,
    )
    expect(result.current?.existingTicket?.recordedRequest).toBeNull()
    expect(result.current?.existingTicket?.requestedAtUnix).toBeNull()
    expect(result.current?.request.status).toBe('success')
  })
  it('retains full raw owned request even when claimreverts, with no added tuple RPC', async () => {
    const c = client({ claimReverts: true, ticketOwed: 42103198n })
    const result = await readStakedUsdatExit(c, { ...input, requestTokenId: '1670' }, NOW)
    expect(result.current?.existingTicket?.recordedRequest).toEqual({
      sharesRaw18: '10000000000000000000',
      usdatOwedRaw6: '42103198',
      requestedAtUnix: String(NOW / 1000),
      minSharePriceRaw: '1040000',
      rawStatus: 3,
    })
    expect(result.current?.existingTicket?.claimSimulation).toBe('evm_revert')
    expect(
      vi.mocked(c.readContract).mock.calls.filter(([r]) => r.functionName === 'requests'),
    ).toHaveLength(1)
  })
  it.each([
    ['100', 1n, BigInt(NOW / 1000), 0n, 3],
    [1n, -1n, BigInt(NOW / 1000), 0n, 3],
    [1n, 1n, BigInt(NOW / 1000), 0n, [3]],
  ])(
    'rejects malformed native tuplechannel without changing request assay %s',
    async (...tuple) => {
      const result = await readStakedUsdatExit(
        client({ ticketTuple: tuple }),
        { ...input, requestTokenId: '1670' },
        NOW,
      )
      expect(result.current?.existingTicket?.recordedRequest).toBeNull()
      expect(result.current?.request.status).toBe('success')
    },
  )

  it('compares an owned Requested ticket limit with its checked-block net quote', async () => {
    const result = await readStakedUsdatExit(
      client({ ticketRequested: true, claimReverts: true }),
      { ...input, requestTokenId: '1602' },
      NOW,
    )
    expect(result.current?.existingTicket).toMatchObject({
      ownership: 'holder',
      claimSimulation: 'evm_revert',
      requestedLimit: {
        sharesRaw: '10000000000000000000',
        minSharePriceRaw: '1040000',
        currentQuoteUsdatRaw: '10334658',
        currentNetSharePriceRaw: '1033465',
        comparison: 'above_current_quote',
        limitUpdateSimulation: 'success',
      },
    })
  })

  it('keeps a price gate when the holder limit update simulation reverts', async () => {
    const result = await readStakedUsdatExit(
      client({ ticketRequested: true, claimReverts: true, updateReverts: true }),
      { ...input, requestTokenId: '1602' },
      NOW,
    )
    expect(result.current?.existingTicket).toMatchObject({
      claimSimulation: 'evm_revert',
      requestedLimit: {
        comparison: 'above_current_quote',
        limitUpdateSimulation: 'evm_revert',
      },
    })
  })
})
