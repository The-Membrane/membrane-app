/**
 * Builds the Oct 10-11 2025 FULL-COVERAGE Real-vs-Membrane census from the on-chain pull.
 *
 *   MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets npx tsx scripts/oct10-coverage/build-census.ts
 *
 * Reads (all in <datasets>/recall-coverage/inputs/oct10/; the list is censusInputs.ts):
 *   the owner's CSVs and the on-chain pull's _extra CSVs, the event re-reads (+ extras), the
 *   Aave protocol fee of every event, the AaveOracle minute path of every market with events
 *   and the Morpho oracle paths of every chain, onchain/events-scan.json (the scope), and
 *   chainlink_rounds.csv + onchain/chainlink-check.json (cross-check); for the cross-check
 *   only, this repo's public/data/oct10-2025/evidence.json and prices-1m.json (the old census
 *   and its Chainlink grid).
 *
 * Writes:
 *   <datasets>/oct10-2025/coverage/census.json        canonical: meta + one row per position
 *   <datasets>/oct10-2025/coverage/replay.jsonl.gz    canonical: the whole stream (schema v2)
 *   <datasets>/oct10-2025/coverage/PROVENANCE.md
 *   public/data/oct10-2025/wavefront-replay.json      served: the compact replay
 *   public/data/oct10-2025/coverage-summary.json      served: the small summary
 *
 * Flags: --no-write (compute and print only).
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '../../lib/position-sim/membrane'
import {
  BTC_SYMBOLS,
  ETH_SYMBOLS,
  NAMED_CLUSTERS,
  OWN_CLUSTER_MIN_POSITIONS,
} from '../../lib/wavefront/cluster'
import { aaveMarketLabel } from '../../lib/wavefront/pid'
import { STREAM_SCHEMA, encodeCompact, encodeJsonl } from '../../lib/wavefront/stream'
import { datasetsDir } from '../lib/datasetsDir.mjs'
import { buildCensus, MAX_SALES, type CensusRow } from './census'
import { censusInputFiles, loadCensusInputs } from './censusInputs'
import { crossCheck } from './crossCheck'

const ROOT = process.cwd()
const NO_WRITE = process.argv.includes('--no-write')
const DATASETS = datasetsDir(ROOT)
const INPUTS = path.join(DATASETS, 'recall-coverage', 'inputs', 'oct10')
const ONCHAIN = path.join(INPUTS, 'onchain')
const OUT_DIR = path.join(DATASETS, 'oct10-2025', 'coverage')
const SERVED = path.join(ROOT, 'public', 'data', 'oct10-2025')

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const r2 = (x: number) => Math.round(x * 100) / 100
const r6 = (x: number) => Math.round(x * 1e6) / 1e6

// ---- inputs ----------------------------------------------------------------------------
const inputFiles = [
  ...censusInputFiles(DATASETS),
  path.join(ONCHAIN, 'events-scan.json'),
  path.join(ONCHAIN, 'chainlink-check.json'),
  path.join(INPUTS, 'chainlink_rounds.csv'),
]
const inputs = loadCensusInputs(DATASETS)
const window = inputs.window
const scan = JSON.parse(fs.readFileSync(path.join(ONCHAIN, 'events-scan.json'), 'utf8'))

// ---- the census ---------------------------------------------------------------------------
const t0 = Date.now()
const census = buildCensus(inputs)
const noWalkOn = buildCensus(inputs, { stopAfterT0BandSale: true })
const nm1First = buildCensus(inputs, { basisOrder: ['N-1', 'N'] })
const elapsed = Date.now() - t0
const rows = census.rows

// ---- summaries ------------------------------------------------------------------------------
type Agg = ReturnType<typeof agg>
function agg(rs: CensusRow[]) {
  const walked = rs.filter((r) => r.walked)
  const realOf = (xs: CensusRow[]) => ({
    positions: xs.length,
    events: xs.reduce((a, r) => a + r.real.events, 0),
    repaidUsd: r2(xs.reduce((a, r) => a + r.real.repaidUsd, 0)),
    seizedUsd: r2(xs.reduce((a, r) => a + r.real.seizedUsd, 0)),
    protocolFeeUsd: r2(xs.reduce((a, r) => a + r.real.protocolFeeUsd, 0)),
    badDebtUsd: r2(xs.reduce((a, r) => a + r.real.badDebtUsd, 0)),
    unpricedEvents: xs.reduce((a, r) => a + r.real.unpricedEvents, 0),
    unpricedPositions: xs.filter((r) => r.real.unpricedEvents > 0).length,
  })
  const mems = walked.map((r) => r.mem!)
  return {
    positions: rs.length,
    walked: walked.length,
    notWalked: rs.length - walked.length,
    realAll: realOf(rs),
    realWalked: realOf(walked),
    mem: {
      positions: walked.length,
      repaidUsd: r2(mems.reduce((a, m) => a + m.repaidUsd, 0)),
      soldUsd: r2(mems.reduce((a, m) => a + m.soldUsd, 0)),
      sales: mems.reduce((a, m) => a + m.sales, 0),
      positionsSold: mems.filter((m) => m.sales > 0).length,
      positionsSoldAtGridEnd: mems.filter((m) => m.armedAtGridEnd).length,
      positionsKept: mems.filter((m) => m.sales === 0).length,
      unpricedSales: mems.reduce((a, m) => a + m.unpricedSales, 0),
      unpricedPositions: walked.filter((r) => r.mem!.unpricedSales > 0 || r.collUsd == null).length,
    },
  }
}
const by = <K extends string>(rs: CensusRow[], key: (r: CensusRow) => K) => {
  const m = new Map<K, CensusRow[]>()
  for (const r of rs) {
    const k = key(r)
    m.set(k, [...(m.get(k) ?? []), r])
  }
  return m
}
/** Coverage key: venue × chain — 'aave-v3:<market>:<chain>' or 'morpho-blue:<chain>'. */
const venueChain = (r: CensusRow) => `${r.venue}:${r.chain}`
const byPC = by(rows, venueChain)
const pcKeys = [...byPC.keys()].sort()
const totalsByPC: Record<string, Agg> = Object.fromEntries(
  pcKeys.map((k) => [k, agg(byPC.get(k)!)]),
)
const totalsByProtocol: Record<string, Agg> = Object.fromEntries(
  [...by(rows, (r) => r.protocol)].sort().map(([k, v]) => [k, agg(v)]),
)
const all = agg(rows)

