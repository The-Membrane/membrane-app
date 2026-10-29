import fs from 'node:fs'
import path from 'node:path'
import type { NextApiRequest, NextApiResponse } from 'next'
import {
  createPublicClient,
  fallback,
  http,
  isAddress,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'

import {
  effectiveLt,
  ltFromConfig,
  xrayMetrics,
  type XrayReserve,
} from '@/components/LiquidationMap/xrayLogic'
import { sameBand, type LayersDoc } from '@/components/LiquidationMap/liqmapLogic'

// GET /api/xray/[address] — Position X-ray for one Aave V3 Ethereum account
// (board Q26-TERMINAL-MAP). LIVE chain reads at request time; nothing modelled.
// The address is used for the read only: it is never logged or stored.

const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as Address // Aave V3 Ethereum core

const POOL_ABI = parseAbi([
  'function getReservesList() view returns (address[])',
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getUserConfiguration(address) view returns (uint256)',
  'function getUserEMode(address) view returns (uint256)',
  'function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
  'function getReserveData(address) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))',
  'function getEModeCategoryCollateralConfig(uint8) view returns ((uint16,uint16,uint16))',
  'function getEModeCategoryCollateralBitmap(uint8) view returns (uint128)',
])
const PROVIDER_ABI = parseAbi(['function getPriceOracle() view returns (address)'])
const ORACLE_ABI = parseAbi(['function getAssetsPrices(address[]) view returns (uint256[])'])
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
])

type Market = {
  block: bigint
  at: number
  reserves: {
    asset: Address
    symbol: string
    decimals: number
    id: number
    ltBps: number
    aToken: Address
    vDebt: Address
    price: bigint
  }[]
}

let client: PublicClient | null = null
function getClient(): PublicClient {
  if (client) return client
  const env = (process.env.RECORDER_RPC_URL ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  const urls = [
    ...env,
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://rpc.mevblocker.io',
  ]
  client = createPublicClient({
    chain: mainnet,
    transport: fallback(
      urls.map((u) => http(u, { timeout: 15_000 })),
      { rank: false },
    ),
  }) as PublicClient
  return client
}

let market: Market | null = null
const MARKET_TTL_MS = 60_000

async function readMarket(c: PublicClient): Promise<Market> {
  if (market && Date.now() - market.at < MARKET_TTL_MS) return market
  const block = await c.getBlockNumber()
  const [list, provider] = await Promise.all([
    c.readContract({
      address: POOL,
      abi: POOL_ABI,
      functionName: 'getReservesList',
      blockNumber: block,
    }),
    c.readContract({
      address: POOL,
      abi: POOL_ABI,
      functionName: 'ADDRESSES_PROVIDER',
      blockNumber: block,
    }),
  ])
  const oracle = await c.readContract({
    address: provider,
    abi: PROVIDER_ABI,
    functionName: 'getPriceOracle',
    blockNumber: block,
  })
  const [rd, sym, dec, prices] = await Promise.all([
    c.multicall({
      contracts: list.map(
        (a) =>
          ({ address: POOL, abi: POOL_ABI, functionName: 'getReserveData', args: [a] }) as const,
      ),
      blockNumber: block,
    }),
    c.multicall({
      contracts: list.map((a) => ({ address: a, abi: ERC20_ABI, functionName: 'symbol' }) as const),
      blockNumber: block,
    }),
    c.multicall({
      contracts: list.map(
        (a) => ({ address: a, abi: ERC20_ABI, functionName: 'decimals' }) as const,
      ),
      blockNumber: block,
    }),
    c.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: 'getAssetsPrices',
      args: [list],
      blockNumber: block,
    }),
  ])
  const reserves = list.flatMap((asset, i) => {
    const r = rd[i]
    if (r.status !== 'success') return []
    const t = r.result
    return [
      {
        asset,
        symbol: sym[i].status === 'success' ? (sym[i].result as string) : asset.slice(0, 8),
        decimals: dec[i].status === 'success' ? Number(dec[i].result) : 18,
        id: Number(t[7]),
        ltBps: ltFromConfig(t[0]),
        aToken: t[8],
        vDebt: t[10],
        price: prices[i],
      },
    ]
  })
  market = { block, at: Date.now(), reserves }
  return market
}

