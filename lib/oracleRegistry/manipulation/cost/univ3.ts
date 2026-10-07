/**
 * Uniswap v3: cost to move a pool's price by walking ticks with on-chain liquidityNet.
 *
 * Spot = price of token0 in token1 (raw units), p = s² with s = sqrtPriceX96 / 2^96.
 * Inside one initialized range the active liquidity L is constant and
 *   up   (buy token0, s rises a→b):   token1 in = L(b − a), token0 out = L(1/a − 1/b)
 *   down (sell token0, s falls a→b):  token0 in = L(1/b − 1/a), token1 out = L(a − b)
 * Crossing an initialized tick upward adds its liquidityNet; downward subtracts it.
 * Premium J = what was paid − what was received valued at the starting price p0.
 * Past the last initialized tick (L = 0) the price moves for free: the curve goes flat,
 * which is exactly the thin-tail TWAP attack surface.
 */

import type { Direction, ImpactCurve, ImpactSample } from '../types'
import type { BlockTag, Rpc } from '../chain/rpc'
import { fn } from '../chain/abi'
import { xGrid } from './impact'

export const MIN_TICK = -887272
export const MAX_TICK = 887272
const Q96 = 2 ** 96

export interface TickData {
  tick: number
  liquidityNet: bigint
}

export interface V3State {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  fee: number // hundredths of a bip (500 = 0.05%)
  tickSpacing: number
  /** Initialized ticks, ascending. */
  ticks: TickData[]
  decimals0: number
  decimals1: number
}

const sqrtAt = (tick: number): number => Math.pow(1.0001, tick / 2)

/**
 * Walk from the current price in `dir` and record cumulative (Q, J) at each target
 * log move. Q and J are in token1 raw (up) or token0 raw (down) before USD scaling.
 */
export function walkV3(st: V3State, dir: Direction, targets: number[]): { samples: { x: number; q: number; j: number }[]; maxX: number } {
  const s0 = Number(st.sqrtPriceX96) / Q96
  const p0 = s0 * s0
  let s = s0
  let L = Number(st.liquidity)
  let qIn = 0 // input token, raw
  let outFair = 0 // output valued in input token at p0, raw
  const out: { x: number; q: number; j: number }[] = []
  const up = dir === 'up'
  // Ticks to cross, in walk order.
  const ticks = up ? st.ticks.filter((t) => t.tick > st.tick) : st.ticks.filter((t) => t.tick <= st.tick).reverse()
  let ti = 0
  let k = 0
  const sTarget = (x: number) => (up ? s0 * Math.exp(x / 2) : s0 * Math.exp(-x / 2))
  const record = (x: number) => out.push({ x, q: qIn, j: Math.max(0, qIn - outFair) })
  // Segment-wise integration from a to b with constant L.
  const step = (a: number, b: number) => {
    if (L <= 0) return
    if (up) {
      qIn += L * (b - a)
      outFair += L * (1 / a - 1 / b) * p0
    } else {
      qIn += L * (1 / b - 1 / a)
      outFair += (L * (a - b)) / p0
    }
  }
  const boundS = up ? sqrtAt(MAX_TICK) : sqrtAt(MIN_TICK)
  while (k < targets.length) {
    const nextTickS = ti < ticks.length ? sqrtAt(ticks[ti].tick) : boundS
    const tgt = sTarget(targets[k])
    const reached = up ? tgt <= nextTickS : tgt >= nextTickS
    if (reached) {
      step(s, tgt)
      s = tgt
      record(targets[k])
      k++
      continue
    }
    step(s, nextTickS)
    s = nextTickS
    if (ti >= ticks.length) break
    const net = Number(ticks[ti].liquidityNet)
    L = up ? L + net : L - net
    if (L < 0) L = 0
    ti++
  }
  const maxX = Math.abs(2 * Math.log(boundS / s0))
  return { samples: out, maxX }
}

/** USD impact curve. usd0/usd1 = USD per whole token. */
export function v3ImpactCurve(st: V3State, dir: Direction, usd0: number, usd1: number, extra: Partial<ImpactCurve> = {}): ImpactCurve {
  const { samples, maxX } = walkV3(st, dir, xGrid(dir))
  const toUsd = dir === 'up' ? usd1 / Math.pow(10, st.decimals1) : usd0 / Math.pow(10, st.decimals0)
  const s: ImpactSample[] = samples.map((p) => ({ x: p.x, qUsd: p.q * toUsd, jUsd: p.j * toUsd }))
  return {
    direction: dir,
    feeRate: st.fee / 1e6,
    samples: s,
    maxX,
    mechanism: 'trade',
    liquidity: 'full',
    ...extra,
  }
}

/** A liquidity position (owner-aggregated) for top-k removal. */
export interface V3Position {
  owner: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
}

