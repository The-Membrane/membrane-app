/**
 * Morpho Blue readers for a set of leaves.
 *
 * Morpho is the venue where exotic leaves (Pendle PTs, LRT vaults, long-tail feeds)
 * are read, so the leaf → market inversion is done here by decoding EVERY sizeable
 * mainnet market's oracle once and indexing by leaf address.
 *
 * EV inputs per market (ev/math.Exposure):
 *  - borrowLtv = liqLtv = LLTV (Morpho has one LLTV; a new borrow opens up to it).
 *  - lif = Morpho LIF(LLTV); closeFactor 1 (Morpho repays the whole position).
 *  - borrowableUsd = the market's own idle liquidity (supply − borrow).
 *  - borrowableHiUsd = idle + public-allocator reallocatable idle from vaults that
 *    supply this market (bounded; when not fetched, = borrowableUsd, noted as a gap).
 *  - positions = borrower list from the API (collateral/debt USD), for EV_pt downside.
 *  - aggregate = market collateral/borrow USD, for EV_hi downside.
 *
 * The oracle tree is attached per leaf: the market's full tree, so a leaf move pushes
 * through min/clamp/product exactly as on-chain.
 */

import type { Exposure, PositionUsd, PriceNode } from '../types'
import type { BlockTag, Rpc } from '../chain/rpc'
import { decodeMorphoOracle, type DecodeContext, type LeafTable } from '../leaf/decode'
import { leafIds } from '../tree'
import { morphoLif } from './math'

export interface MorphoMarket {
  marketId: string
  lltv: number
  oracle: string | null
  collateralSymbol: string | null
  collateralAddress: string | null
  loanSymbol: string
  loanAddress: string
  borrowUsd: number
  supplyUsd: number
  collateralUsd: number
  liquidityUsd: number
  creationBlock: number
}

interface GqlMarket {
  marketId: string
  lltv: string
  oracleAddress: string | null
  collateralAsset: { symbol: string; address: string } | null
  loanAsset: { symbol: string; address: string }
  state: {
    borrowAssetsUsd: number | null
    supplyAssetsUsd: number | null
    collateralAssetsUsd: number | null
    liquidityAssetsUsd: number | null
  } | null
  creationBlockNumber: number
}

const MORPHO_API = 'https://api.morpho.org/graphql'

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(MORPHO_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors) throw new Error(`morpho api: ${body.errors.map((e) => e.message).join('; ')}`)
  if (!body.data) throw new Error('morpho api: no data')
  return body.data
}

/** All mainnet markets with borrow ≥ minBorrowUsd (paginated). */
export async function fetchMorphoMarkets(minBorrowUsd = 50_000): Promise<MorphoMarket[]> {
  const out: MorphoMarket[] = []
  const pageSize = 100
  for (let skip = 0; skip < 5000; skip += pageSize) {
    const data = await gql<{ markets: { items: GqlMarket[] } }>(
      `query($first:Int!,$skip:Int!,$min:Float!){ markets(first:$first, skip:$skip, orderBy:BorrowAssetsUsd, orderDirection:Desc, where:{chainId_in:[1], borrowAssetsUsd_gte:$min}){ items{ marketId lltv oracleAddress collateralAsset{symbol address} loanAsset{symbol address} state{borrowAssetsUsd supplyAssetsUsd collateralAssetsUsd liquidityAssetsUsd} creationBlockNumber } } }`,
      { first: pageSize, skip, min: minBorrowUsd },
    )
    const items = data.markets.items
    for (const m of items) {
      if (!m.collateralAsset) continue // idle market
      out.push({
        marketId: m.marketId,
        lltv: Number(m.lltv) / 1e18,
        oracle: m.oracleAddress ? m.oracleAddress.toLowerCase() : null,
        collateralSymbol: m.collateralAsset.symbol,
        collateralAddress: m.collateralAsset.address.toLowerCase(),
        loanSymbol: m.loanAsset.symbol,
        loanAddress: m.loanAsset.address.toLowerCase(),
        borrowUsd: m.state?.borrowAssetsUsd ?? 0,
        supplyUsd: m.state?.supplyAssetsUsd ?? 0,
        collateralUsd: m.state?.collateralAssetsUsd ?? 0,
        liquidityUsd: m.state?.liquidityAssetsUsd ?? 0,
        creationBlock: m.creationBlockNumber,
      })
    }
    if (items.length < pageSize) break
  }
  return out
}

export interface BorrowerPosition {
  healthFactor: number | null
  collateralUsd: number
  borrowUsd: number
}

