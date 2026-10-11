/**
 * Curve: cost to move a pool's spot, found from the pool's own get_dy.
 *
 * No Curve math is re-implemented. The marginal rate after selling dx of coin i is
 *   m(dx) = (get_dy(i, j, dx·(1+ε)) − get_dy(i, j, dx)) / (dx·ε)
 * and the spot move is x = ln(m0 / m(dx)). A geometric grid of dx values is evaluated
 * in one Multicall3 batch. Each target x is then bracketed on that grid and refined by
 * batched bisection (16 interior points per round, 3 rounds), so a pool costs about 8
 * eth_calls per direction instead of ~600 sequential ones.
 *
 * Leaf spot = price of coin i in coin j. Selling i moves it 'down'. Selling j (the
 * reverse get_dy) moves it 'up'. The fee charged by get_dy is split out with fee().
 */

import type { Direction, ImpactCurve, ImpactSample } from '../types'
import type { BlockTag, Rpc } from '../chain/rpc'
import { fn, type Fn } from '../chain/abi'
import { xGrid } from './impact'

const EPS = 1e-4

const GET_DY_128 = fn('get_dy(int128,int128,uint256)', 'uint256')
const GET_DY_256 = fn('get_dy(uint256,uint256,uint256)', 'uint256')
const FEE = fn('fee()', 'uint256')
const COINS_256 = fn('coins(uint256)', 'address')
const BALANCES_256 = fn('balances(uint256)', 'uint256')
const PRICE_ORACLE_0 = fn('price_oracle()', 'uint256')
const PRICE_ORACLE_1 = fn('price_oracle(uint256)', 'uint256')
const MA_EXP = fn('ma_exp_time()', 'uint256')
const MA_HALF = fn('ma_half_time()', 'uint256')
const VIRTUAL_PRICE = fn('get_virtual_price()', 'uint256')
const DECIMALS = fn('decimals()', 'uint8')

export const NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

export interface CurvePoolInfo {
  pool: string
  coins: string[]
  decimals: number[]
  balances: bigint[]
  /** fee() / 1e10 (one-way, at the current balance). */
  feeRate: number
  /** get_dy index type: StableSwap uses int128, CryptoSwap/NG-crypto uses uint256. */
  indexType: 'int128' | 'uint256'
  /** EMA settings when the pool has price_oracle (seconds). */
  emaTimeSec: number | null
  hasPriceOracle: boolean
  virtualPrice: number | null
  hasNativeEth: boolean
}

export async function readCurvePool(rpc: Rpc, pool: string, block: BlockTag): Promise<CurvePoolInfo> {
  const coinCalls = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ target: pool, fn: COINS_256, args: [k] }))
  const balCalls = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ target: pool, fn: BALANCES_256, args: [k] }))
  const r = await rpc.multicall(
    [...coinCalls, ...balCalls, { target: pool, fn: FEE }, { target: pool, fn: PRICE_ORACLE_0 }, { target: pool, fn: PRICE_ORACLE_1, args: [0] }, { target: pool, fn: MA_EXP }, { target: pool, fn: MA_HALF }, { target: pool, fn: VIRTUAL_PRICE }],
    block,
  )
  const coins: string[] = []
  const balances: bigint[] = []
  for (let k = 0; k < 8; k++) {
    if (!r[k]) break
    coins.push(String(r[k]).toLowerCase())
    balances.push((r[8 + k] as bigint | null) ?? 0n)
  }
  if (coins.length < 2) throw new Error(`curve ${pool}: fewer than 2 coins`)
  const decs = await rpc.multicall(coins.map((c) => ({ target: c, fn: DECIMALS })), block)
  const decimals = coins.map((c, k) => (c === NATIVE_ETH ? 18 : Number(decs[k] ?? 18)))
  // Index type: probe get_dy(0,1,small) both ways.
  const small = 10n ** BigInt(Math.max(0, decimals[0] - 2))
  const [d128, d256] = await rpc.multicall(
    [
      { target: pool, fn: GET_DY_128, args: [0, 1, small] },
      { target: pool, fn: GET_DY_256, args: [0, 1, small] },
    ],
    block,
  )
  const ma = (r[19] as bigint | null) ?? null
  const half = (r[20] as bigint | null) ?? null
  return {
    pool,
    coins,
    decimals,
    balances,
    feeRate: r[16] !== null ? Number(r[16]) / 1e10 : 0,
    indexType: d128 !== null ? 'int128' : d256 !== null ? 'uint256' : 'int128',
    // ma_exp_time is the EMA time constant; ma_half_time (old crypto pools) is a half-life.
    emaTimeSec: ma !== null ? Number(ma) : half !== null ? Number(half) / Math.LN2 : null,
    hasPriceOracle: r[17] !== null || r[18] !== null,
    virtualPrice: r[21] !== null ? Number(r[21]) / 1e18 : null,
    hasNativeEth: coins.includes(NATIVE_ETH),
  }
}

/** EMA half-life of a Curve price_oracle, seconds (time constant × ln 2). */
export const curveEmaHalfLife = (info: CurvePoolInfo): number | null =>
  info.emaTimeSec === null ? null : info.emaTimeSec * Math.LN2

interface DySample {
  dx: number
  dy: number
  m: number
}

/** Raw output units a finite difference needs to stay clear of integer rounding. */
const MIN_DIFF_UNITS = 1e5
const MAX_EPS = 0.02

/**
 * Impact curve for the price of coin i in coin j. usdI/usdJ: USD per whole coin.
 */
