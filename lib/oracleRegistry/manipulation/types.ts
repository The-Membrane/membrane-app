/**
 * Types for the oracle-manipulation ratio engine.
 *
 * Vocabulary (see README.md in this directory):
 *  - LEAF: the object an attacker actually moves — a Pendle market's implied rate, a
 *    Uniswap v3 pool's tick, a Curve pool's balances, an ERC-4626 vault's share rate,
 *    a push feed's last answer. A market oracle is a tree over one or more leaves.
 *  - READER: one lending market (or reserve) whose oracle tree contains the leaf.
 *  - x: a move of the leaf, as a log displacement of its spot price. A reader with a
 *    TWAP of window W sees x·min(h, W)/W when the move is held for h seconds.
 *  - C(x): the attacker's net cost of a move, USD. EV(x): what the move extracts from
 *    every reader, USD. R = C / EV. Every successful past attack had R ≤ 0.76.
 */

export type Address = string
export type Direction = 'up' | 'down'

export type LeafKind =
  | 'pendle-market' // PT price via the market's ln-implied-rate (spot or TWAP)
  | 'univ3-pool' // tick (spot or geometric TWAP)
  | 'curve-pool' // spot via get_dy / get_p, EMA via price_oracle
  | 'curve-lp' // LP share price (get_virtual_price): read-only-reentrancy surface
  | 'erc4626-vault' // share → asset rate
  | 'push-feed' // Chainlink-style, updated by deviation/heartbeat
  | 'pull-feed' // Pyth / RedStone core: the caller supplies a signed price
  | 'linear-discount' // deterministic PT discount (time to maturity)
  | 'exchange-rate' // protocol rate (wstETH.stEthPerToken, rETH rate, ...)
  | 'fixed' // hard-coded price
  | 'unknown'

/** How a reader reads the leaf. */
export type LeafRead =
  | { mode: 'spot' }
  | { mode: 'twap'; windowSec: number }
  | { mode: 'ema'; halfLifeSec: number }
  | { mode: 'feed' } // push or pull feed answer
  | { mode: 'rate' } // deterministic or protocol rate

/**
 * An oracle as a tree. `value` is the node's current output (any unit), which the
 * min/max nodes need to know which branch binds. Leaves are referenced by id.
 */
export type PriceNode =
  | { op: 'leaf'; leafId: string; read: LeafRead; value: number; label?: string }
  | { op: 'product'; factors: { node: PriceNode; exp: 1 | -1 }[]; value: number }
  | { op: 'min' | 'max'; of: PriceNode[]; value: number }
  /** Bounds relative to the current output: lo/hi are factors (hi 1.01 = at most +1%). */
  | { op: 'clamp'; node: PriceNode; lo: number | null; hi: number | null; value: number; label?: string }
  | { op: 'const'; value: number; label: string }

export interface Leaf {
  id: string
  kind: LeafKind
  address: Address
  label: string
  /** Kind-specific facts (pool tokens, fee, market expiry, feed threshold, ...). */
  meta: Record<string, string | number | boolean | null>
}

export type Protocol =
  | 'morpho-blue'
  | 'aave-v3'
  | 'spark'
  | 'euler-v2'
  | 'compound-v3'
  | 'fluid'
  | 'liquity-v2'

/** One position, valued at the CURRENT oracle price, in USD. */
export interface PositionUsd {
  collateralUsd: number
  debtUsd: number
}

/**
 * A reader's exposure: everything the EV side needs about one market/reserve.
 * `role` says whether the tree prices the market's collateral (normal) or the asset
 * that is borrowed. The collateral/debt price ratio moves by f (collateral) or 1/f (debt).
 */
export interface Exposure {
  protocol: Protocol
  /** Protocol-unique id (Morpho market id, `pool:asset`, Euler `vault:collateral`, ...). */
  id: string
  label: string
  role: 'collateral' | 'debt'
  tree: PriceNode
  /** LTV at which a new borrow may be opened (Morpho: LLTV; Aave: LTV). */
  borrowLtv: number
  /** Liquidation LTV (Morpho: LLTV; Aave: liquidation threshold). */
  liqLtv: number
  /** Liquidation incentive factor, 1 + bonus (Morpho LIF; Aave 1 + bonus). */
  lif: number
  /** Max share of debt repayable in one liquidation (Morpho 1, Aave 0.5 above HF 0.95). */
  closeFactor: number
  /** USD that can be borrowed out right now against this exposure (liquidity, caps). */
  borrowableUsd: number
  /**
   * Upper bound on borrowable USD for EV_hi, when liquidity can be pulled in on demand
   * (Morpho public-allocator reallocation into the market). Defaults to borrowableUsd.
   */
  borrowableHiUsd?: number
  /**
   * Shared-liquidity key: exposures with the same key draw on one pool of borrowable
   * liquidity (all Aave core reserves borrow from the same reserves). Morpho: market id.
   */
  liquidityKey: string
  /** Extra collateral the attacker can still deposit (supply-cap headroom), USD. */
  collateralRoomUsd: number
  /** Position-level data when available; else an aggregate bound is used. */
  positions: PositionUsd[] | null
  aggregate: PositionUsd
  /** Dynamic liquidation discount cap (Euler): the effective LIF is 1/(1 - min(cap, 1 - HF)). */
  dynamicDiscountCap?: number
  notes?: string[]
}

/** Sampled impact of moving a leaf's spot by log displacement x in one direction. */
export interface ImpactSample {
  /** log displacement (positive magnitude; direction is the curve's). */
  x: number
  /** Notional traded (or donated) to reach x from the current state, USD. */
  qUsd: number
  /** Premium paid over fair value to reach x (recovered on self-unwind), USD. */
  jUsd: number
}

export interface ImpactCurve {
  direction: Direction
  /** Fee rate charged on notional (one way). */
  feeRate: number
  samples: ImpactSample[]
  /** Largest reachable |x| (pool bounds, max proportion, ...). */
  maxX: number
  /** `trade`: an AMM (self-unwind recovers J). `donation`: J is lost, the move is permanent. */
  mechanism: 'trade' | 'donation'
  /** Liquidity state this curve was built on. */
  liquidity: 'full' | 'top-k-removed'
  topKRemoved?: number
  note?: string
}

export type Regime = 'atomic' | 'passive' | 'competitive'

export interface FreeMove {
  kind: 'deviation-band' | 'clamp' | 'pull-selection' | 'divergence' | 'read-only-reentrancy'
  /** Free log move (magnitude), and the directions it can be used in. */
  x: number
  directions: Direction[]
  note: string
  /** EV of the free move across readers, USD (filled in by the ratio stage). */
  evUsd?: number
}

export type Verdict = 'red' | 'yellow' | 'green'

export interface CurvePoint {
  /** Percent move of the leaf spot (e^x - 1). */
  movePct: number
  direction: Direction
  /** Best hold time for this point, seconds (0 = atomic). */
  holdSec: number
  cLoUsd: number | null
  cPtUsd: number | null
  evHiUsd: number
  evPtUsd: number
  rLo: number | null
  rPt: number | null
}