/** Borrower positions in a market (collateral/debt USD), largest debt first. */
export async function fetchBorrowers(marketId: string, max = 200): Promise<BorrowerPosition[]> {
  const out: BorrowerPosition[] = []
  const pageSize = 100
  for (let skip = 0; skip < max; skip += pageSize) {
    const data = await gql<{ marketPositions: { items: { healthFactor: number | null; state: { collateralUsd: number | null; borrowAssetsUsd: number | null } | null }[] } }>(
      `query($first:Int!,$skip:Int!,$id:[String!]){ marketPositions(first:$first, skip:$skip, orderBy:BorrowShares, orderDirection:Desc, where:{chainId_in:[1], marketUniqueKey_in:$id, borrowShares_gte:1}){ items{ healthFactor state{ collateralUsd borrowAssetsUsd } } } }`,
      { first: pageSize, skip, id: [marketId] },
    )
    const items = data.marketPositions.items
    for (const p of items) {
      const c = p.state?.collateralUsd ?? 0
      const d = p.state?.borrowAssetsUsd ?? 0
      if (d > 0 && c > 0) out.push({ healthFactor: p.healthFactor, collateralUsd: c, borrowUsd: d })
    }
    if (items.length < pageSize) break
  }
  return out
}

export interface MorphoExposures {
  /** leafId → exposures reading that leaf. */
  byLeaf: Map<string, Exposure[]>
  /** oracle address → decoded tree. */
  trees: Map<string, PriceNode>
  leaves: LeafTable
  /** Markets whose oracle could not be decoded (coverage gap). */
  undecoded: MorphoMarket[]
  scanned: number
}

/**
 * Decode every market's oracle and index exposures by leaf. Only markets that read one
 * of `wantLeaves` (lowercased leaf addresses) get positions fetched (expensive); pass
 * an empty set to fetch positions for all (used sparingly).
 */
export async function buildMorphoExposures(
  rpc: Rpc,
  markets: MorphoMarket[],
  block: BlockTag,
  opts: { deviationPct?: Record<string, number>; fetchPositionsFor?: Set<string>; minBorrowForPositions?: number } = {},
): Promise<MorphoExposures> {
  const leaves: LeafTable = {}
  const trees = new Map<string, PriceNode>()
  const byLeaf = new Map<string, Exposure[]>()
  const undecoded: MorphoMarket[] = []
  const want = opts.fetchPositionsFor

  // Decode unique oracles once, sharing a feed-node cache (one feed backs many markets).
  const nodeCache = new Map<string, PriceNode>()
  const uniqueOracles = [...new Set(markets.map((m) => m.oracle).filter((o): o is string => !!o))]
  for (const oracle of uniqueOracles) {
    const ctx: DecodeContext = { rpc, block, leaves, deviationPct: opts.deviationPct, nodeCache }
    try {
      const tree = await decodeMorphoOracle(ctx, oracle)
      if (tree) trees.set(oracle, tree)
    } catch {
      /* left undecoded */
    }
  }

  for (const m of markets) {
    const tree = m.oracle ? trees.get(m.oracle) : undefined
    if (!tree) {
      undecoded.push(m)
      continue
    }
    const ids = leafIds(tree)
    const fetchPos = ids.some((id) => want?.has(leaves[id]?.address ?? '')) || (want === undefined && m.borrowUsd >= (opts.minBorrowForPositions ?? 1e6))
    let positions: PositionUsd[] | null = null
    if (fetchPos) {
      const borrowers = await fetchBorrowers(m.marketId)
      positions = borrowers.map((b) => ({ collateralUsd: b.collateralUsd, debtUsd: b.borrowUsd }))
    }
    const lif = morphoLif(m.lltv)
    const exposure: Exposure = {
      protocol: 'morpho-blue',
      id: `morpho:${m.marketId.slice(0, 10)}:${m.collateralSymbol}/${m.loanSymbol}`,
      label: `Morpho ${m.collateralSymbol}/${m.loanSymbol} ${(m.lltv * 100).toFixed(1)}%`,
      role: 'collateral',
      tree,
      borrowLtv: m.lltv,
      liqLtv: m.lltv,
      lif,
      closeFactor: 1,
      borrowableUsd: Math.max(0, m.liquidityUsd),
      borrowableHiUsd: Math.max(0, m.liquidityUsd),
      liquidityKey: m.marketId,
      collateralRoomUsd: 0,
      positions,
      aggregate: { collateralUsd: m.collateralUsd, debtUsd: m.borrowUsd },
      notes: positions ? undefined : ['positions not fetched; EV_pt downside uses the aggregate-edge bound'],
    }
    for (const id of ids) {
      if (leaves[id]?.kind === 'linear-discount') continue // the non-moved safety branch
      byLeaf.set(id, [...(byLeaf.get(id) ?? []), exposure])
    }
  }

  return { byLeaf, trees, leaves, undecoded, scanned: markets.length }
}