export async function curveImpactCurve(
  rpc: Rpc,
  info: CurvePoolInfo,
  i: number,
  j: number,
  dir: Direction,
  block: BlockTag,
  usdI: number,
  usdJ: number,
): Promise<ImpactCurve> {
  // Selling coin `sell` for coin `buy`. Down = sell i; up = sell j.
  const [sell, buy] = dir === 'down' ? [i, j] : [j, i]
  const getDy: Fn = info.indexType === 'int128' ? GET_DY_128 : GET_DY_256
  const decS = info.decimals[sell]
  const decB = info.decimals[buy]
  const bal = Number(info.balances[sell]) || Math.pow(10, decS)
  // Two batches per evaluation: dy(dx), then dy(dx·(1+eps)) with eps sized so the
  // difference is ≥ MIN_DIFF_UNITS raw output units (8-decimal outputs need it).
  const evalDx = async (dxs: number[]): Promise<(DySample | null)[]> => {
    const r1 = await rpc.multicall(dxs.map((dx) => ({ target: info.pool, fn: getDy, args: [sell, buy, BigInt(Math.floor(dx))] })), block, 150)
    const eps = dxs.map((dx, k) => {
      const dy = r1[k] === null ? 0 : Number(r1[k])
      const e = dy > 0 ? MIN_DIFF_UNITS / dy : EPS
      return Math.min(MAX_EPS, Math.max(EPS, e, 1e3 / Math.max(dx, 1)))
    })
    const r2 = await rpc.multicall(dxs.map((dx, k) => ({ target: info.pool, fn: getDy, args: [sell, buy, BigInt(Math.floor(dx * (1 + eps[k])))] })), block, 150)
    return dxs.map((dx, k) => {
      const a = r1[k] as bigint | null
      const b = r2[k] as bigint | null
      if (a === null || b === null) return null
      const dy = Number(a)
      const ddx = Math.floor(dx * (1 + eps[k])) - Math.floor(dx)
      const m = ddx > 0 ? (Number(b) - dy) / ddx : NaN
      return m > 0 && Number.isFinite(m) ? { dx, dy, m } : null
    })
  }
  // m0: the marginal rate at dx → 0, extrapolated linearly from the two smallest probes
  // that are precise (a finite difference on a tiny trade rounds to nothing).
  const probes = [1e-7, 1e-6, 1e-5, 1e-4, 3e-4, 1e-3, 3e-3].map((f) => Math.max(1, bal * f))
  const pr = (await evalDx(probes)).filter((p): p is DySample => p !== null && p.dy >= MIN_DIFF_UNITS / MAX_EPS)
  if (pr.length === 0) throw new Error(`curve ${info.pool}: get_dy(${sell},${buy}) unusable`)
  const t0 = pr[0]
  const m0 = pr.length > 1 ? Math.max(t0.m, t0.m + ((t0.m - pr[1].m) * t0.dx) / (pr[1].dx - t0.dx)) : t0.m
  // Grid from the probe size to 30 × balance, 72 points; the walk keeps a running
  // maximum of x so finite-difference noise near zero cannot end it.
  const g0 = Math.log10(t0.dx / bal)
  const grid = Array.from({ length: 72 }, (_, k) => bal * Math.pow(10, g0 + (k * (Math.log10(30) - g0)) / 71))
  const g = await evalDx(grid)
  const xOf = (s: DySample) => Math.log(m0 / s.m)
  const pts: DySample[] = []
  let xMax = -Infinity
  for (const s of g) {
    if (!s) break
    const x = xOf(s)
    if (x < xMax) continue
    xMax = x
    pts.push(s)
  }
  const reach = pts.length ? Math.max(0, xOf(pts[pts.length - 1])) : 0
  const targets = xGrid(dir).filter((x) => x <= reach)
  // Bracket every target, then refine all brackets together: 3 rounds × 16 points.
  const br = targets.map((x) => {
    const k = pts.findIndex((p) => xOf(p) >= x)
    return { x, lo: k <= 0 ? 0 : pts[k - 1].dx, hi: pts[Math.max(0, k)].dx, best: pts[Math.max(0, k)] }
  })
  for (let round = 0; round < 3; round++) {
    const inner = br.flatMap((b) => Array.from({ length: 16 }, (_, q) => b.lo + ((b.hi - b.lo) * (q + 1)) / 17))
    const r = await evalDx(inner)
    br.forEach((b, t) => {
      let nlo = b.lo
      for (let q = 0; q < 16; q++) {
        const s = r[t * 16 + q]
        if (!s) continue
        if (xOf(s) >= b.x) {
          b.hi = s.dx
          b.best = s
          break
        }
        nlo = s.dx
      }
      b.lo = nlo
    })
  }
  const unitS = Math.pow(10, decS)
  const unitB = Math.pow(10, decB)
  const samples: ImpactSample[] = br.map((b) => {
    // Premium: what was sold, valued at m0, minus what came back; the fee part removed.
    const fairOut = b.best.dx * m0
    const j = Math.max(0, fairOut - b.best.dy - info.feeRate * fairOut)
    return {
      x: b.x,
      qUsd: (b.best.dx / unitS) * (dir === 'down' ? usdI : usdJ),
      jUsd: (j / unitB) * (dir === 'down' ? usdJ : usdI),
    }
  })
  return {
    direction: dir,
    feeRate: info.feeRate,
    samples,
    maxX: reach,
    mechanism: 'trade',
    liquidity: 'full',
    note: `Curve get_dy(${sell},${buy}) grid + batched bisection`,
  }
}