/** The pool state with these positions withdrawn. */
export function withoutPositions(st: V3State, positions: V3Position[]): V3State {
  const net = new Map<number, bigint>(st.ticks.map((t) => [t.tick, t.liquidityNet]))
  let active = st.liquidity
  for (const p of positions) {
    net.set(p.tickLower, (net.get(p.tickLower) ?? 0n) - p.liquidity)
    net.set(p.tickUpper, (net.get(p.tickUpper) ?? 0n) + p.liquidity)
    if (p.tickLower <= st.tick && st.tick < p.tickUpper) active -= p.liquidity
  }
  const ticks = [...net.entries()].filter(([, v]) => v !== 0n).sort((a, b) => a[0] - b[0]).map(([tick, liquidityNet]) => ({ tick, liquidityNet }))
  return { ...st, liquidity: active < 0n ? 0n : active, ticks }
}

/** Largest owners by in-range-weighted liquidity; returns their positions. */
export function topOwners(positions: V3Position[], k: number, currentTick: number): { owners: string[]; positions: V3Position[] } {
  const score = new Map<string, bigint>()
  for (const p of positions) {
    // Rank by liquidity that is in range now or within ±2,000 ticks (≈ ±22%).
    if (p.tickUpper < currentTick - 2000 || p.tickLower > currentTick + 2000) continue
    score.set(p.owner, (score.get(p.owner) ?? 0n) + p.liquidity)
  }
  const owners = [...score.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, k).map(([o]) => o)
  return { owners, positions: positions.filter((p) => owners.includes(p.owner)) }
}

// ---------------------------------------------------------------- on-chain reader

const SLOT0 = fn('slot0()', '(uint160,int24,uint16,uint16,uint16,uint8,bool)')
const LIQ = fn('liquidity()', 'uint128')
const FEE = fn('fee()', 'uint24')
const SPACING = fn('tickSpacing()', 'int24')
const TOKEN0 = fn('token0()', 'address')
const TOKEN1 = fn('token1()', 'address')
const DECIMALS = fn('decimals()', 'uint8')
const BITMAP = fn('tickBitmap(int16)', 'uint256')
const TICKS = fn('ticks(int24)', '(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)')

export interface V3PoolInfo {
  pool: string
  token0: string
  token1: string
  state: V3State
}

/**
 * Read the pool and every initialized tick within ±`wordSpan` bitmap words of the
 * current tick (one word = 256 × tickSpacing ticks). The default covers ±~65,000 ticks
 * at spacing 1 and the whole range at spacing ≥ 60.
 */
export async function readV3Pool(rpc: Rpc, pool: string, block: BlockTag, wordSpan = 256): Promise<V3PoolInfo> {
  const [slot0, liq, fee, spacing, t0, t1] = await rpc.multicall(
    [SLOT0, LIQ, FEE, SPACING, TOKEN0, TOKEN1].map((f) => ({ target: pool, fn: f })),
    block,
  )
  if (!slot0 || liq === null || fee === null || spacing === null) throw new Error(`univ3 ${pool}: not a v3 pool`)
  const [d0, d1] = await rpc.multicall([{ target: t0, fn: DECIMALS }, { target: t1, fn: DECIMALS }], block)
  const tickSpacing = Number(spacing)
  const tick = Number(slot0[1])
  const compressed = Math.floor(tick / tickSpacing)
  const word0 = compressed >> 8
  const minWord = Math.max(Math.floor(MIN_TICK / tickSpacing) >> 8, word0 - wordSpan)
  const maxWord = Math.min(Math.floor(MAX_TICK / tickSpacing) >> 8, word0 + wordSpan)
  const words: number[] = []
  for (let w = minWord; w <= maxWord; w++) words.push(w)
  const bitmaps = await rpc.multicall(words.map((w) => ({ target: pool, fn: BITMAP, args: [w] })), block, 400)
  const initTicks: number[] = []
  words.forEach((w, i) => {
    let bm = bitmaps[i] as bigint | null
    if (!bm) return
    for (let bit = 0; bm > 0n; bit++, bm >>= 1n) {
      if (bm & 1n) initTicks.push(((w << 8) + bit) * tickSpacing)
    }
  })
  const tickRows = await rpc.multicall(initTicks.map((t) => ({ target: pool, fn: TICKS, args: [t] })), block, 300)
  const ticks: TickData[] = []
  initTicks.forEach((t, i) => {
    const r = tickRows[i]
    if (r && r[1] !== 0n) ticks.push({ tick: t, liquidityNet: r[1] as bigint })
  })
  ticks.sort((a, b) => a.tick - b.tick)
  return {
    pool,
    token0: t0,
    token1: t1,
    state: {
      sqrtPriceX96: slot0[0],
      tick,
      liquidity: liq,
      fee: Number(fee),
      tickSpacing,
      ticks,
      decimals0: Number(d0 ?? 18),
      decimals1: Number(d1 ?? 18),
    },
  }
}
