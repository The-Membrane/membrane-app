import type { NextApiRequest, NextApiResponse } from 'next'
import { parseAbi, type Address } from 'viem'

import { cometApr, rankQuotes, type VenueQuote } from '@/components/LiquidationMap/marketsLogic'
import {
  POOL,
  SPARK_POOL,
  getClient,
  readMarket,
  readReserveDetails,
} from '@/pages/api/_lib/aaveReads'

// GET /api/borrow-rates — where each asset is cheapest to borrow right now on
// Ethereum: Aave V3, SparkLend and Compound v3, with the cash available to
// borrow at each. LIVE reads; protocol-scoped. Rates are variable and move with
// utilization: a quote, not a fixed price.

const ASSETS = ['USDC', 'USDT', 'DAI', 'USDS', 'WETH', 'WBTC', 'wstETH', 'cbBTC']

const COMETS: { asset: string; address: Address }[] = [
  { asset: 'USDC', address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3' },
  { asset: 'WETH', address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94' },
  { asset: 'USDT', address: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840' },
]
const COMET_ABI = parseAbi([
  'function getUtilization() view returns (uint64)',
  'function getBorrowRate(uint256) view returns (uint64)',
  'function totalSupply() view returns (uint256)',
  'function totalBorrow() view returns (uint256)',
  'function decimals() view returns (uint8)',
])

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const c = getClient()
    const [aave, spark] = await Promise.all([readMarket(c, POOL), readMarket(c, SPARK_POOL)])
    const quotes: VenueQuote[] = []
    const priceOf = new Map(aave.reserves.map((r) => [r.symbol, Number(r.price) / 1e8]))

    for (const [venue, m] of [
      ['Aave V3', aave],
      ['Spark', spark],
    ] as const) {
      const det = await readReserveDetails(m, c)
      for (const r of m.reserves) {
        if (!ASSETS.includes(r.symbol) || r.borrowApr <= 0) continue
        const d = det.get(r.asset)
        const unit = 10 ** r.decimals
        const px = Number(r.price) / 1e8
        const avail = (Number(d?.available ?? 0n) / unit) * px
        const debt = (Number(d?.debt ?? 0n) / unit) * px
        quotes.push({
          asset: r.symbol,
          venue,
          borrowApr: r.borrowApr,
          availableUsd: avail,
          utilization: debt + avail > 0 ? debt / (debt + avail) : null,
        })
      }
    }

    await Promise.all(
      COMETS.map(async ({ asset, address }) => {
        try {
          const [u, sup, bor, dec] = await Promise.all([
            c.readContract({ address, abi: COMET_ABI, functionName: 'getUtilization' }),
            c.readContract({ address, abi: COMET_ABI, functionName: 'totalSupply' }),
            c.readContract({ address, abi: COMET_ABI, functionName: 'totalBorrow' }),
            c.readContract({ address, abi: COMET_ABI, functionName: 'decimals' }),
          ])
          const rate = await c.readContract({
            address,
            abi: COMET_ABI,
            functionName: 'getBorrowRate',
            args: [u],
          })
          const px = priceOf.get(asset) ?? 0
          const unit = 10 ** Number(dec)
          quotes.push({
            asset,
            venue: 'Compound v3',
            borrowApr: cometApr(rate),
            availableUsd: (Math.max(0, Number(sup - bor)) / unit) * px,
            utilization: Number(u) / 1e18,
          })
        } catch {
          /* a failed venue is left out, never guessed */
        }
      }),
    )

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    return res.status(200).json({
      chain: 'ethereum',
      readAt: new Date().toISOString(),
      kind: 'measured',
      source: 'Aave V3 and SparkLend Pools, Compound v3 Comets (Ethereum), live reads',
      assets: rankQuotes(quotes).sort((a, b) => ASSETS.indexOf(a.asset) - ASSETS.indexOf(b.asset)),
    })
  } catch {
    return res.status(502).json({ error: 'chain read failed' })
  }
}
