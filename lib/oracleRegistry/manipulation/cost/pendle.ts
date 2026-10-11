/**
 * Pendle V2 market: cost to move the PT price (and so the ln-implied-rate TWAP).
 *
 * Float port of MarketMathCore (pendle-core-v2-public, contracts/core/Market/
 * MarketMathCore.sol): rateScalar = scalarRoot·yr/τ, rateAnchor fixed per trade from
 * lastLnImpliedRate, exchangeRate = logit(proportion)/rateScalar + rateAnchor, and the
 * new lastLnImpliedRate is read back from the post-trade proportion. PT spot price in
 * the accounting asset is 1/exchangeRate, which is also what the oracle's TWAP of
 * lnImpliedRate converts back to. So a log move x of the PT spot is x = ln(e0/e1).
 *
 * 'up' = buy PT from the pool (implied rate falls). 'down' = sell PT into it (what
 * swapExactSyForYt does: mint PT+YT, sell the PT). Limit orders are NOT modelled: they
 * add depth, so the AMM-only cost is a lower bound.
 */

import type { Direction, ImpactCurve, ImpactSample } from '../types'
import type { BlockTag, Rpc } from '../chain/rpc'
import { fn } from '../chain/abi'
import { xGrid } from './impact'

export const YEAR_SEC = 365 * 86400
const MAX_MARKET_PROPORTION = 0.96

/**
 * Market state as floats. totalPt / totalSy / totalLp stay in RAW token units (PT and
 * the accounting asset share decimals; SY may not, which pyIndex absorbs, exactly as
 * on-chain). Rates and roots are 1e18 fixed point divided out.
 */
export interface PendleState {
  totalPt: number
  totalSy: number
  totalLp: number
  /** Decimals of PT = of the accounting asset (raw → units for Q and J). */
  assetDecimals: number
  scalarRoot: number
  expiry: number
  lnFeeRateRoot: number
  reserveFeePercent: number
  lastLnImpliedRate: number
  /** SY raw → asset raw (max of SY.exchangeRate and YT.pyIndexStored, / 1e18). */
  pyIndex: number
  /** Block timestamp the state was read at. */
  now: number
}

export interface PendlePre {
  tau: number
  rateScalar: number
  totalAsset: number
  rateAnchor: number
  feeRate: number
  e0: number
}

const logit = (p: number) => Math.log(p / (1 - p))

export function precompute(s: PendleState): PendlePre {
  const tau = s.expiry - s.now
  if (tau <= 0) throw new Error('pendle: market expired')
  const rateScalar = (s.scalarRoot * YEAR_SEC) / tau
  const totalAsset = s.totalSy * s.pyIndex
  const e0 = Math.exp((s.lastLnImpliedRate * tau) / YEAR_SEC)
  const rateAnchor = e0 - logit(s.totalPt / (s.totalPt + totalAsset)) / rateScalar
  const feeRate = Math.exp((s.lnFeeRateRoot * tau) / YEAR_SEC)
  return { tau, rateScalar, totalAsset, rateAnchor, feeRate, e0 }
}

/** PT spot price in the asset, 1/e0. */
export const ptSpot = (s: PendleState): number => 1 / precompute(s).e0

export interface PendleTrade {
  /** Asset to the account (negative = paid). */
  netAsset: number
  /** Exchange rate after the trade (PT spot = 1/e1). */
  e1: number
  ok: boolean
}

/**
 * Trade `netPt` PT to the account (positive = buy). `withFee` false gives the pure
 * curve (used to split the premium from the fee).
 */
export function trade(s: PendleState, pre: PendlePre, netPt: number, withFee = true): PendleTrade {
  const denom = s.totalPt + pre.totalAsset
  const prop = (s.totalPt - netPt) / denom
  if (!(prop > 0) || prop > MAX_MARKET_PROPORTION) return { netAsset: 0, e1: pre.e0, ok: false }
  const eRate = logit(prop) / pre.rateScalar + pre.rateAnchor
  if (eRate < 1) return { netAsset: 0, e1: pre.e0, ok: false }
  const preFee = -netPt / eRate
  const f = withFee ? pre.feeRate : 1
  let fee: number
  if (netPt > 0) {
    if (eRate / f < 1) return { netAsset: 0, e1: pre.e0, ok: false }
    fee = preFee * (1 - f)
  } else {
    fee = -((preFee * (1 - f)) / f)
  }
  const netAsset = preFee - fee
  const reserve = withFee ? (fee * s.reserveFeePercent) / 100 : 0
  const pt1 = s.totalPt - netPt
  const asset1 = pre.totalAsset - (netAsset + reserve)
  const e1 = logit(pt1 / (pt1 + asset1)) / pre.rateScalar + pre.rateAnchor
  if (!(e1 >= 1)) return { netAsset, e1: 1, ok: false }
  return { netAsset, e1, ok: true }
}

