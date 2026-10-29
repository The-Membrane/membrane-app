import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, fallback, http, parseAbi, type Address, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'

import { ltFromConfig } from '@/components/LiquidationMap/xrayLogic'
import type { LayersDoc } from '@/components/LiquidationMap/liqmapLogic'
import type { Bar, RateParams } from '@/components/LiquidationMap/marketsLogic'

// Shared Aave V3 Ethereum read path for /api/xray and /api/aave-markets
// (board Q26-TERMINAL-APP). LIVE reads at request time from keyless public RPC
// (plus RECORDER_RPC_URL when set); Binance public klines for price history.
// Server-only. Nothing is modelled here.

export const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as Address // Aave V3 Ethereum core

export const POOL_ABI = parseAbi([
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
const ORACLE_ABI = parseAbi([
  'function getAssetsPrices(address[]) view returns (uint256[])',
  'function getSourceOfAsset(address) view returns (address)',
])
const FEED_ABI = parseAbi([
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
])
const STRATEGY_ABI = parseAbi([
  'function getInterestRateData(address) view returns (uint256,uint256,uint256,uint256)',
])
export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
])

export type MarketReserve = {
  asset: Address
  symbol: string
  decimals: number
  id: number
  ltBps: number
  aToken: Address
  vDebt: Address
  strategy: Address
  price: bigint // oracle, base 1e8
  supplyApr: number
  borrowApr: number
}
export type Market = { block: bigint; at: number; oracle: Address; reserves: MarketReserve[] }

let client: PublicClient | null = null
export function getClient(): PublicClient {
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

// Keyless endpoint that serves past-block eth_call (checked 2026-10-29).
let archive: PublicClient | null = null
function getArchiveClient(): PublicClient {
  archive ??= createPublicClient({
    chain: mainnet,
    transport: http('https://mainnet.gateway.tenderly.co', { timeout: 20_000 }),
  }) as PublicClient
  return archive
}

let market: Market | null = null
const MARKET_TTL_MS = 60_000

export async function readMarket(c: PublicClient = getClient()): Promise<Market> {
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
        strategy: t[11],
        price: prices[i],
        supplyApr: Number(t[2]) / 1e27,
        borrowApr: Number(t[4]) / 1e27,
      },
    ]
  })
  market = { block, at: Date.now(), oracle, reserves }
  return market
}

/** Oracle prices about `days` ago (archive read). Keyed by asset. */
export async function readPastPrices(m: Market, days = 30): Promise<Map<Address, bigint>> {
  const blockNumber = m.block - BigInt(Math.round((days * 86_400) / 12))
  const list = m.reserves.map((r) => r.asset)
  const p = await getArchiveClient().readContract({
    address: m.oracle,
    abi: ORACLE_ABI,
    functionName: 'getAssetsPrices',
    args: [list],
    blockNumber,
  })
  return new Map(list.map((a, i) => [a, p[i]]))
}

export type ReserveDetail = {
  feed: string | null
  feedUpdatedAt: number | null
  supplied: bigint | null
  available: bigint | null
  debt: bigint | null
  rate: RateParams | null
}

let details: { at: number; block: bigint; byAsset: Map<Address, ReserveDetail> } | null = null

