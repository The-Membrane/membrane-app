/**
 * The engine: discover readers, build the cost side, and produce a verdict card per
 * leaf. Two entry points:
 *   - discover(): decode every mainnet lending market's oracle and index exposures and
 *     leaves across Morpho, Aave v3, Spark and Compound III.
 *   - analyzeLeaf(): for one leaf and its exposures, build cost curves + free moves and
 *     run the ratio stage, returning a compact card.
 *
 * Fluid, Euler and Liquity v2 are not yet wired as readers (README gaps); the engine
 * still analyses a leaf's Morpho/Aave/Spark/Compound readers, which is where exotic
 * leaves (Pendle PTs, LRTs, long-tail feeds) actually live.
 */

import type { BlockTag, Rpc } from './chain/rpc'
import { UsdPrices } from './chain/directory'
import type { Exposure, Leaf, Verdict } from './types'
import { describeTree } from './tree'
import type { LeafTable } from './leaf/decode'
import { buildCostSide } from './leaf/costCurves'
import { evaluateRatio, RULINGS, fmt, type RatioResult } from './ratio'
import { buildMorphoExposures, fetchMorphoMarkets, type MorphoMarket } from './ev/morpho'
import { buildAaveFamily, AAVE_V3, SPARK } from './ev/aaveFamily'
import { buildComet, COMETS } from './ev/compound'
import type { CostResult } from './leaf/costCurves'

export interface Discovery {
  leaves: LeafTable
  byLeaf: Map<string, Exposure[]>
  prices: UsdPrices
  venues: { venue: string; readers: number; undecoded: number; note?: string }[]
  morphoUndecoded: MorphoMarket[]
}

export interface DiscoverOptions {
  deviationPct?: Record<string, number>
  /** Only decode Morpho markets whose oracle reads one of these leaf addresses. */
  restrictToLeaves?: Set<string>
  minBorrowUsd?: number
  minBorrowForPositions?: number
  /** Skip the Aave/Spark/Compound sweep (used by the targeted/fork path). */
  morphoOnly?: boolean
  seedPrices?: Record<string, number>
}

function mergeByLeaf(target: Map<string, Exposure[]>, src: Map<string, Exposure[]>): void {
  for (const [k, v] of src) target.set(k, [...(target.get(k) ?? []), ...v])
}

export async function discover(rpc: Rpc, block: BlockTag, opts: DiscoverOptions = {}): Promise<Discovery> {
  const leaves: LeafTable = {}
  const byLeaf = new Map<string, Exposure[]>()
  const prices = new UsdPrices(opts.seedPrices)
  const venues: Discovery['venues'] = []

  const markets = await fetchMorphoMarkets(opts.minBorrowUsd ?? 100_000)
  const wanted = opts.restrictToLeaves
  const mkts = wanted ? markets : markets
  const morpho = await buildMorphoExposures(rpc, mkts, block, {
    deviationPct: opts.deviationPct,
    fetchPositionsFor: wanted,
    minBorrowForPositions: opts.minBorrowForPositions ?? 2_000_000,
  })
  Object.assign(leaves, morpho.leaves)
  mergeByLeaf(byLeaf, morpho.byLeaf)
  venues.push({ venue: 'morpho-blue', readers: [...morpho.byLeaf.values()].reduce((a, v) => a + v.length, 0), undecoded: morpho.undecoded.length })

  if (!opts.morphoOnly) {
    for (const def of [AAVE_V3, SPARK]) {
      try {
        const r = await buildAaveFamily(rpc, def, block, { deviationPct: opts.deviationPct, leaves })
        mergeByLeaf(byLeaf, r.byLeaf)
        for (const res of r.reserves) if (res.priceUsd > 0) prices.set(res.asset, res.priceUsd)
        venues.push({ venue: def.key, readers: [...r.byLeaf.values()].reduce((a, v) => a + v.length, 0), undecoded: r.undecoded.length })
      } catch (e) {
        venues.push({ venue: def.key, readers: 0, undecoded: 0, note: `skipped: ${(e as Error).message.slice(0, 80)}` })
      }
    }
    for (const def of COMETS) {
      try {
        const r = await buildComet(rpc, def, block, { deviationPct: opts.deviationPct, leaves })
        mergeByLeaf(byLeaf, r.byLeaf)
        venues.push({ venue: def.key, readers: [...r.byLeaf.values()].reduce((a, v) => a + v.length, 0), undecoded: r.undecoded.length })
      } catch (e) {
        venues.push({ venue: def.key, readers: 0, undecoded: 0, note: `skipped: ${(e as Error).message.slice(0, 80)}` })
      }
    }
  }

  return { leaves, byLeaf, prices, venues, morphoUndecoded: morpho.undecoded }
}

