/**
 * Decode an oracle address into a price tree over leaves (the moved objects).
 *
 * Handles the shapes that price mainnet lending collateral today:
 *  - Morpho ChainlinkOracleV2: a product of up to two base feeds and a base ERC-4626
 *    rate, over the same on the quote side. price = k·B1·B2·baseRate / (Q1·Q2·quoteRate).
 *  - Ojo / "lower-of" wrappers: FEED_1 and FEED_2 both set, output = min(f1, f2).
 *  - Pendle Chainlink oracle: market()+twapDuration() → a pendle-market leaf; the TWAP
 *    window is twapDuration (0 = spot).
 *  - Chainlink aggregator/proxy: a push-feed leaf, deviation threshold from the feed
 *    directory where known.
 *  - ERC-4626 vault rate: a vault leaf (donation-sensitive or not, decided later).
 *  - A deterministic/linear feed with no movable child → a non-manipulable rate leaf.
 *
 * Every terminal gets a stable leaf id so readers that share a leaf group together.
 * Unknown shapes become an `unknown` leaf (flagged, treated as non-manipulable but
 * surfaced in the coverage gaps).
 */

import type { Leaf, LeafKind, PriceNode } from '../types'
import type { BlockTag, Rpc } from '../chain/rpc'
import { fn, isZero, lower } from '../chain/abi'

const DECIMALS = fn('decimals()', 'uint8')
const DESCRIPTION = fn('description()', 'string')
const LATEST_ANSWER = fn('latestAnswer()', 'int256')
const LATEST_ROUND = fn('latestRoundData()', '(uint80,int256,uint256,uint256,uint80)')
const AGGREGATOR = fn('aggregator()', 'address')
const FEED_1 = fn('FEED_1()', 'address')
const FEED_2 = fn('FEED_2()', 'address')
const MARKET = fn('market()', 'address')
const TWAP_DURATION = fn('twapDuration()', 'uint32')
const CONVERT_TO_ASSETS = fn('convertToAssets(uint256)', 'uint256')
const CL_MIN = fn('minAnswer()', 'int192')
const CL_MAX = fn('maxAnswer()', 'int192')
const AGG_MIN = fn('minAnswer()', 'int256')
const AGG_MAX = fn('maxAnswer()', 'int256')
const PYTH = fn('pyth()', 'address')
const PRICE_ID = fn('priceId()', 'bytes32')
const GET_VIRTUAL_PRICE = fn('get_virtual_price()', 'uint256')

/** Descriptions that mark a deterministic / NAV / fundamental feed (not market-moved). */
const DETERMINISTIC_RE = /linear|discount|maturity|fundamental|\bnav\b|exchange rate|redemption|par value/i

export interface LeafTable {
  [id: string]: Leaf
}

export interface DecodeContext {
  rpc: Rpc
  block: BlockTag
  leaves: LeafTable
  /** Deviation threshold (percent) per Chainlink aggregator/feed, from the directory. */
  deviationPct?: Record<string, number>
  /** Depth guard against proxy loops. */
  depth?: number
  /** Memo of decoded feed nodes by address (the same feed backs many markets). */
  nodeCache?: Map<string, PriceNode>
}

const add = (ctx: DecodeContext, leaf: Leaf): string => {
  ctx.leaves[leaf.id] = leaf
  return leaf.id
}

/** Current output of a feed-like address (answer / 10^decimals), or null. */
async function feedValue(ctx: DecodeContext, addr: string): Promise<{ value: number; decimals: number } | null> {
  const [dec, la, lr] = await ctx.rpc.multicall(
    [
      { target: addr, fn: DECIMALS },
      { target: addr, fn: LATEST_ANSWER },
      { target: addr, fn: LATEST_ROUND },
    ],
    ctx.block,
  )
  const decimals = Number(dec ?? 18)
  const ans = la !== null ? (la as bigint) : lr !== null ? (lr[1] as bigint) : null
  if (ans === null) return null
  return { value: Number(ans) / Math.pow(10, decimals), decimals }
}

/** Decode a feed-like address (an aggregator, a wrapper, a Pendle oracle, a vault). */
export async function decodeFeed(ctx: DecodeContext, addr: string): Promise<PriceNode> {
  const depth = ctx.depth ?? 0
  if (isZero(addr)) return { op: 'const', value: 1, label: 'none' }
  const cached = ctx.nodeCache?.get(lower(addr))
  if (cached) return cached
  const node = await decodeFeedUncached(ctx, addr)
  ctx.nodeCache?.set(lower(addr), node)
  return node
}