const uncovered = rows
  .filter((r) => !r.walked)
  .map((r) => ({
    pid: r.pid,
    protocol: r.protocol,
    venue: r.venue,
    chain: r.chain,
    reason: r.reason,
    events: r.events,
    realRepaidUsd: r2(r.real.repaidUsd),
    ltv0: r.ltv0 == null ? null : r6(r.ltv0),
    line: r.line == null ? null : r6(r.line),
  }))
const excludedByReason: Record<string, number> = {}
for (const u of uncovered) {
  const k = (u.reason ?? '').replace(/ \(\d+\)$/, '')
  excludedByReason[k] = (excludedByReason[k] ?? 0) + 1
}

const outcomes: Record<string, number> = {}
for (const r of rows) if (r.mem) outcomes[r.mem.outcome] = (outcomes[r.mem.outcome] ?? 0) + 1
const clusters = Object.fromEntries(
  [...by(rows, (r) => r.cluster)]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, v]) => {
      const a = agg(v)
      return [
        k,
        {
          positions: a.positions,
          walked: a.walked,
          realRepaidUsdWalked: a.realWalked.repaidUsd,
          memRepaidUsd: a.mem.repaidUsd,
          positionsSold: a.mem.positionsSold,
        },
      ]
    }),
)
const classes = Object.fromEntries(
  [...by(rows, (r) => `${r.protocol}:${r.delayClass}`)].sort().map(([k, v]) => [k, v.length]),
)
const noWalkOnRows = new Map(noWalkOn.rows.map((r) => [r.pid, r]))
const noWalkOnChanged = rows.filter(
  (r) =>
    r.mem && Math.abs((noWalkOnRows.get(r.pid)!.mem?.repaidUsd ?? 0) - r.mem.repaidUsd) > 0.005,
)
const noWalkOnTotal = noWalkOn.rows.reduce((a, r) => a + (r.mem?.repaidUsd ?? 0), 0)

