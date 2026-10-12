/**
 * Aave-v3-style readers (Aave v3, Spark): enumerate reserves, decode each asset's
 * price source into leaves, and build exposures keyed by leaf.
 *
 * getSourceOfAsset(asset) is the methodology's Aave/Spark hook. A reserve contributes:
 *  - UPSIDE (leaf is a collateral's source): deposit manipulated collateral, borrow
 *    other assets. Aave borrows from ONE shared pool, so every reserve of a pool shares
 *    a liquidityKey; borrowableUsd is the pool's total available liquidity; the attacker
 *    is bounded by the collateral's supply-cap headroom (collateralRoomUsd).
 *  - DOWNSIDE: liquidation capture needs per-borrower health, which the free data path
 *    does not give for Aave. The aggregate-edge bound over the reserve's own debt is a
 *    loose EV_hi; EV_pt downside is withheld and flagged (see README gaps).
 *
 * LTV / liquidation threshold / bonus / decimals come from the data provider; caps and
 * available liquidity from the data provider and the aToken's underlying balance. USD
 * prices from the Aave oracle (getAssetPrice, 8-decimal USD base).
 */

import type { Exposure } from '../types'
import type { BlockTag, Rpc } from '../chain/rpc'
import { fn, lower } from '../chain/abi'
import { decodeFeed, type DecodeContext, type LeafTable } from '../leaf/decode'
import { leafIds } from '../tree'

export interface AavePoolDef {
  key: string
  label: string
  pool: string
}