/**
 * The same trade split into `steps` equal trades, each applied to the state the last
 * one left (totalPt, totalSy and lastLnImpliedRate update; time does not move).
 * MarketMathCore prices a whole trade at ONE post-trade point, so splitting is cheaper
 * for the attacker; many small steps approach the integral of marginal prices. The
 * PT-reUSD attacker used 11 trades.
 */
export function tradeSplit(s: PendleState, netPt: number, steps: number, withFee = true): PendleTrade {
  let cur = s
  let netAsset = 0
  let e1 = precompute(s).e0
  for (let i = 0; i < steps; i++) {
    const pre = precompute(cur)
    const t = trade(cur, pre, netPt / steps, withFee)
    if (!t.ok) return { netAsset, e1, ok: false }
    netAsset += t.netAsset
    e1 = t.e1
    // Reserve fee leaves the pool with the trade (as in _setNewMarketStateTrade).
    const reserve = withFee ? reserveOf(cur, pre, netPt / steps, t) : 0
    cur = {
      ...cur,
      totalPt: cur.totalPt - netPt / steps,
      totalSy: cur.totalSy - (t.netAsset + reserve) / cur.pyIndex,
      lastLnImpliedRate: (Math.log(t.e1) * YEAR_SEC) / pre.tau,
    }
  }
  return { netAsset, e1, ok: true }
}

/** Reserve-fee share of one trade, in asset (mirrors `trade`). */
function reserveOf(s: PendleState, pre: PendlePre, netPt: number, t: PendleTrade): number {
  const eRate = logit((s.totalPt - netPt) / (s.totalPt + pre.totalAsset)) / pre.rateScalar + pre.rateAnchor
  const preFee = -netPt / eRate
  const fee = preFee - t.netAsset
  return (fee * s.reserveFeePercent) / 100
}

/** Steps used for every cost figure (attacker-optimal splitting, see tradeSplit). */
export const SPLIT_STEPS = 32

/** Log move of the PT spot after trading netPt (positive when PT price rises). */
const moveOf = (pre: PendlePre, t: PendleTrade): number => Math.log(pre.e0 / t.e1)

/** Bisection for the |netPt| that moves the PT spot by x in `dir` (split trades). */
function solveNetPt(s: PendleState, pre: PendlePre, x: number, dir: Direction, hiOk: number): number | null {
  const sign = dir === 'up' ? 1 : -1
  let lo = 0
  let hi = hiOk
  const reach = sign * moveOf(pre, tradeSplit(s, sign * hi, SPLIT_STEPS))
  if (reach < x) return null
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const t = tradeSplit(s, sign * mid, SPLIT_STEPS)
    const m = sign * moveOf(pre, t)
    if (!t.ok || m > x) hi = mid
    else lo = mid
    if (hi - lo <= 1e-10 * Math.max(1, hi)) break
  }
  return (lo + hi) / 2
}

/** Largest trade size the split path accepts in `dir`, and the move it reaches. */
function reachOf(s: PendleState, dir: Direction): { size: number; x: number } {
  const pre = precompute(s)
  const sign = dir === 'up' ? 1 : -1
  let hi = dir === 'up' ? s.totalPt * 0.999999 : (s.totalPt + pre.totalAsset) * 25
  let lo = 0
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (tradeSplit(s, sign * mid, SPLIT_STEPS).ok) lo = mid
    else hi = mid
  }
  return { size: lo, x: Math.max(0, sign * moveOf(pre, tradeSplit(s, sign * lo, SPLIT_STEPS))) }
}

/** Largest |x| reachable in `dir` (proportion cap down; PT price ≤ 1 up). */
export function maxMove(s: PendleState, dir: Direction): number {
  return reachOf(s, dir).x
}

/**
 * Impact curve on the standard grid. Q = notional at the pre-trade spot (asset units ×
 * assetUsd). J = premium net of fee, for the split path. feeRate = the fee share of a
 * small trade.
 */
