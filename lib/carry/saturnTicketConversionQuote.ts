import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { USDAT_ASSET } from './stakedUsdatExit'

export const SATURN_CURVE_POOL = '0xf4d0cf32908b2c7f1021339c43df0f77f06896d7' as Address
export const SATURN_UNISWAP_POOL = '0xbafead7c60ea473758ed6c6021505e8bbd7e8e5d' as Address
export const SATURN_UNISWAP_QUOTER = '0x61ffe014ba17989e743c5f6cb21bf9697530b21e' as Address
export const SATURN_UNISWAP_FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984' as Address
export const SATURN_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
export const SATURN_AUSD = '0x00000000efe302beaa2b3e6e1b18d08d69a9012a' as Address
export const SATURN_UNISWAP_FEE = 100

const curveAbi = parseAbi([
  'function coins(uint256) view returns (address)',
  'function balances(uint256) view returns (uint256)',
  'function get_dy(int128,int128,uint256) view returns (uint256)',
])
const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
])
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const erc20Abi = parseAbi(['function decimals() view returns (uint8)'])
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
])
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const RAW = /^[1-9][0-9]{0,77}$/
const MAX_U256 = (1n << 256n) - 1n
export type SaturnTicketConversionQuote = {
  status: 'conditional_quote'
  usdatInputRaw: string
  usdcQuotedRaw: string
  ausdQuotedRaw: string
  curveCashUsdcRaw: string
  curveCashUsdatRaw: string
  uniswapActiveLiquidityRaw: string
  initializedTicksCrossed: number
  /** Public venue quote only: no route execution, holder approvals, slippage bound, or AUSD delivery. */
  execution: 'unassessed'
}

export type SaturnTicketQuoteClient = Pick<PublicClient, 'readContract' | 'call'>

/** Exact-size public route quote pinned to the same canonical block as an owned ticket claim. */
export async function readSaturnTicketConversionQuote(
  client: SaturnTicketQuoteClient,
  blockHash: `0x${string}`,
  usdatInputRaw: string,
): Promise<SaturnTicketConversionQuote> {
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(blockHash) ||
    !RAW.test(usdatInputRaw) ||
    BigInt(usdatInputRaw) > MAX_U256
  )
    throw new Error('saturn_ticket_quote_input_invalid')
  const pin = { blockHash, requireCanonical: true as const }
  const [
    curve0,
    curve1,
    curveCashUsdc,
    curveCashUsdat,
    token0,
    token1,
    fee,
    factoryPool,
    liquidity,
    usdatDecimals,
    usdcDecimals,
    ausdDecimals,
  ] = await Promise.all([
    client.readContract({
      address: SATURN_CURVE_POOL,
      abi: curveAbi,
      functionName: 'coins',
      args: [0n],
      ...pin,
    }),
    client.readContract({
      address: SATURN_CURVE_POOL,
      abi: curveAbi,
      functionName: 'coins',
      args: [1n],
      ...pin,
    }),
    client.readContract({
      address: SATURN_CURVE_POOL,
      abi: curveAbi,
      functionName: 'balances',
      args: [0n],
      ...pin,
    }),
    client.readContract({
      address: SATURN_CURVE_POOL,
      abi: curveAbi,
      functionName: 'balances',
      args: [1n],
      ...pin,
    }),
    client.readContract({
      address: SATURN_UNISWAP_POOL,
      abi: poolAbi,
      functionName: 'token0',
      ...pin,
    }),
    client.readContract({
      address: SATURN_UNISWAP_POOL,
      abi: poolAbi,
      functionName: 'token1',
      ...pin,
    }),
    client.readContract({
      address: SATURN_UNISWAP_POOL,
      abi: poolAbi,
      functionName: 'fee',
      ...pin,
    }),
    client.readContract({
      address: SATURN_UNISWAP_FACTORY,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [SATURN_USDC, SATURN_AUSD, SATURN_UNISWAP_FEE],
      ...pin,
    }),
    client.readContract({
      address: SATURN_UNISWAP_POOL,
      abi: poolAbi,
      functionName: 'liquidity',
      ...pin,
    }),
    client.readContract({
      address: USDAT_ASSET,
      abi: erc20Abi,
      functionName: 'decimals',
      ...pin,
    }),
    client.readContract({
      address: SATURN_USDC,
      abi: erc20Abi,
      functionName: 'decimals',
      ...pin,
    }),
    client.readContract({
      address: SATURN_AUSD,
      abi: erc20Abi,
      functionName: 'decimals',
      ...pin,
    }),
  ])
  if (
    !same(curve0, SATURN_USDC) ||
    !same(curve1, USDAT_ASSET) ||
    fee !== SATURN_UNISWAP_FEE ||
    !same(factoryPool, SATURN_UNISWAP_POOL) ||
    usdatDecimals !== 6 ||
    usdcDecimals !== 6 ||
    ausdDecimals !== 6 ||
    ![token0.toLowerCase(), token1.toLowerCase()]
      .sort()
      .every((token, i) => token === [SATURN_AUSD, SATURN_USDC].sort()[i])
  )
    throw new Error('saturn_ticket_quote_identity_mismatch')

  const usdc = await client.readContract({
    address: SATURN_CURVE_POOL,
    abi: curveAbi,
    functionName: 'get_dy',
    args: [1n, 0n, BigInt(usdatInputRaw)],
    ...pin,
  })
  if (usdc <= 0n || usdc > MAX_U256) throw new Error('saturn_ticket_quote_usdc_invalid')
  const call = await client.call({
    to: SATURN_UNISWAP_QUOTER,
    data: encodeFunctionData({
      abi: quoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: SATURN_USDC,
          tokenOut: SATURN_AUSD,
          amountIn: usdc,
          fee: SATURN_UNISWAP_FEE,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
    ...pin,
  })
  if (!call.data) throw new Error('saturn_ticket_quote_empty')
  const [ausd, , ticks] = decodeFunctionResult({
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    data: call.data,
  })
  if (ausd <= 0n) throw new Error('saturn_ticket_quote_ausd_invalid')
  return {
    status: 'conditional_quote',
    usdatInputRaw,
    usdcQuotedRaw: usdc.toString(),
    ausdQuotedRaw: ausd.toString(),
    curveCashUsdcRaw: curveCashUsdc.toString(),
    curveCashUsdatRaw: curveCashUsdat.toString(),
    uniswapActiveLiquidityRaw: liquidity.toString(),
    initializedTicksCrossed: ticks,
    execution: 'unassessed',
  }
}