// The t0 price-basis residual: positions located at BOTH bases whose t0 band decision differs.
const nm1Rows = new Map(nm1First.rows.map((r) => [r.pid, r]))
const basisDiffers = rows.filter(
  (r) =>
    r.walked &&
    r.t0AltBasis?.located &&
    r.t0AltBasis.decisions &&
    r.t0Decisions!.join('+') !== r.t0AltBasis.decisions.join('+'),
)
const memOf = (r: CensusRow | undefined) => r?.mem?.repaidUsd ?? 0
const nm1Total = nm1First.rows.reduce((a, r) => a + memOf(r), 0)

const sensitivity = {
  noWalkOnAfterT0BandSale: {
    rule: 'The headline walks a delayed position sold at t0 past line x (1 + band) on after that sale, like every other sale: a sale leaves no timer (a band break or an expiry deletes it, LiquidationEngine.sol:1724-1727 at 16e12329; an Immediate sale, :1694-1703, never had one) and nothing closes the position. This rebuild stops it after the one t0 repay — the behaviour before 2026-10-14.',
    memRepaidUsd: r2(noWalkOnTotal),
    deltaUsd: r2(all.mem.repaidUsd - noWalkOnTotal),
    deltaNote: 'headline minus this rebuild: the Membrane sales the old stop hid',
    positionsChanged: noWalkOnChanged.length,
    positionsSoldAtT0PastBand: rows.filter(
      (r) =>
        r.mem &&
        (r.mem.outcome === 'sold-at-t0' || r.mem.subs?.some((s) => s.outcome === 'sold-at-t0')),
    ).length,
  },
  t0PriceBasis: {
    rule: "t0 is valued at block-N oracle prices, or at block N-1 where N does not show the breach the protocol liquidated. For positions the protocol's own check locates at BOTH bases, this counts those whose t0 decision (per half: under the line / inside the band / past the band / no-delay sale) differs between the two, and rebuilds the census valuing every position at N-1 wherever N-1 locates it.",
    positionsLocatedAtBoth: rows.filter((r) => r.walked && r.t0AltBasis?.located).length,
    positionsDecisionDiffers: basisDiffers.length,
    memRepaidUsdOnThem: r2(basisDiffers.reduce((a, r) => a + memOf(r), 0)),
    memRepaidUsdOnThemAtNm1: r2(basisDiffers.reduce((a, r) => a + memOf(nm1Rows.get(r.pid)), 0)),
    examples: basisDiffers.slice(0, 20).map((r) => ({
      pid: r.pid,
      decisionAtBasis: `${r.t0!.priceBasis}: ${r.t0Decisions!.join('+')}`,
      decisionAtOther: `${r.t0AltBasis!.priceBasis}: ${r.t0AltBasis!.decisions!.join('+')}`,
      memRepaidUsd: r2(memOf(r)),
      memRepaidUsdOther: r2(memOf(nm1Rows.get(r.pid))),
    })),
    wholeCensusAtNm1FirstMemRepaidUsd: r2(nm1Total),
    wholeCensusDeltaUsd: r2(nm1Total - all.mem.repaidUsd),
  },
}