async function decodeFeedUncached(ctx: DecodeContext, addr: string): Promise<PriceNode> {
  const depth = ctx.depth ?? 0
  const cx = { ...ctx, depth: depth + 1 }
  if (depth > 6) return constUnknown(ctx, addr, 'max-depth')

  const [f1, f2, market, twap] = await ctx.rpc.multicall(
    [
      { target: addr, fn: FEED_1 },
      { target: addr, fn: FEED_2 },
      { target: addr, fn: MARKET },
      { target: addr, fn: TWAP_DURATION },
    ],
    ctx.block,
  )

  // Pendle Chainlink-compatible oracle.
  if (market && !isZero(market) && twap !== null) {
    const fv = await feedValue(ctx, addr)
    const windowSec = Number(twap)
    const id = `pendle:${lower(market)}`
    add(ctx, { id, kind: 'pendle-market', address: lower(market), label: `Pendle ${lower(market).slice(0, 10)}`, meta: { twapDuration: windowSec } })
    return { op: 'leaf', leafId: id, read: windowSec > 0 ? { mode: 'twap', windowSec } : { mode: 'spot' }, value: fv?.value ?? 1, label: 'pendle' }
  }

  // "Lower-of" wrapper (Ojo PT feed): min(FEED_1, FEED_2).
  if (f1 && !isZero(f1) && f2 && !isZero(f2)) {
    const a = await decodeFeed(cx, f1 as string)
    const b = await decodeFeed(cx, f2 as string)
    return { op: 'min', of: [a, b], value: Math.min(a.value, b.value) }
  }

  // Curve LP share price: get_virtual_price. A read-only-reentrancy surface.
  const [vp] = await ctx.rpc.multicall([{ target: addr, fn: GET_VIRTUAL_PRICE }], ctx.block)
  if (vp !== null) {
    const id = `curve-lp:${lower(addr)}`
    add(ctx, { id, kind: 'curve-lp', address: lower(addr), label: `curve-lp ${lower(addr).slice(0, 10)}`, meta: {} })
    return { op: 'leaf', leafId: id, read: { mode: 'rate' }, value: Number(vp as bigint) / 1e18, label: 'curve-lp' }
  }

  // ERC-4626 share rate.
  const [cta, dec4626] = await ctx.rpc.multicall(
    [
      { target: addr, fn: CONVERT_TO_ASSETS, args: [10n ** 18n] },
      { target: addr, fn: DECIMALS },
    ],
    ctx.block,
  )
  if (cta !== null) {
    const id = `vault:${lower(addr)}`
    const rate = Number(cta) / Math.pow(10, Number(dec4626 ?? 18))
    add(ctx, { id, kind: 'erc4626-vault', address: lower(addr), label: `vault ${lower(addr).slice(0, 10)}`, meta: {} })
    return { op: 'leaf', leafId: id, read: { mode: 'rate' }, value: rate, label: 'vault-rate' }
  }

  // Everything below is a Chainlink-interface "feed". Decide its kind from the
  // interface and the description; the manipulability (free move / cost curve) is
  // attached later from the catalog and the directory.
  const [agg, pyth, priceId, desc] = await ctx.rpc.multicall(
    [
      { target: addr, fn: AGGREGATOR },
      { target: addr, fn: PYTH },
      { target: addr, fn: PRICE_ID },
      { target: addr, fn: DESCRIPTION },
    ],
    ctx.block,
  )
  const fv = await feedValue(ctx, addr)
  const description = String(desc ?? '')
  const value = fv?.value ?? 1
  const decimals = fv?.decimals ?? Number(dec4626 ?? 8)

  // Pull oracle (Pyth / RedStone core): the caller supplies a signed price.
  if ((pyth && !isZero(pyth)) || (priceId && !/^0x0+$/.test(String(priceId))) || /redstone/i.test(description)) {
    const vendor = /redstone/i.test(description) ? 'redstone' : 'pyth'
    const id = `pull:${lower(addr)}`
    const deterministic = DETERMINISTIC_RE.test(description)
    add(ctx, {
      id,
      kind: 'pull-feed',
      address: lower(addr),
      label: description || `pull ${lower(addr).slice(0, 10)}`,
      meta: { vendor, description, priceId: priceId ? String(priceId) : null, deterministic },
    })
    return { op: 'leaf', leafId: id, read: { mode: 'feed' }, value, label: vendor }
  }

  // Chainlink proxy → aggregator, or a bare aggregator with min/maxAnswer.
  if (agg && !isZero(agg)) return pushFeedLeaf(ctx, addr, agg as string, value, undefined, description)
  const [mnA, mxA, mnB, mxB] = await ctx.rpc.multicall(
    [
      { target: addr, fn: CL_MIN },
      { target: addr, fn: CL_MAX },
      { target: addr, fn: AGG_MIN },
      { target: addr, fn: AGG_MAX },
    ],
    ctx.block,
  )
  const hasBounds = mnA !== null || mnB !== null
  if (hasBounds) return pushFeedLeaf(ctx, addr, addr, value, { min: num(mnA ?? mnB, decimals), max: num(mxA ?? mxB, decimals) }, description)

  // A deterministic / NAV / fundamental feed (linear PT discount, USR NAV, deUSD
  // fundamental): not moved by a market trade.
  if (DETERMINISTIC_RE.test(description) || fv === null) {
    const id = `rate:${lower(addr)}`
    const reason = fv === null ? 'no-plain-read (payload-gated feed)' : 'deterministic-description'
    add(ctx, { id, kind: 'linear-discount', address: lower(addr), label: description || `rate ${lower(addr).slice(0, 10)}`, meta: { description, reason } })
    return { op: 'leaf', leafId: id, read: { mode: 'rate' }, value, label: description || 'rate' }
  }

  // A plain Chainlink-interface feed with no discoverable aggregator or bounds. Treat
  // as a push feed with unknown parameters (inert until the directory supplies them).
  return pushFeedLeaf(ctx, addr, addr, value, undefined, description)
}