let layers: LayersDoc | null = null
function readLayers(): LayersDoc | null {
  if (layers) return layers
  try {
    layers = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'public/data/liquidation-map/layers.json'), 'utf8'),
    )
  } catch {
    layers = null
  }
  return layers
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const raw = String(req.query.address ?? '')
  if (!isAddress(raw)) return res.status(400).json({ error: 'not an address' })
  const user = raw as Address
  try {
    const c = getClient()
    const m = await readMarket(c)
    const [cfg, emode, acct] = await Promise.all([
      c.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: 'getUserConfiguration',
        args: [user],
      }),
      c.readContract({ address: POOL, abi: POOL_ABI, functionName: 'getUserEMode', args: [user] }),
      c.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: 'getUserAccountData',
        args: [user],
      }),
    ])
    const used = m.reserves.filter((r) => ((cfg >> BigInt(2 * r.id)) & 3n) !== 0n)
    let em: { ltBps: number; bitmap: bigint } | null = null
    if (emode > 0n) {
      const [conf, bm] = await Promise.all([
        c.readContract({
          address: POOL,
          abi: POOL_ABI,
          functionName: 'getEModeCategoryCollateralConfig',
          args: [Number(emode)],
        }),
        c.readContract({
          address: POOL,
          abi: POOL_ABI,
          functionName: 'getEModeCategoryCollateralBitmap',
          args: [Number(emode)],
        }),
      ])
      em = { ltBps: Number(conf[1]), bitmap: bm }
    }
    const bals = await c.multicall({
      contracts: used.flatMap((r) => [
        { address: r.aToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [user] } as const,
        { address: r.vDebt, abi: ERC20_ABI, functionName: 'balanceOf', args: [user] } as const,
      ]),
    })
    const reserves: XrayReserve[] = used.map((r, j) => {
      const isColl = ((cfg >> BigInt(2 * r.id + 1)) & 1n) === 1n
      const a = bals[2 * j].status === 'success' ? (bals[2 * j].result as bigint) : 0n
      const d = bals[2 * j + 1].status === 'success' ? (bals[2 * j + 1].result as bigint) : 0n
      const px = Number(r.price) / 1e8
      const unit = 10 ** r.decimals
      return {
        symbol: r.symbol,
        priceUsd: px,
        lt: effectiveLt(r.ltBps, r.id, em),
        collateralUsd: isColl ? (Number(a) / unit) * px : 0,
        debtUsd: (Number(d) / unit) * px,
      }
    })
    const x = xrayMetrics(reserves)
    const doc = readLayers()
    const crowd =
      doc && x.bandIndex !== null
        ? sameBand(doc, 'ethereum', x.riskType, x.mainCollateral, x.bandIndex)
        : null
    const aaveHf = acct[5] >= 2n ** 255n ? null : Number(acct[5]) / 1e18
    res.setHeader('Cache-Control', 'private, max-age=30')
    return res.status(200).json({
      chain: 'ethereum',
      readAt: new Date().toISOString(),
      marketBlock: Number(m.block),
      source: 'Aave V3 Ethereum Pool + AaveOracle, live reads',
      kind: 'measured',
      ...x,
      healthFactorAave: aaveHf,
      eMode: Number(emode),
      sameBand: crowd
        ? { ...crowd, asOf: doc?.chains.find((ch) => ch.chain === 'ethereum')?.readAt }
        : null,
      reserves: reserves.map((r) => ({
        symbol: r.symbol,
        collateralUsd: r.collateralUsd,
        debtUsd: r.debtUsd,
        lt: r.lt,
      })),
    })
  } catch {
    return res.status(502).json({ error: 'chain read failed' })
  }
}
