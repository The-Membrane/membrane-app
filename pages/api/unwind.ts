import type { NextApiRequest, NextApiResponse } from 'next'
import { parseAbi, type Address } from 'viem'

import { greedySplit } from '@/components/LiquidationMap/marketsLogic'
import { getClient, readMarket } from '@/pages/api/_lib/aaveReads'

// GET /api/unwind — what an instant exit from the largest loop collateral costs:
// a sale into WETH split greedily across Uniswap V3 (QuoterV2) and the main Curve
// pool, against the oracle's fair value, at $1M / $10M / $50M. Plus Lido's
// withdrawal-queue backlog, the slow exit. LIVE reads; cached 10 min.

const QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as Address
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address
const WEETH = '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee' as Address
const CURVE_STETH = '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022' as Address // [ETH, stETH]
const CURVE_WEETH = '0xDB74dfDD3BB46bE8Ce6C33dC9D82777BCFc3dEd5' as Address // [WETH, weETH]
const LIDO_QUEUE = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1' as Address

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
])
const CURVE_ABI = parseAbi(['function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)'])
const WST_ABI = parseAbi(['function getStETHByWstETH(uint256) view returns (uint256)'])
const QUEUE_ABI = parseAbi(['function unfinalizedStETH() view returns (uint256)'])

const SIZES = [1e6, 1e7, 5e7]

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const c = getClient()
    const m = await readMarket(c)
    const weth = m.reserves.find((r) => r.symbol === 'WETH')
    if (!weth) throw new Error('no WETH')
    const ethUsd = Number(weth.price) / 1e8
    const wei = (x: number) => BigInt(Math.floor(x * 1e18))
    const uni = (tokenIn: Address, fee: number) => async (x: number) =>
      x <= 0
        ? 0
        : Number(
            (
              await c.simulateContract({
                address: QUOTER,
                abi: QUOTER_ABI,
                functionName: 'quoteExactInputSingle',
                args: [
                  { tokenIn, tokenOut: weth.asset, amountIn: wei(x), fee, sqrtPriceLimitX96: 0n },
                ],
              })
            ).result[0],
          ) / 1e18
    const curve = (pool: Address, factor: number) => async (x: number) =>
      x <= 0
        ? 0
        : Number(
            await c.readContract({
              address: pool,
              abi: CURVE_ABI,
              functionName: 'get_dy',
              args: [1n, 0n, wei(x * factor)],
            }),
          ) / 1e18
    const stPerW =
      Number(
        await c.readContract({
          address: WSTETH,
          abi: WST_ABI,
          functionName: 'getStETHByWstETH',
          args: [10n ** 18n],
        }),
      ) / 1e18
    const queue =
      Number(
        await c.readContract({
          address: LIDO_QUEUE,
          abi: QUEUE_ABI,
          functionName: 'unfinalizedStETH',
        }),
      ) / 1e18

    const assets = [
      {
        symbol: 'wstETH',
        asset: WSTETH,
        venues: ['Uniswap 0.01%', 'Curve ETH/stETH'],
        fns: [uni(WSTETH, 100), curve(CURVE_STETH, stPerW)],
      },
      {
        symbol: 'weETH',
        asset: WEETH,
        venues: ['Uniswap 0.05%', 'Curve weETH/WETH'],
        fns: [uni(WEETH, 500), curve(CURVE_WEETH, 1)],
      },
    ]
    const rows = []
    for (const a of assets) {
      const r = m.reserves.find((x) => x.asset.toLowerCase() === a.asset.toLowerCase())
      if (!r) continue
      const ratio = Number(r.price) / Number(weth.price) // oracle fair value in WETH
      const sizes = []
      for (const usd of SIZES) {
        const units = usd / (ratio * ethUsd)
        const { out, shares } = await greedySplit(a.fns, units, 20)
        sizes.push({ usd, lossPct: 1 - out / (units * ratio), shares })
      }
      rows.push({ symbol: a.symbol, venues: a.venues, sizes })
    }
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200')
    return res.status(200).json({
      readAt: new Date().toISOString(),
      kind: 'measured',
      source:
        'Uniswap V3 QuoterV2 and Curve get_dy (Ethereum), live; fair value = Aave oracle ratio to WETH',
      rows,
      lidoQueueUsd: queue * ethUsd,
    })
  } catch {
    return res.status(502).json({ error: 'chain read failed' })
  }
}