// ---- concentration and the t0-depth limit ---------------------------------------------------
const walkedByMem = rows.filter((r) => r.walked).sort((a, b) => memOf(b) - memOf(a))
const memTotal = all.mem.repaidUsd
const concentration = {
  top1: {
    pid: walkedByMem[0].pid,
    ltv0: r6(walkedByMem[0].ltv0!),
    line: r6(walkedByMem[0].line!),
    outcome: walkedByMem[0].mem!.outcome,
    memRepaidUsd: r2(memOf(walkedByMem[0])),
    shareOfMem: +(memOf(walkedByMem[0]) / memTotal).toFixed(4),
  },
  top10ShareOfMem: +(walkedByMem.slice(0, 10).reduce((a, r) => a + memOf(r), 0) / memTotal).toFixed(
    4,
  ),
  top10: walkedByMem.slice(0, 10).map((r) => ({
    pid: r.pid,
    ltv0: r6(r.ltv0!),
    outcome: r.mem!.outcome,
    memRepaidUsd: r2(memOf(r)),
  })),
}

// ---- scope ---------------------------------------------------------------------------------------
const scope = {
  inScope:
    'Every Aave V3 pool registered in the PoolAddressesProviderRegistry of mainnet, Arbitrum, Optimism and Base, and the Morpho Blue singleton of each of those chains (recall-coverage/inputs/oct10/onchain/events-scan.json).',
  markets: Object.entries(scan.chains as Record<string, any>).flatMap(([chain, c]) => [
    ...c.aaveMarkets.map((m: any) => ({
      chain,
      venue: `aave-v3:${aaveMarketLabel(chain, m.pool, m.marketId)}`,
      name: m.marketId,
      pool: m.pool,
      events: m.liquidationCalls,
      inOwnerCsv: m.inCsv,
    })),
    {
      chain,
      venue: 'morpho-blue',
      name: 'Morpho Blue',
      pool: c.morphoBlue.address,
      events: c.morphoBlue.liquidates,
      inOwnerCsv: c.morphoBlue.inCsv,
    },
  ]),
  pid: 'lib/wavefront/pid.ts: aave-v3:<chain>:<pool>:<user> (the pool ADDRESS; the label core / lido / etherfi is display only, aaveMarketLabel), morpho-blue:<chain>:<marketId>:<borrower>.',
  outOfScope: {
    rule: scan.outOfScope.chains,
    avalancheAaveV3LiquidationCalls: Math.max(
      ...Object.values(scan.outOfScope.avalanche.liquidationCalls as Record<string, number>),
    ),
    otherEmitters: Object.entries(scan.chains as Record<string, any>).flatMap(([chain, c]) =>
      c.otherEmitters.map((o: any) => ({
        chain,
        label: o.label,
        kind: o.kind,
        liquidationCalls: o.liquidationCall,
        liquidates: o.liquidate,
      })),
    ),
  },
}

// ---- cross-check against the old census --------------------------------------------------
const xc = crossCheck({
  rows,
  inputs,
  evidencePath: path.join(SERVED, 'evidence.json'),
  pricesPath: path.join(SERVED, 'prices-1m.json'),
  roundsPath: path.join(INPUTS, 'chainlink_rounds.csv'),
  chainlinkCheckPath: path.join(ONCHAIN, 'chainlink-check.json'),
})

// ---- documents ------------------------------------------------------------------------------
const rel = (p: string) => path.relative(DATASETS, p)
const inputsMeta = inputFiles.map((f) => {
  const b = fs.readFileSync(f)
  return { path: rel(f), bytes: b.length, sha256: sha(b) }
})
const appInputsMeta = ['evidence.json', 'prices-1m.json'].map((f) => {
  const b = fs.readFileSync(path.join(SERVED, f))
  return { path: `membrane-app:public/data/oct10-2025/${f}`, bytes: b.length, sha256: sha(b) }
})

