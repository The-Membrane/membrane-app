/**
 * Compound III (Comet) readers. Each Comet is a single-borrow-asset market; collateral
 * assets each carry a price feed, a borrow collateral factor, a liquidate collateral
 * factor and a supply cap. A leaf that a collateral's feed reads contributes:
 *  - UPSIDE: deposit manipulated collateral, borrow the base asset. k = borrowCF·r,
 *    bounded by the Comet's available base liquidity and the collateral supply cap.
 *  - DOWNSIDE: Comet liquidation (absorb + storefront purchase) needs per-account data
 *    not on the free path; withheld for EV_pt, aggregate bound for EV_hi.
 *
 * Collateral factors are 1e18-scaled. The liquidation "bonus" is the storefront
 * discount: lif ≈ 1 / (1 − (1 − storeFrontPriceFactor)·(1 − liquidateCollateralFactor)).
 */

import type { Exposure, PriceNode } from '../types'
import type { BlockTag, Rpc } from '../chain/rpc'
import { fn, lower } from '../chain/abi'
import { decodeFeed, type DecodeContext, type LeafTable } from '../leaf/decode'
import { leafIds } from '../tree'

export interface CometDef {
  key: string
  label: string
  comet: string
  baseSymbol: string
}

/** Mainnet Comets. */
export const COMETS: CometDef[] = [
  { key: 'comp3-usdc', label: 'Compound III USDC', comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3', baseSymbol: 'USDC' },
  { key: 'comp3-weth', label: 'Compound III WETH', comet: '0xA17581A9E3356d9A858b789D68B4d866e593aE94', baseSymbol: 'WETH' },
  { key: 'comp3-usdt', label: 'Compound III USDT', comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840', baseSymbol: 'USDT' },
  { key: 'comp3-usds', label: 'Compound III USDS', comet: '0x5D409e56D886231aDAf00c8775665AD0f9897b56', baseSymbol: 'USDS' },
  { key: 'comp3-wsteth', label: 'Compound III wstETH', comet: '0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3', baseSymbol: 'wstETH' },
]

const NUM_ASSETS = fn('numAssets()', 'uint8')
const BASE_TOKEN = fn('baseToken()', 'address')
const GET_ASSET_INFO = fn('getAssetInfo(uint8)', '(uint8,address,address,uint64,uint64,uint64,uint64,uint128)')
const TOTALS_BASIC = fn('totalsBasic()', '(uint64,uint64,uint64,uint64,uint104,uint104,uint40,uint8)')
const STOREFRONT = fn('storeFrontPriceFactor()', 'uint256')
const GET_PRICE = fn('getPrice(address)', 'uint256')
const SYMBOL = fn('symbol()', 'string')
const DECIMALS = fn('decimals()', 'uint8')
const BALANCE_OF = fn('balanceOf(address)', 'uint256')
const TOTAL_SUPPLY_ASSET = fn('totalSupply()', 'uint256')

export interface CometResult {
  byLeaf: Map<string, Exposure[]>
  leaves: LeafTable
  undecoded: string[]
}

export async function buildComet(
  rpc: Rpc,
  def: CometDef,
  block: BlockTag,
  opts: { deviationPct?: Record<string, number>; leaves?: LeafTable } = {},
): Promise<CometResult> {
  const leaves: LeafTable = opts.leaves ?? {}
  const byLeaf = new Map<string, Exposure[]>()
  const undecoded: string[] = []
  const [nRaw, baseToken, sf, totals] = await rpc.multicall(
    [
      { target: def.comet, fn: NUM_ASSETS },
      { target: def.comet, fn: BASE_TOKEN },
      { target: def.comet, fn: STOREFRONT },
      { target: def.comet, fn: TOTALS_BASIC },
    ],
    block,
  )
  if (nRaw === null) return { byLeaf, leaves, undecoded }
  const n = Number(nRaw)
  const base = baseToken as string
  const [baseDec, baseBal, basePrice] = await rpc.multicall(
    [
      { target: base, fn: DECIMALS },
      { target: base, fn: BALANCE_OF, args: [def.comet] },
      { target: def.comet, fn: GET_PRICE, args: [base] },
    ],
    block,
  )
  // Comet getPrice is 8-decimal USD. Base liquidity = base held by the Comet.
  const baseUsdUnit = Math.pow(10, Number(baseDec ?? 6))
  const baseUsd = basePrice !== null ? Number(basePrice) / 1e8 : 1
  const availableBaseUsd = baseBal !== null ? (Number(baseBal) / baseUsdUnit) * baseUsd : 0
  const storeFront = sf !== null ? Number(sf) / 1e18 : 0.5
  void totals

  const infos = await rpc.multicall(Array.from({ length: n }, (_, i) => ({ target: def.comet, fn: GET_ASSET_INFO, args: [i] })), block)
  const nodeCache = new Map<string, PriceNode>()
  for (const info of infos) {
    if (!info) continue
    const token = lower(info[1] as string)
    const priceFeed = lower(info[2] as string)
    const borrowCF = Number(info[3]) / 1e18
    const liqCF = Number(info[4]) / 1e18
    const supplyCap = Number(info[7])
    if (borrowCF <= 0) continue
    const [sym, dec, price, bal] = await rpc.multicall(
      [
        { target: token, fn: SYMBOL },
        { target: token, fn: DECIMALS },
        { target: def.comet, fn: GET_PRICE, args: [token] },
        { target: token, fn: BALANCE_OF, args: [def.comet] },
      ],
      block,
    )
    const unit = Math.pow(10, Number(dec ?? 18))
    const priceUsd = price !== null ? Number(price) / 1e8 : 0
    const suppliedUsd = bal !== null ? (Number(bal) / unit) * priceUsd : 0
    const supplyCapUsd = (supplyCap / unit) * priceUsd
    const ctx: DecodeContext = { rpc, block, leaves, deviationPct: opts.deviationPct, nodeCache }
    let tree: PriceNode
    try {
      tree = await decodeFeed(ctx, priceFeed)
    } catch {
      undecoded.push(priceFeed)
      continue
    }
    const lif = 1 / (1 - (1 - storeFront) * (1 - liqCF))
    const exposure: Exposure = {
      protocol: 'compound-v3',
      id: `${def.key}:${sym}`,
      label: `${def.label} · ${sym} coll`,
      role: 'collateral',
      tree,
      borrowLtv: borrowCF,
      liqLtv: liqCF,
      lif,
      closeFactor: 1,
      borrowableUsd: availableBaseUsd,
      borrowableHiUsd: availableBaseUsd,
      liquidityKey: def.key,
      collateralRoomUsd: Math.max(0, supplyCapUsd - suppliedUsd),
      positions: null,
      aggregate: { collateralUsd: suppliedUsd, debtUsd: suppliedUsd * liqCF },
      notes: ['Compound III downside needs per-account absorb data (not fetched); EV_pt downside withheld, see README gaps'],
    }
    for (const id of leafIds(tree)) {
      if (leaves[id]?.kind === 'linear-discount') continue
      byLeaf.set(id, [...(byLeaf.get(id) ?? []), exposure])
    }
  }
  return { byLeaf, leaves, undecoded }
}