export async function readReserveDetails(m: Market, c: PublicClient = getClient()) {
  if (details && details.block === m.block) return details.byAsset
  const R = m.reserves
  const src = await c.multicall({
    contracts: R.map(
      (r) =>
        ({
          address: m.oracle,
          abi: ORACLE_ABI,
          functionName: 'getSourceOfAsset',
          args: [r.asset],
        }) as const,
    ),
    blockNumber: m.block,
  })
  const feedAddr = src.map((s) => (s.status === 'success' ? (s.result as Address) : null))
  const calls = R.flatMap((r, i) => {
    const f = feedAddr[i] ?? r.asset
    return [
      { address: f, abi: FEED_ABI, functionName: 'description' } as const,
      { address: f, abi: FEED_ABI, functionName: 'latestRoundData' } as const,
      { address: r.aToken, abi: ERC20_ABI, functionName: 'totalSupply' } as const,
      { address: r.asset, abi: ERC20_ABI, functionName: 'balanceOf', args: [r.aToken] } as const,
      { address: r.vDebt, abi: ERC20_ABI, functionName: 'totalSupply' } as const,
      {
        address: r.strategy,
        abi: STRATEGY_ABI,
        functionName: 'getInterestRateData',
        args: [r.asset],
      } as const,
    ]
  })
  const res = await c.multicall({ contracts: calls, blockNumber: m.block })
  const byAsset = new Map<Address, ReserveDetail>()
  R.forEach((r, i) => {
    const g = res.slice(6 * i, 6 * i + 6)
    const ok = <T>(k: number) => (g[k].status === 'success' ? (g[k].result as T) : null)
    const round = ok<readonly [bigint, bigint, bigint, bigint, bigint]>(1)
    const ir = ok<readonly [bigint, bigint, bigint, bigint]>(5)
    byAsset.set(r.asset, {
      feed: feedAddr[i] ? ok<string>(0) : null,
      feedUpdatedAt: round ? Number(round[3]) : null,
      supplied: ok<bigint>(2),
      available: ok<bigint>(3),
      debt: ok<bigint>(4),
      rate: ir
        ? {
            opt: Number(ir[0]) / 1e27,
            base: Number(ir[1]) / 1e27,
            s1: Number(ir[2]) / 1e27,
            s2: Number(ir[3]) / 1e27,
          }
        : null,
    })
  })
  details = { at: Date.now(), block: m.block, byAsset }
  return byAsset
}

// Binance spot symbol for an Aave reserve symbol (D14 III_SYMBOL subset).
export const BINANCE_SYMBOL: Record<string, string> = {
  WETH: 'ETHUSDT',
  WBTC: 'BTCUSDT',
  cbBTC: 'BTCUSDT',
  tBTC: 'BTCUSDT',
  LINK: 'LINKUSDT',
  AAVE: 'AAVEUSDT',
  UNI: 'UNIUSDT',
  CRV: 'CRVUSDT',
  LDO: 'LDOUSDT',
  ENS: 'ENSUSDT',
  MKR: 'MKRUSDT',
  SNX: 'SNXUSDT',
  BAL: 'BALUSDT',
}
const BINANCE = 'https://data-api.binance.vision/api/v3'

export async function readSpot(symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  await Promise.all(
    [...new Set(symbols)].map(async (s) => {
      try {
        const r = await fetch(`${BINANCE}/ticker/price?symbol=${s}`)
        if (r.ok) out[s] = Number(((await r.json()) as { price: string }).price)
      } catch {
        /* missing spot stays missing */
      }
    }),
  )
  return out
}

const barCache = new Map<string, { at: number; bars: Bar[] }>()

/** Closed Binance 1 d bars since 2019-01-01 (cached 6 h). */
export async function readDailyBars(symbol: string): Promise<Bar[]> {
  const hit = barCache.get(symbol)
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.bars
  const bars: Bar[] = []
  let t = Date.UTC(2019, 0, 1)
  const now = Date.now()
  for (let page = 0; page < 6; page++) {
    const r = await fetch(
      `${BINANCE}/klines?symbol=${symbol}&interval=1d&startTime=${t}&limit=1000`,
    )
    if (!r.ok) break
    const data = (await r.json()) as (string | number)[][]
    for (const k of data) {
      if (Number(k[6]) < now) bars.push({ t: Number(k[0]), close: Number(k[4]), low: Number(k[3]) })
    }
    if (data.length < 1000) break
    t = Number(data[data.length - 1][0]) + 86_400_000
  }
  barCache.set(symbol, { at: Date.now(), bars })
  return bars
}

let layers: LayersDoc | null = null
export function readLayers(): LayersDoc | null {
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