const method = {
  positions:
    'Every (chain, market, user) Aave V3 account and every (chain, market, borrower) Morpho Blue position with a liquidation on chain in 2025-10-10T00:00Z .. 2025-10-11T23:59Z, at the scope in meta.scope: the owner CSVs plus the on-chain events they lack (recall-coverage/inputs/oct10/onchain/*_extra*). pid: lib/wavefront/pid.ts.',
  aave: "Composition at the t0 event's block N-1 (the pull's full re-read): collateral = reserves with aToken > 0, collateral flag on and LT > 0 under the user's e-mode; debt = reserves with variable debt > 0. Valued with Aave's rounding (floor collateral, ceil debt) at the t0 prices. Line = Aave's weighted LT at those prices = sum(coll_i x LT_i) / sum(coll_i); LTV0 = debt / coll. LOCATING t0: the first event whose health factor (the pull's exact recompute, composition at N-1) is below 1 at block-N AaveOracle prices; if not at N, at block N-1 prices (the pull reads prices at the END of block N, and an oracle update later in block N than the liquidation can hide the breach the liquidator saw); priceBasis says which. Collateral worth 0 base units at those prices is dropped (Aave counts it as 0).",
  morpho:
    "Composition at the t0 event's N-1: collateral amount; borrowed = shares -> assets rounded UP, interest accrued to ts(N). Line = LLTV. LTV(m) = borrowed / (collateral x oracle price(m) / 1e36), anchored at the t0 price. LOCATING t0: the first event Morpho's own check finds liquidatable (borrowed > collateral x price / 1e36 x LLTV) with the price at N, else with the price at N-1 (debt accrued to N either way); priceBasis says which. Interest after t0 is not added.",
  path: "Each leg moves with its own protocol-oracle minute path (each market's AaveOracle; the market's Morpho oracle), value(m) = value_t0 x p(m) / p_t0 for every minute m after t0's minute, where p(m) is the price in force at the minute START (block <= minute start) — no look-ahead. A held leg with no price at a minute walked is a hard error (never carried forward); this pull has none. Grid ends at minute 2,879 (2025-10-11T23:59Z).",
  delayClass:
    "collateralClass.ts delayClassOf(<every collateral symbol>, line) on the FULL composition. MIXED -> walked as the two positions Membrane would hold, exactly as compare.ts splitByDelayClass splits one: no-delay legs (sub 0) and delayed legs (sub 1), debt pro rata to collateral value at t0 (both halves open at the position's own LTV), each half at its own LT-weighted line and its own class delayClassOf(its symbols, its line). A half that opens under its own line just walks. The position's Membrane figures are the sum of its halves.",
  membrane:
    'lib/wavefront/kernel.ts per half: DelayTimer from curePath.ts and cureSale (the same sale step cureWalk runs) — repay-to-cap with membraneRepayValue and the liqDebtMinimum floor, seized == repaid (no fee), walk on after a sale (max 20 sales), the conservative sale at the grid end for a delay still running. Repaid/sold USD at the sale minute (Morpho: x the loan token USD). A delayed position past the band at t0 is sold at once and walked on like after any sale (as cureWalk); stopping it after that one repay is meta.sensitivity.noWalkOnAfterT0BandSale.',
  real: "Aave: debt_to_cover_normalized x the debt reserve AaveOracle price at block N; seized = everything taken from the borrower's collateral — the event's liquidatedCollateralAmount PLUS the liquidation protocol fee sent to the treasury (aave-protocol-fee.jsonl.gz collateralSeizedTotalRaw; the fee is the treasury aToken transfer in the event's own receipt) — x the collateral reserve price at N. Morpho: repaid_assets_normalized x loan USD; seized collateral at the event oracle price(N) in loan units x loan USD; realised bad debt reported separately (not repaid). Loan USD: $1.00 for a dollar stable held at one (collateralClass.ts heldAtOne), else the chain's core AaveOracle price of the same token from the minute path at the event minute (the price in force at the minute START, not at block N), else unpriced (USD null on both sides, counted). For an unpriced loan the LTV path is unaffected but the liqDebtMinimum floor (a USD figure) cannot be applied, so those repays are sized without it.",
  cluster: `Largest collateral leg by USD at t0: ETH (${ETH_SYMBOLS.join(', ')}), BTC (${BTC_SYMBOLS.join(', ')}), ${NAMED_CLUSTERS.join(', ')}, Stables (collateralClass.ts isStable); any other symbol that is the primary leg of >= ${OWN_CLUSTER_MIN_POSITIONS} positions is its own cluster (${census.stats.ownClusters.join(', ')}); else Other.`,
  sameSet:
    'Both sides are reported on the same positions: the WALKED ones. The stream reducer folds real records into its totals for walked positions only; a position not walked counts in coverage and nowhere else. USD totals skip a position whose loan token has no USD price, on both sides.',
}

