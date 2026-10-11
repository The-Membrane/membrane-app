import { createPublicClient, custom, encodeFunctionResult, parseAbi } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import {
  readSaturnTicketConversionQuote,
  SATURN_AUSD,
  SATURN_CURVE_POOL,
  SATURN_UNISWAP_FEE,
  SATURN_UNISWAP_FACTORY,
  SATURN_UNISWAP_POOL,
  SATURN_UNISWAP_QUOTER,
  SATURN_USDC,
} from '@/lib/carry/saturnTicketConversionQuote'
import { USDAT_ASSET } from '@/lib/carry/stakedUsdatExit'

const HASH = `0x${'a'.repeat(64)}` as const
const quoteAbi = [
  {
    type: 'function' as const,
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable' as const,
    inputs: [
      {
        name: 'params',
        type: 'tuple' as const,
        components: [
          { name: 'tokenIn', type: 'address' as const },
          { name: 'tokenOut', type: 'address' as const },
          { name: 'amountIn', type: 'uint256' as const },
          { name: 'fee', type: 'uint24' as const },
          { name: 'sqrtPriceLimitX96', type: 'uint160' as const },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' as const },
      { name: 'sqrtPriceX96After', type: 'uint160' as const },
      { name: 'initializedTicksCrossed', type: 'uint32' as const },
      { name: 'gasEstimate', type: 'uint256' as const },
    ],
  },
] as const

function fixture(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'coins:0': SATURN_USDC,
    'coins:1': USDAT_ASSET,
    'balances:0': 1000000000n,
    'balances:1': 2000000000n,
    token0: SATURN_AUSD,
    token1: SATURN_USDC,
    fee: SATURN_UNISWAP_FEE,
    getPool: SATURN_UNISWAP_POOL,
    liquidity: 3000000000n,
    decimals: 6,
    get_dy: 10100000n,
    ...overrides,
  }
  const readContract = vi.fn(
    async (args: { functionName: string; args?: readonly bigint[] }) =>
      values[`${args.functionName}:${args.args?.[0]}`] ?? values[args.functionName],
  )
  const call = vi.fn(async (_args: { data: `0x${string}` }) => ({
    data: encodeFunctionResult({
      abi: quoteAbi,
      functionName: 'quoteExactInputSingle',
      result: [10000000000000000000n, 0n, 2, 100000n],
    }),
  }))
  return { client: { readContract, call } as never, readContract, call }
}

describe('Saturn owned-ticket conversion quote', () => {
  it('actual installed SDK emits canonical EIP1898 pins for every used state method offline', async () => {
    const wire: { method: string; params: readonly unknown[] }[] = []
    const sdk = createPublicClient({
      transport: custom({
        request: async ({ method, params }) => {
          wire.push({ method, params: params as readonly unknown[] })
          if (method === 'eth_getStorageAt') return `0x${'0'.repeat(64)}`
          if (method === 'eth_getCode') return '0x1234'
          return `0x${'0'.repeat(63)}1`
        },
      }),
    })
    const pin = { blockHash: HASH, requireCanonical: true as const }
    await sdk.readContract({
      address: SATURN_USDC,
      abi: parseAbi(['function decimals() view returns (uint8)']),
      functionName: 'decimals',
      ...pin,
    })
    await sdk.call({ to: SATURN_UNISWAP_QUOTER, data: '0x12345678', ...pin })
    await sdk.getCode({ address: SATURN_UNISWAP_POOL, ...pin })
    await sdk.getStorageAt({ address: SATURN_UNISWAP_POOL, slot: `0x${'0'.repeat(64)}`, ...pin })
    expect(wire.map((x) => x.method)).toEqual([
      'eth_call',
      'eth_call',
      'eth_getCode',
      'eth_getStorageAt',
    ])
    wire.forEach((x) => expect(x.params.at(-1)).toEqual(pin))
  })
  it('quotes exact claimed USDat through identified pools at the canonical ticket block', async () => {
    const { client, readContract, call } = fixture()
    const result = await readSaturnTicketConversionQuote(client, HASH, '10200000')
    expect(result).toMatchObject({
      status: 'conditional_quote',
      usdatInputRaw: '10200000',
      usdcQuotedRaw: '10100000',
      ausdQuotedRaw: '10000000000000000000',
      initializedTicksCrossed: 2,
      execution: 'unassessed',
    })
    for (const [args] of readContract.mock.calls) {
      expect(args).toMatchObject({ blockHash: HASH, requireCanonical: true })
    }
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SATURN_CURVE_POOL,
        functionName: 'get_dy',
        args: [1n, 0n, 10200000n],
      }),
    )
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SATURN_UNISWAP_POOL,
        functionName: 'liquidity',
      }),
    )
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SATURN_UNISWAP_FACTORY,
        functionName: 'getPool',
        args: [SATURN_USDC, SATURN_AUSD, SATURN_UNISWAP_FEE],
      }),
    )
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: SATURN_UNISWAP_QUOTER,
        blockHash: HASH,
        requireCanonical: true,
      }),
    )
    const data = call.mock.calls[0][0].data as string
    expect(data).toContain(SATURN_USDC.slice(2))
    expect(data).toContain(SATURN_AUSD.slice(2))
    expect(data).toContain(SATURN_UNISWAP_FEE.toString(16).padStart(64, '0'))
  })

  it('fails closed before quoting when the live pool tokens differ', async () => {
    const { client, call } = fixture({ 'coins:1': SATURN_AUSD })
    await expect(readSaturnTicketConversionQuote(client, HASH, '10200000')).rejects.toThrow(
      'saturn_ticket_quote_identity_mismatch',
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects a different fee tier or factory pool before quoting', async () => {
    for (const values of [{ fee: 500 }, { getPool: SATURN_USDC }, { decimals: 18 }]) {
      const { client, call } = fixture(values)
      await expect(readSaturnTicketConversionQuote(client, HASH, '10200000')).rejects.toThrow(
        'saturn_ticket_quote_identity_mismatch',
      )
      expect(call).not.toHaveBeenCalled()
    }
  })

  it('rejects malformed and zero exact ticket amounts', async () => {
    const { client, readContract } = fixture()
    await expect(readSaturnTicketConversionQuote(client, HASH, '0')).rejects.toThrow(
      'saturn_ticket_quote_input_invalid',
    )
    expect(readContract).not.toHaveBeenCalled()
  })
})