export function pendleImpactCurve(s: PendleState, dir: Direction, assetUsd: number, note?: string): ImpactCurve {
  const pre = precompute(s)
  const p0 = 1 / pre.e0
  const unit = Math.pow(10, s.assetDecimals)
  const sign = dir === 'up' ? 1 : -1
  const samples: ImpactSample[] = []
  const reach = reachOf(s, dir)
  let feeRate = 0
  for (const x of xGrid(dir)) {
    if (x > reach.x) break
    const n = solveNetPt(s, pre, x, dir, reach.size)
    if (n === null) break
    const withFee = tradeSplit(s, sign * n, SPLIT_STEPS, true)
    const noFee = tradeSplit(s, sign * n, SPLIT_STEPS, false)
    // Fair value of the PT leg at the pre-trade spot, in asset.
    const ptValue = n * p0
    // Up: paid -netAsset for PT worth ptValue. Down: got netAsset for PT worth ptValue.
    const premiumWithFee = dir === 'up' ? -withFee.netAsset - ptValue : ptValue - withFee.netAsset
    const premiumNoFee = dir === 'up' ? -noFee.netAsset - ptValue : ptValue - noFee.netAsset
    if (samples.length === 0 && ptValue > 0) feeRate = Math.max(0, (premiumWithFee - premiumNoFee) / ptValue)
    samples.push({ x, qUsd: (ptValue / unit) * assetUsd, jUsd: (Math.max(0, premiumNoFee) / unit) * assetUsd })
  }
  return {
    direction: dir,
    feeRate,
    samples,
    maxX: reach.x,
    mechanism: 'trade',
    liquidity: 'full',
    note: note ?? `Pendle AMM only, ${SPLIT_STEPS} split trades (limit orders add depth and are ignored)`,
  }
}

/** The same market with a share `removed` of LP withdrawn (pro-rata PT and SY). */
export function withoutLp(s: PendleState, removed: number): PendleState {
  const k = Math.max(0, 1 - removed)
  return { ...s, totalPt: s.totalPt * k, totalSy: s.totalSy * k, totalLp: s.totalLp * k }
}

// ---------------------------------------------------------------- on-chain reader

/** Pendle RouterV4 — passed to readState so router fee overrides apply as in a real swap. */
export const PENDLE_ROUTER_V4 = '0x888888888889758f76e7103c6cbf23abbf58f946'

const READ_STATE = fn('readState(address)', '(int256,int256,int256,address,int256,uint256,uint256,uint256,uint256)')
const READ_TOKENS = fn('readTokens()', '(address,address,address)')
const SY_RATE = fn('exchangeRate()', 'uint256')
const PY_INDEX = fn('pyIndexStored()', 'uint256')
const ASSET_INFO = fn('assetInfo()', '(uint8,address,uint8)')
const STORAGE = fn('_storage()', '(int128,int128,uint96,uint16,uint16,uint16)')
const OBSERVE = fn('observe(uint32[])', 'uint216[]')

export interface PendleMarketInfo {
  market: string
  sy: string
  pt: string
  yt: string
  asset: string
  assetDecimals: number
  assetType: number
  state: PendleState
  /** Observation buffer cardinality (TWAP needs cardinality × block time ≥ window). */
  cardinality: number
}

export async function readPendleMarket(rpc: Rpc, market: string, block: BlockTag): Promise<PendleMarketInfo> {
  const [st, tokens, blk] = await Promise.all([
    rpc.call(market, READ_STATE, [PENDLE_ROUTER_V4], block),
    rpc.call(market, READ_TOKENS, [], block),
    rpc.block(block),
  ])
  const [sy, pt, yt] = tokens as [string, string, string]
  const [rate, idx, info, stor] = await rpc.multicall(
    [
      { target: sy, fn: SY_RATE },
      { target: yt, fn: PY_INDEX },
      { target: sy, fn: ASSET_INFO },
      { target: market, fn: STORAGE },
    ],
    block,
  )
  if (rate === null || info === null) throw new Error(`pendle ${market}: SY exchangeRate/assetInfo unreadable`)
  const pyIndex = Number(rate > (idx ?? 0n) ? rate : idx) / 1e18
  const assetDecimals = Number(info[2])
  return {
    market,
    sy,
    pt,
    yt,
    asset: info[1],
    assetType: Number(info[0]),
    assetDecimals,
    cardinality: stor ? Number(stor[4]) : 0,
    state: {
      totalPt: Number(st[0]),
      totalSy: Number(st[1]),
      totalLp: Number(st[2]),
      assetDecimals,
      scalarRoot: Number(st[4]) / 1e18,
      expiry: Number(st[5]),
      lnFeeRateRoot: Number(st[6]) / 1e18,
      reserveFeePercent: Number(st[7]),
      lastLnImpliedRate: Number(st[8]) / 1e18,
      pyIndex,
      now: Number(blk.timestamp),
    },
  }
}

/** TWAP of lnImpliedRate over `windowSec` ending at `block`, as a PT price (asset per PT). */
export async function pendleTwapPtPrice(rpc: Rpc, info: PendleMarketInfo, windowSec: number, block: BlockTag): Promise<number | null> {
  const cum = (await rpc.tryCall(info.market, OBSERVE, [[windowSec, 0]], block)) as bigint[] | null
  if (!cum) return null
  const lnRate = Number(cum[1] - cum[0]) / windowSec / 1e18
  return Math.exp((-lnRate * (info.state.expiry - info.state.now)) / YEAR_SEC)
}
