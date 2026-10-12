/**
 * Build the oracle-manipulation ratio dataset.
 *
 *   tsx scripts/research/build-oracle-manipulation.ts [--block N] [--min USD]
 *        [--leaf 0x..] [--out DIR] [--max-leaves N] [--morpho-only]
 *
 * Discovers every mainnet lending market's oracle (Morpho, Aave v3, Spark, Compound
 * III), decomposes each into leaves, and for every movable leaf computes the cost side,
 * the EV across its readers, the R_lo/R_pt curves and the verdict per the owner rulings.
 *
 * Output (public/data/oracle-manipulation/):
 *   index.json           — every leaf: id, kind, verdict, R_lo, R_pt, reader count, EV.
 *   leaf/<safeId>.json   — full card (curve, readers, cost facts) for movable or
 *                          non-green leaves (green inert leaves stay in the index only).
 *   meta.json            — block, venues, coverage gaps, ruling thresholds, provenance.
 * Disk is tight: cards are small and only interesting leaves get a detail file, so the
 * whole dataset stays well under 20 MB.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { Rpc } from '@/lib/oracleRegistry/manipulation/chain/rpc'
import { fetchChainlinkDirectory } from '@/lib/oracleRegistry/manipulation/chain/directory'
import { discover, analyzeLeaf, type LeafCard } from '@/lib/oracleRegistry/manipulation/engine'
import { loadCatalog } from '@/lib/oracleRegistry/manipulation/catalog/seed'
import type { Leaf } from '@/lib/oracleRegistry/manipulation/types'

interface Args {
  block: bigint | 'latest'
  minUsd: number
  leaf: string | null
  out: string
  maxLeaves: number
  morphoOnly: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    block: get('--block') ? BigInt(get('--block') as string) : 'latest',
    minUsd: Number(get('--min') ?? 250_000),
    leaf: get('--leaf')?.toLowerCase() ?? null,
    out: get('--out') ?? join(process.cwd(), 'public', 'data', 'oracle-manipulation'),
    maxLeaves: Number(get('--max-leaves') ?? 400),
    morphoOnly: argv.includes('--morpho-only'),
  }
}

const safeId = (id: string) => id.replace(/[^a-z0-9]/gi, '_').slice(0, 80)

function readJson(path: string): unknown | null {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const rpc = new Rpc()
  const blockNumber = args.block === 'latest' ? Number(await rpc.blockNumber()) : Number(args.block)
  const block = args.block === 'latest' ? BigInt(blockNumber) : args.block

  process.stderr.write(`[build] chainlink directory…\n`)
  let deviationPct: Record<string, number> = {}
  try {
    deviationPct = (await fetchChainlinkDirectory()).deviationPct
  } catch (e) {
    process.stderr.write(`[build] directory unavailable: ${(e as Error).message}\n`)
  }

  process.stderr.write(`[build] discovering readers at block ${blockNumber}…\n`)
  const disc = await discover(rpc, block, {
    deviationPct,
    minBorrowUsd: args.minUsd,
    morphoOnly: args.morphoOnly,
    restrictToLeaves: args.leaf ? new Set([args.leaf]) : undefined,
  })

  // Catalog hints (curve pairs, volatility classes) by address.
  const catalog = loadCatalog((p) => readJson(join(process.cwd(), p)))
  const hintFor = (addr: string) => catalog.find((c) => c.address === addr)

  // Leaves to analyse: every discovered leaf with ≥1 reader, plus seeded leaves.
  const leafIds = new Set<string>([...disc.byLeaf.keys()])
  for (const c of catalog) {
    const found = Object.values(disc.leaves).find((l) => l.address === c.address)
    if (found) leafIds.add(found.id)
  }
  const targets = (args.leaf ? [...leafIds].filter((id) => disc.leaves[id]?.address === args.leaf) : [...leafIds])
    .map((id) => disc.leaves[id])
    .filter((l): l is Leaf => !!l)
    .sort((a, b) => readersBorrow(disc, b.id) - readersBorrow(disc, a.id))
    .slice(0, args.maxLeaves)

  mkdirSync(args.out, { recursive: true })
  const leafDir = join(args.out, 'leaf')
  if (existsSync(leafDir)) rmSync(leafDir, { recursive: true, force: true })
  mkdirSync(leafDir, { recursive: true })

  const index: Record<string, unknown>[] = []
  let red = 0
  let yellow = 0
  const errors: { leaf: string; error: string }[] = []

  for (const leaf of targets) {
    const exposures = disc.byLeaf.get(leaf.id) ?? []
    const hint = hintFor(leaf.address)
    try {
      const { card } = await analyzeLeaf(rpc, leaf, exposures, block, disc.prices, {
        volClass: hint?.volClass,
        pullStalenessSec: hint?.pullStalenessSec,
        curvePair: hint?.curvePair,
        blockNumber,
      })
      if (card.verdict === 'red') red++
      if (card.verdict === 'yellow') yellow++
      index.push({
        leafId: card.leafId,
        address: card.address,
        kind: card.kind,
        label: card.label,
        verdict: card.verdict,
        rLo: card.rLo,
        rPt: card.rPt,
        cLoAtWorstUsd: card.cLoAtWorstUsd,
        freeMoveEvUsd: card.freeMoveEvHiUsd,
        readerCount: card.readerCount,
        totalBorrowUsd: card.totalBorrowUsd,
      })
      // Detail file for movable / non-green leaves (keeps the dataset small).
      const movable = card.curve.length > 0 || card.freeMoveEvHiUsd > 0 || card.verdict !== 'green'
      if (movable) writeFileSync(join(leafDir, `${safeId(card.leafId)}.json`), JSON.stringify(card))
    } catch (e) {
      errors.push({ leaf: leaf.id, error: (e as Error).message.slice(0, 160) })
    }
  }

  index.sort((a, b) => (b.totalBorrowUsd as number) - (a.totalBorrowUsd as number))
  writeFileSync(join(args.out, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), block: blockNumber, count: index.length, red, yellow, leaves: index }, null, 1))
  writeFileSync(
    join(args.out, 'meta.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        block: blockNumber,
        venues: disc.venues,
        morphoUndecoded: disc.morphoUndecoded.length,
        leavesDiscovered: Object.keys(disc.leaves).length,
        leavesAnalysed: targets.length,
        verdicts: { red, yellow, green: index.length - red - yellow },
        errors,
        rpcStats: rpc.stats(),
        falseEmptyLogChunks: rpc.falseEmptyEvents.length,
        coverageGaps: COVERAGE_GAPS,
        rulings: {
          red: 'R_lo < 1.5, or a hard-red override (read-only reentrancy), or free-move EV ≥ $100k',
          yellow: 'R_pt < 10, or C_lo < $100M floor, or any free-move EV',
          pastAttackMaxRatio: 0.76,
          publication: 'PUBLIC',
        },
      },
      null,
      1,
    ),
  )
  process.stderr.write(`[build] done: ${index.length} leaves (${red} red, ${yellow} yellow), ${errors.length} errors → ${args.out}\n`)
}

function readersBorrow(disc: { byLeaf: Map<string, { aggregate: { debtUsd: number } }[]> }, id: string): number {
  return (disc.byLeaf.get(id) ?? []).reduce((a, e) => a + e.aggregate.debtUsd, 0)
}

const COVERAGE_GAPS = [
  'Euler v2, Fluid and Liquity v2 readers are not yet enumerated (hooks: EulerRouter.getQuote/getConfiguredOracle; Fluid resolver; Liquity v2 branch PriceFeed).',
  'Aave/Spark/Compound downside EV_pt is withheld (no free per-borrower health path); EV_hi uses the aggregate-edge bound.',
  'Membrane Cdp positions are not yet read, so a leaf used only inside Membrane shows EV = 0 externally.',
  'ERC-4626 balance-tracking classification is a read-only heuristic; a donation-cost claim is a CANDIDATE until confirmed against source.',
  'Pull-feed (Pyth/RedStone) free moves use an assumed staleness window and volatility class; set them per leaf in the catalog.',
  'USD prices for non-stable pool tokens come from the Aave oracle; leaves whose venues do not price a token skip the cost curve.',
  'v1 is Ethereum mainnet only.',
]

main().catch((e) => {
  process.stderr.write(`[build] fatal: ${e.stack ?? e}\n`)
  process.exit(1)
})