const censusDoc = {
  meta: {
    schema: 'oct10-coverage-census/v2',
    streamSchema: STREAM_SCHEMA,
    generatedBy: 'membrane-app scripts/oct10-coverage/build-census.ts',
    window: {
      ...window,
      from: '2025-10-10T00:00:00Z',
      to: '2025-10-11T23:59:00Z (minute start of the last step)',
    },
    params: {
      band: MAX_THRESHOLD_TO_DELAY,
      delaySeconds: CURE_WINDOW_SECONDS,
      borrowLtvGap: BORROW_LTV_GAP,
      liqDebtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
      maxSales: MAX_SALES,
    },
    method,
    scope,
    inputs: [...inputsMeta, ...appInputsMeta],
    coverage: {
      total: all.positions,
      walked: all.walked,
      notWalked: all.notWalked,
      byProtocolChain: pcKeys.map((k) => ({
        key: k,
        total: totalsByPC[k].positions,
        walked: totalsByPC[k].walked,
        notWalked: totalsByPC[k].notWalked,
      })),
      uncovered,
      excludedByReason,
      oldCensusNote: `The old census (public/data/oct10-2025/evidence.json) had 2,350 Aave cohort rows when the pull was planned: 68 of the 2,418 owner-CSV accounts dropped because no event of theirs had a debt symbol with a series. 2,350 + 745 Morpho = the "3,095" quoted earlier. On this branch it has 2,347: Part 1 (L9) stopped pinning sUSD at $1, which drops 3 more (71). This census has every position at the full scope: ${totalsByProtocol['aave-v3'].positions.toLocaleString('en-US')} Aave + ${totalsByProtocol['morpho-blue'].positions.toLocaleString('en-US')} Morpho = ${all.positions.toLocaleString('en-US')} (the owner CSVs' 2,418 + 745 plus 3 Aave Lido accounts and 31 Morpho Arbitrum positions found on chain).`,
    },
    totals: { all, byProtocol: totalsByProtocol, byProtocolChain: totalsByPC },
    stream: {
      records: census.records.length,
      finalTick: census.records[census.records.length - 1],
    },
    classes,
    clusters,
    outcomes,
    concentration,
    stats: census.stats,
    sensitivity,
    crossCheck: xc,
  },
  rows,
}

const summaryDoc = {
  source:
    'Canonical: membrane-datasets oct10-2025/coverage/census.json (built by membrane-app scripts/oct10-coverage/build-census.ts). This file is the small served copy.',
  window: censusDoc.meta.window,
  scope: { inScope: scope.inScope, markets: scope.markets, outOfScope: scope.outOfScope },
  coverage: {
    total: all.positions,
    walked: all.walked,
    notWalked: all.notWalked,
    byProtocolChain: censusDoc.meta.coverage.byProtocolChain,
    uncovered,
  },
  totals: {
    walked: { real: all.realWalked, mem: all.mem },
    all: { real: all.realAll },
    byProtocol: Object.fromEntries(
      Object.entries(totalsByProtocol).map(([k, a]) => [k, { real: a.realWalked, mem: a.mem }]),
    ),
    byProtocolChain: Object.fromEntries(
      Object.entries(totalsByPC).map(([k, a]) => [k, { real: a.realWalked, mem: a.mem }]),
    ),
  },
  classes,
  clusters,
  outcomes,
  concentration: { top1: concentration.top1, top10ShareOfMem: concentration.top10ShareOfMem },
  sensitivity: {
    noWalkOnAfterT0BandSale: sensitivity.noWalkOnAfterT0BandSale,
    t0PriceBasis: { ...sensitivity.t0PriceBasis, examples: undefined },
  },
  morphoBadDebt: census.stats.morphoBadDebt,
  newBorrowingAfterLiquidation: census.stats.newBorrowingAfterLiquidation,
  crossCheck: xc.summary,
}