export interface LeafCard {
  leafId: string
  address: string
  kind: string
  label: string
  verdict: Verdict
  reasons: string[]
  rLo: number | null
  rPt: number | null
  cLoAtWorstUsd: number | null
  freeMoveEvUsd: number
  freeMoveEvHiUsd: number
  readers: { id: string; label: string; protocol: string; borrowUsd: number; collateralUsd: number; hasPositions: boolean }[]
  readerCount: number
  totalBorrowUsd: number
  best: RatioResult['best']
  trees: string[]
  costFacts: Record<string, string | number | boolean | null>
  curve: RatioResult['curve']
  competitiveCostNote?: string
  notes: string[]
  /** Owner-ruling context line that every card carries. */
  pastAttackNote: string
  /** v1 scope disclaimer the owner required on every card. */
  scopeNote: string
  evScopeNote: string
  generatedAt: string
  block: number | null
}

export interface AnalyzeOptions {
  volClass?: 'stable' | 'lst' | 'major' | 'alt'
  pullStalenessSec?: number
  curvePair?: { i: number; j: number }
  blockNumber?: number | null
}

export async function analyzeLeaf(
  rpc: Rpc,
  leaf: Leaf,
  exposures: Exposure[],
  block: BlockTag,
  prices: UsdPrices,
  opts: AnalyzeOptions = {},
): Promise<{ card: LeafCard; result: RatioResult; cost: CostResult }> {
  const cost = await buildCostSide(rpc, leaf, block, prices, { volClass: opts.volClass, pullStalenessSec: opts.pullStalenessSec, curvePair: opts.curvePair })
  const result = evaluateRatio({ leafId: leaf.id, exposures, cost: cost.cost, freeMoves: cost.freeMoves, hardRed: cost.hardRed })
  const readers = exposures.map((e) => ({
    id: e.id,
    label: e.label,
    protocol: e.protocol,
    borrowUsd: e.aggregate.debtUsd,
    collateralUsd: e.aggregate.collateralUsd,
    hasPositions: !!e.positions,
  }))
  const trees = [...new Set(exposures.map((e) => describeTree(e.tree)))]
  const card: LeafCard = {
    leafId: leaf.id,
    address: leaf.address,
    kind: leaf.kind,
    label: leaf.label,
    verdict: result.verdict,
    reasons: result.reasons,
    rLo: round(result.rLo),
    rPt: round(result.rPt),
    cLoAtWorstUsd: round(result.cLoAtWorstUsd),
    freeMoveEvUsd: round(result.freeMoveEvUsd) ?? 0,
    freeMoveEvHiUsd: round(result.freeMoveEvHiUsd) ?? 0,
    readers,
    readerCount: readers.length,
    totalBorrowUsd: round(exposures.reduce((a, e) => a + e.aggregate.debtUsd, 0)) ?? 0,
    best: result.best,
    trees,
    costFacts: cost.facts,
    curve: result.curve,
    competitiveCostNote: result.competitiveCostNote,
    notes: [...cost.notes, ...exposures.flatMap((e) => e.notes ?? [])].filter((v, i, a) => a.indexOf(v) === i),
    pastAttackNote: `Every measured past oracle attack had cost / extracted ≤ ${RULINGS.pastAttackMaxRatio}. R below ${RULINGS.rLoRed} means the cheapest move is within that danger band.`,
    scopeNote: 'v1 covers Ethereum mainnet only. The data is NOT exhaustive and will be extended (other chains, Euler/Fluid/Liquity readers, Membrane Cdp positions).',
    evScopeNote: 'EV scope = every mainnet market reading this leaf that the engine enumerates (Morpho, Aave v3, Spark, Compound III). Euler, Fluid and Liquity v2 readers are not yet included.',
    generatedAt: new Date().toISOString(),
    block: opts.blockNumber ?? null,
  }
  return { card, result, cost }
}

function round(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return n === undefined ? null : n
  const a = Math.abs(n)
  if (a === 0) return 0
  const digits = a >= 1 ? 4 : 6
  return Number(n.toPrecision(digits))
}

export { fmt }