function pushFeedLeaf(
  ctx: DecodeContext,
  proxy: string,
  aggregator: string,
  value: number,
  bounds?: { min: number | null; max: number | null },
  description = '',
): PriceNode {
  const id = `feed:${lower(proxy)}`
  const devPct = ctx.deviationPct?.[lower(proxy)] ?? ctx.deviationPct?.[lower(aggregator)] ?? null
  add(ctx, {
    id,
    kind: 'push-feed',
    address: lower(proxy),
    label: description || `feed ${lower(proxy).slice(0, 10)}`,
    meta: { aggregator: lower(aggregator), deviationPct: devPct, minAnswer: bounds?.min ?? null, maxAnswer: bounds?.max ?? null, description },
  })
  const leaf: PriceNode = { op: 'leaf', leafId: id, read: { mode: 'feed' }, value, label: 'feed' }
  if (bounds && (bounds.min !== null || bounds.max !== null) && value > 0) {
    return { op: 'clamp', node: leaf, lo: bounds.min ? bounds.min / value : null, hi: bounds.max ? bounds.max / value : null, value, label: 'cl-bounds' }
  }
  return leaf
}

function constUnknown(ctx: DecodeContext, addr: string, why: string): PriceNode {
  const id = `unknown:${lower(addr)}`
  add(ctx, { id, kind: 'unknown', address: lower(addr), label: `unknown ${lower(addr).slice(0, 10)}`, meta: { why } })
  return { op: 'leaf', leafId: id, read: { mode: 'feed' }, value: 1, label: `unknown(${why})` }
}

const num = (v: unknown, decimals: number): number | null =>
  v === null || v === undefined ? null : Number(v as bigint) / Math.pow(10, decimals)

// ---------------------------------------------------------------- Morpho oracle

const BASE_FEED_1 = fn('BASE_FEED_1()', 'address')
const BASE_FEED_2 = fn('BASE_FEED_2()', 'address')
const QUOTE_FEED_1 = fn('QUOTE_FEED_1()', 'address')
const QUOTE_FEED_2 = fn('QUOTE_FEED_2()', 'address')
const BASE_VAULT = fn('BASE_VAULT()', 'address')
const QUOTE_VAULT = fn('QUOTE_VAULT()', 'address')
const PRICE = fn('price()', 'uint256')

/**
 * Decode a Morpho ChainlinkOracleV2 into a product tree. Returns null if the address
 * is not a ChainlinkOracleV2 (no BASE_FEED_1 / price()).
 */
export async function decodeMorphoOracle(ctx: DecodeContext, oracle: string): Promise<PriceNode | null> {
  const [b1, b2, q1, q2, bv, qv, price] = await ctx.rpc.multicall(
    [BASE_FEED_1, BASE_FEED_2, QUOTE_FEED_1, QUOTE_FEED_2, BASE_VAULT, QUOTE_VAULT, PRICE].map((f) => ({ target: oracle, fn: f })),
    ctx.block,
  )
  if (price === null && b1 === null) return null
  const factors: { node: PriceNode; exp: 1 | -1 }[] = []
  const addFeed = async (addr: unknown, exp: 1 | -1) => {
    if (addr && !isZero(addr as string)) factors.push({ node: await decodeFeed({ ...ctx, depth: 0 }, addr as string), exp })
  }
  const addVault = async (addr: unknown, exp: 1 | -1) => {
    if (addr && !isZero(addr as string)) {
      const [cta, dec] = await ctx.rpc.multicall(
        [
          { target: addr as string, fn: CONVERT_TO_ASSETS, args: [10n ** 18n] },
          { target: addr as string, fn: DECIMALS },
        ],
        ctx.block,
      )
      const rate = cta !== null ? Number(cta) / Math.pow(10, Number(dec ?? 18)) : 1
      const id = `vault:${lower(addr as string)}`
      add(ctx, { id, kind: 'erc4626-vault', address: lower(addr as string), label: `vault ${lower(addr as string).slice(0, 10)}`, meta: {} })
      factors.push({ node: { op: 'leaf', leafId: id, read: { mode: 'rate' }, value: rate, label: 'vault-rate' }, exp })
    }
  }
  await addFeed(b1, 1)
  await addFeed(b2, 1)
  await addVault(bv, 1)
  await addFeed(q1, -1)
  await addFeed(q2, -1)
  await addVault(qv, -1)
  if (factors.length === 0) return null
  // value: product of factor values with exponents, scaled to the on-chain price when
  // readable (so min/clamp nodes compare on the true magnitude).
  let value = 1
  for (const f of factors) value *= f.exp === 1 ? f.node.value : 1 / (f.node.value || 1)
  return { op: 'product', factors, value }
}