// ---- print ----------------------------------------------------------------------------------
const fmt = (x: number) => `$${(x / 1e6).toFixed(2)}M`
console.log(
  `census: ${rows.length} positions, ${all.walked} walked, ${all.notWalked} not (${elapsed} ms for 3 builds)`,
)
for (const k of pcKeys) {
  const a = totalsByPC[k]
  console.log(
    `  ${k.padEnd(22)} ${String(a.walked).padStart(4)}/${String(a.positions).padEnd(4)} real repaid ${fmt(a.realWalked.repaidUsd)} seized ${fmt(a.realWalked.seizedUsd)}  mem repaid ${fmt(a.mem.repaidUsd)} sold ${a.mem.positionsSold} kept ${a.mem.positionsKept} gridEnd ${a.mem.positionsSoldAtGridEnd}`,
  )
}
console.log(
  `  ALL walked: real repaid ${fmt(all.realWalked.repaidUsd)} seized ${fmt(all.realWalked.seizedUsd)} badDebt ${fmt(all.realWalked.badDebtUsd)} | mem repaid ${fmt(all.mem.repaidUsd)} sold ${fmt(all.mem.soldUsd)} positions sold ${all.mem.positionsSold} kept ${all.mem.positionsKept} (grid-end ${all.mem.positionsSoldAtGridEnd})`,
)
console.log('  uncovered:', excludedByReason)
console.log('  classes:', classes)
console.log('  outcomes:', outcomes)
console.log(
  '  clusters:',
  Object.fromEntries(Object.entries(clusters).map(([k, v]) => [k, v.positions])),
)
console.log('  stats:', JSON.stringify(census.stats))
console.log('  sensitivity:', JSON.stringify(sensitivity))
console.log(
  '  concentration:',
  JSON.stringify({ top1: concentration.top1, top10: concentration.top10ShareOfMem }),
)
console.log('  cross-check:', JSON.stringify(xc.summary, null, 1))
console.log(`  stream records: ${census.records.length}`)

if (NO_WRITE) process.exit(0)

// ---- write ----------------------------------------------------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true })
const censusJson = JSON.stringify(censusDoc, null, 1) + '\n'
const replayGz = gzipSync(Buffer.from(encodeJsonl(window, census.records)), { level: 9 })
const compactJson = JSON.stringify(encodeCompact(window, census.records)) + '\n'
const summaryJson = JSON.stringify(summaryDoc, null, 1) + '\n'
const outputs: [string, Buffer | string][] = [
  [path.join(OUT_DIR, 'census.json'), censusJson],
  [path.join(OUT_DIR, 'replay.jsonl.gz'), replayGz],
  [path.join(SERVED, 'wavefront-replay.json'), compactJson],
  [path.join(SERVED, 'coverage-summary.json'), summaryJson],
]
for (const [p, b] of outputs) fs.writeFileSync(p, b)

// PROVENANCE.md for the canonical directory.
const git = (cmd: string) => {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT }).toString().trim()
  } catch {
    return 'unknown'
  }
}
const head = git('rev-parse HEAD')
const branch = git('rev-parse --abbrev-ref HEAD')
const dirty = git('status --porcelain -- lib/wavefront scripts/oct10-coverage lib/position-sim')
const fileRow = (p: string, b: Buffer | string) =>
  `| \`${path.basename(p)}\` | ${Buffer.byteLength(b).toLocaleString('en-US')} | \`${sha(b)}\` |`
