/**
 * Analyse a single leaf by address: find its Morpho readers (the venue where exotic
 * leaves live), build its cost side and run the ratio stage. Fast enough for a fork
 * test because it decodes only the markets that read the leaf.
 *
 * The leaf's kind is taken from the Morpho oracle decode when the leaf appears in a
 * market tree; otherwise the caller supplies a seed entry.
 */

import type { BlockTag, Rpc } from './chain/rpc'
import { UsdPrices } from './chain/directory'
import { fetchMorphoMarkets, buildMorphoExposures } from './ev/morpho'
import { analyzeLeaf, type AnalyzeOptions, type LeafCard } from './engine'
import type { Leaf } from './types'

export interface AnalyzeOneOptions extends AnalyzeOptions {
  deviationPct?: Record<string, number>
  seedPrices?: Record<string, number>
  minBorrowUsd?: number
  /** Override/augment the decoded leaf (kind, label) when the decode is ambiguous. */
  leafOverride?: Partial<Leaf>
}

export async function analyzeOneLeaf(
  rpc: Rpc,
  leafAddress: string,
  block: BlockTag,
  opts: AnalyzeOneOptions = {},
): Promise<{ card: LeafCard } | null> {
  const addr = leafAddress.toLowerCase()
  const markets = await fetchMorphoMarkets(opts.minBorrowUsd ?? 100_000)
  const ex = await buildMorphoExposures(rpc, markets, block, {
    deviationPct: opts.deviationPct,
    fetchPositionsFor: new Set([addr]),
  })
  // Find the leaf id whose address matches (the decode keys leaves by a typed id).
  const entry = Object.values(ex.leaves).find((l) => l.address === addr)
  if (!entry) return null
  const leaf: Leaf = { ...entry, ...opts.leafOverride }
  const exposures = ex.byLeaf.get(entry.id) ?? []
  const prices = new UsdPrices(opts.seedPrices)
  const blockNumber = block === 'latest' ? null : Number(block)
  const { card } = await analyzeLeaf(rpc, leaf, exposures, block, prices, { ...opts, blockNumber })
  return { card }
}