export const AAVE_V3: AavePoolDef = { key: 'aave-v3', label: 'Aave v3', pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' }
export const SPARK: AavePoolDef = { key: 'spark', label: 'SparkLend', pool: '0xC13e21B648A5Ee794902342038FF3aDAB66BE987' }

const ADDRESSES_PROVIDER = fn('ADDRESSES_PROVIDER()', 'address')
const GET_PRICE_ORACLE = fn('getPriceOracle()', 'address')
const GET_DATA_PROVIDER = fn('getPoolDataProvider()', 'address')
const RESERVES_LIST = fn('getReservesList()', 'address[]')
const SOURCE_OF_ASSET = fn('getSourceOfAsset(address)', 'address')
const ASSET_PRICE = fn('getAssetPrice(address)', 'uint256')
const SYMBOL = fn('symbol()', 'string')
const DECIMALS = fn('decimals()', 'uint8')
const RESERVE_CONFIG = fn('getReserveConfigurationData(address)', '(uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)')
const RESERVE_CAPS = fn('getReserveCaps(address)', '(uint256,uint256)')
const RESERVE_TOKENS = fn('getReserveTokensAddresses(address)', '(address,address,address)')
const BALANCE_OF = fn('balanceOf(address)', 'uint256')
const TOTAL_SUPPLY = fn('totalSupply()', 'uint256')

export interface AaveReserve {
  asset: string
  symbol: string
  decimals: number
  source: string | null
  priceUsd: number
  ltv: number
  liqThreshold: number
  lif: number
  borrowCapUsd: number
  supplyCapUsd: number
  availableLiquidityUsd: number
  suppliedUsd: number
  debtUsd: number
}

export interface AaveFamilyResult {
  byLeaf: Map<string, Exposure[]>
  leaves: LeafTable
  reserves: AaveReserve[]
  poolLiquidityUsd: number
  undecoded: string[]
}

export async function buildAaveFamily(
  rpc: Rpc,
  def: AavePoolDef,
  block: BlockTag,
  opts: { deviationPct?: Record<string, number>; leaves?: LeafTable } = {},
): Promise<AaveFamilyResult> {
  const leaves: LeafTable = opts.leaves ?? {}
  const prov = (await rpc.call(def.pool, ADDRESSES_PROVIDER, [], block)) as string
  const [oracle, dp] = await rpc.multicall(
    [
      { target: prov, fn: GET_PRICE_ORACLE },
      { target: prov, fn: GET_DATA_PROVIDER },
    ],
    block,
  )
  const assets = (await rpc.call(def.pool, RESERVES_LIST, [], block)) as string[]
  const sources = await rpc.multicall(assets.map((a) => ({ target: oracle as string, fn: SOURCE_OF_ASSET, args: [a] })), block)
  const prices = await rpc.multicall(assets.map((a) => ({ target: oracle as string, fn: ASSET_PRICE, args: [a] })), block)
  const syms = await rpc.multicall(assets.map((a) => ({ target: a, fn: SYMBOL })), block)
  const decs = await rpc.multicall(assets.map((a) => ({ target: a, fn: DECIMALS })), block)
  const cfgs = await rpc.multicall(assets.map((a) => ({ target: dp as string, fn: RESERVE_CONFIG, args: [a] })), block)
  const caps = await rpc.multicall(assets.map((a) => ({ target: dp as string, fn: RESERVE_CAPS, args: [a] })), block)
  const toks = await rpc.multicall(assets.map((a) => ({ target: dp as string, fn: RESERVE_TOKENS, args: [a] })), block)

  const reserves: AaveReserve[] = []
  for (let i = 0; i < assets.length; i++) {
    const cfg = cfgs[i]
    if (!cfg) continue
    const decimals = Number(cfg[0])
    const priceUsd = prices[i] !== null ? Number(prices[i]) / 1e8 : 0
    const unit = Math.pow(10, decimals)
    const tok = toks[i] as [string, string, string] | null
    reserves.push({
      asset: lower(assets[i]),
      symbol: String(syms[i] ?? '?'),
      decimals,
      source: sources[i] ? lower(sources[i] as string) : null,
      priceUsd,
      ltv: Number(cfg[1]) / 1e4,
      liqThreshold: Number(cfg[2]) / 1e4,
      lif: Number(cfg[3]) / 1e4,
      borrowCapUsd: caps[i] ? (Number((caps[i] as bigint[])[0]) * priceUsd) : 0,
      supplyCapUsd: caps[i] ? (Number((caps[i] as bigint[])[1]) * priceUsd) : 0,
      availableLiquidityUsd: tok ? 0 : 0, // filled below
      suppliedUsd: 0,
      debtUsd: 0,
    })
    // Available liquidity = underlying held by the aToken; debt = variable debt supply.
    if (tok) {
      const [bal, aSup, vSup] = await rpc.multicall(
        [
          { target: assets[i], fn: BALANCE_OF, args: [tok[0]] },
          { target: tok[0], fn: TOTAL_SUPPLY },
          { target: tok[2], fn: TOTAL_SUPPLY },
        ],
        block,
      )
      const r = reserves[reserves.length - 1]
      r.availableLiquidityUsd = bal !== null ? (Number(bal) / unit) * priceUsd : 0
      r.suppliedUsd = aSup !== null ? (Number(aSup) / unit) * priceUsd : 0
      r.debtUsd = vSup !== null ? (Number(vSup) / unit) * priceUsd : 0
    }
  }

  const poolLiquidityUsd = reserves.reduce((a, r) => a + r.availableLiquidityUsd, 0)
  const byLeaf = new Map<string, Exposure[]>()
  const undecoded: string[] = []
  const nodeCache = new Map<string, import('../types').PriceNode>()

  for (const r of reserves) {
    if (!r.source || r.ltv <= 0) continue // not usable as collateral
    const ctx: DecodeContext = { rpc, block, leaves, deviationPct: opts.deviationPct, nodeCache }
    let tree
    try {
      tree = await decodeFeed(ctx, r.source)
    } catch {
      undecoded.push(r.asset)
      continue
    }
    // Supply-cap headroom for depositing manipulated collateral.
    const room = Math.max(0, r.supplyCapUsd - r.suppliedUsd)
    const exposure: Exposure = {
      protocol: def.key === 'spark' ? 'spark' : 'aave-v3',
      id: `${def.key}:${r.symbol}`,
      label: `${def.label} ${r.symbol} (coll)`,
      role: 'collateral',
      tree,
      borrowLtv: r.ltv,
      liqLtv: r.liqThreshold,
      lif: r.lif,
      closeFactor: 0.5,
      borrowableUsd: poolLiquidityUsd,
      borrowableHiUsd: poolLiquidityUsd,
      liquidityKey: def.key, // one shared borrow pool
      collateralRoomUsd: r.supplyCapUsd > 0 ? room : Infinity,
      positions: null,
      aggregate: { collateralUsd: r.suppliedUsd, debtUsd: r.debtUsd },
      notes: ['Aave-family downside EV needs per-borrower health (not fetched); EV_pt downside withheld, see README gaps'],
    }
    for (const id of leafIds(tree)) {
      if (leaves[id]?.kind === 'linear-discount') continue
      byLeaf.set(id, [...(byLeaf.get(id) ?? []), exposure])
    }
  }

  return { byLeaf, leaves, reserves, poolLiquidityUsd, undecoded }
}