const prov = `# Oct 10-11 2025 full-coverage census (Real vs Membrane)

Every liquidated position of the Oct 10-11 2025 window at the full scope — ${rows.length.toLocaleString('en-US')} = ${totalsByProtocol['aave-v3'].positions.toLocaleString('en-US')} Aave V3 accounts + ${totalsByProtocol['morpho-blue'].positions.toLocaleString('en-US')} Morpho Blue positions — with the protocol's real liquidations on one side and Membrane's engine walked minute by minute on the other, on the same positions, priced from the protocols' OWN oracles read on chain.

**Scope**: ${scope.inScope} Out of scope: every other chain (Avalanche alone: ${scope.outOfScope.avalancheAaveV3LiquidationCalls} Aave V3 LiquidationCalls in the window), Aave V2 and the V3 forks — ${scope.outOfScope.otherEmitters.map((o) => `${o.label} (${o.chain}, ${o.liquidationCalls})`).join(', ')}.

- **Source**: membrane-app \`scripts/oct10-coverage/build-census.ts\` (+ \`census.ts\`, \`crossCheck.ts\`, \`lib/wavefront/\`), branch \`${branch}\`, commit \`${head}\`${dirty ? ' (with uncommitted changes to the census code)' : ''}.
  Command: \`MEMBRANE_DATASETS_DIR=<this repo> npx tsx scripts/oct10-coverage/build-census.ts\`.
- **Path**: \`oct10-2025/coverage/\`
- **Status**: canonical. The app serves two copies: \`public/data/oct10-2025/wavefront-replay.json\` (the compact stream) and \`public/data/oct10-2025/coverage-summary.json\` (the summary). Re-running the command reproduces every file byte for byte.
- **Inputs** (read only):

| input | bytes | sha256 |
| --- | ---: | --- |
${[...inputsMeta, ...appInputsMeta].map((i) => `| \`${i.path}\` | ${i.bytes.toLocaleString('en-US')} | \`${i.sha256}\` |`).join('\n')}

## Files

| file | bytes | sha256 |
| --- | ---: | --- |
${fileRow('census.json', censusJson)}
${fileRow('replay.jsonl.gz', replayGz)}

Served copies (membrane-app \`public/data/oct10-2025/\`):

| file | bytes | sha256 |
| --- | ---: | --- |
${fileRow('wavefront-replay.json', compactJson)}
${fileRow('coverage-summary.json', summaryJson)}

- \`census.json\`: \`meta\` (method, inputs with sha256, coverage table and every uncovered position with its reason, totals for both sides overall / per protocol / per protocol x chain, classes, clusters, outcomes, sensitivity, the cross-check against the old census) and \`rows\` (one per position).
- \`replay.jsonl.gz\`: the wavefront stream, schema v${STREAM_SCHEMA} (\`lib/wavefront/stream.ts\`): a header line, then ${census.records.length.toLocaleString('en-US')} records — \`open\`, \`real\`, \`mem\`, \`tick\` — in time order across all positions.

## Coverage

| venue:chain | positions | walked | not walked |
| --- | ---: | ---: | ---: |
${pcKeys.map((k) => `| ${k} | ${totalsByPC[k].positions} | ${totalsByPC[k].walked} | ${totalsByPC[k].notWalked} |`).join('\n')}
| **all** | **${all.positions}** | **${all.walked}** | **${all.notWalked}** |

Not walked:

${uncovered.length ? uncovered.map((u) => `- \`${u.pid}\`: ${u.reason}`).join('\n') : "None: every position is located by the protocol's own check at block-N prices or, where N does not show the breach, at N-1 (meta.stats.priceBasis, meta.sensitivity.t0PriceBasis)."}

## Method

${Object.entries(method)
  .map(([k, v]) => `- **${k}**: ${v}`)
  .join('\n')}

See membrane-app \`docs/WAVEFRONT.md\` for the long form and the cross-check against the old census.
`
fs.writeFileSync(path.join(OUT_DIR, 'PROVENANCE.md'), prov)
console.log(
  'wrote',
  outputs.map(([p, b]) => `${path.relative(ROOT, p)} (${Buffer.byteLength(b)} B)`).join(', '),
)
