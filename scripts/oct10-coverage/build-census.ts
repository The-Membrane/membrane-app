/**
 * Builds the Oct 10-11 2025 FULL-COVERAGE Real-vs-Membrane census from the on-chain pull.
 *
 *   MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets npx tsx scripts/oct10-coverage/build-census.ts
 *
 * Reads (all in <datasets>/recall-coverage/inputs/oct10/):
 *   aave_liquidations_enriched.csv, morpho_liquidations.csv, chainlink_rounds.csv (cross-check),
 *   onchain/aave-events.jsonl.gz, onchain/morpho-events.jsonl.gz,
 *   onchain/aave-oracle-1m.<chain>.json.gz, onchain/morpho-oracle-1m.<chain>.json.gz
 * and, for the cross-check only, this repo's public/data/oct10-2025/evidence.json and
 * prices-1m.json (the old census and its Chainlink grid).
 *
 * Writes:
 *   <datasets>/oct10-2025/coverage/census.json        canonical: meta + one row per position
 *   <datasets>/oct10-2025/coverage/replay.jsonl.gz    canonical: the whole stream (schema v1)
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
import { gunzipSync, gzipSync } from 'node:zlib'

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
import { encodeCompact, encodeJsonl, type StreamWindow } from '../../lib/wavefront/stream'
import { datasetsDir } from '../lib/datasetsDir.mjs'
import { buildCensus, MAX_SALES, type CensusInputs, type CensusRow } from './census'
import { crossCheck } from './crossCheck'
import { aaveEvents as readAaveCsv, morphoEvents as readMorphoCsv } from './inputs'

const ROOT = process.cwd()
const NO_WRITE = process.argv.includes('--no-write')
const DATASETS = datasetsDir(ROOT)
const INPUTS = path.join(DATASETS, 'recall-coverage', 'inputs', 'oct10')
const ONCHAIN = path.join(INPUTS, 'onchain')
const OUT_DIR = path.join(DATASETS, 'oct10-2025', 'coverage')
const SERVED = path.join(ROOT, 'public', 'data', 'oct10-2025')
const AAVE_CHAINS = ['mainnet', 'arbitrum', 'optimism', 'base']
const MORPHO_CHAINS = ['mainnet', 'base']

const gzJson = (p: string) => JSON.parse(gunzipSync(fs.readFileSync(p)).toString())
const gzLines = (p: string) =>
  gunzipSync(fs.readFileSync(p))
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const r2 = (x: number) => Math.round(x * 100) / 100
const r6 = (x: number) => Math.round(x * 1e6) / 1e6

// ---- inputs ----------------------------------------------------------------------------
const inputFiles = [
  path.join(INPUTS, 'aave_liquidations_enriched.csv'),
  path.join(INPUTS, 'morpho_liquidations.csv'),
  path.join(ONCHAIN, 'aave-events.jsonl.gz'),
  path.join(ONCHAIN, 'morpho-events.jsonl.gz'),
  ...AAVE_CHAINS.map((c) => path.join(ONCHAIN, `aave-oracle-1m.${c}.json.gz`)),
  ...MORPHO_CHAINS.map((c) => path.join(ONCHAIN, `morpho-oracle-1m.${c}.json.gz`)),
]
for (const f of inputFiles) {
  if (!fs.existsSync(f)) throw new Error(`build-census: missing input ${f}`)
}
const aaveOracle = Object.fromEntries(
  AAVE_CHAINS.map((c) => [c, gzJson(path.join(ONCHAIN, `aave-oracle-1m.${c}.json.gz`))]),
)
const morphoOracle = Object.fromEntries(
  MORPHO_CHAINS.map((c) => [c, gzJson(path.join(ONCHAIN, `morpho-oracle-1m.${c}.json.gz`))]),
)
const first = aaveOracle.mainnet
const window: StreamWindow = {
  startTs: first.startTs,
  stepSeconds: first.stepSeconds,
  minutes: first.count,
}
for (const f of [...Object.values(aaveOracle), ...Object.values(morphoOracle)] as any[]) {
  if (
    f.startTs !== window.startTs ||
    f.stepSeconds !== window.stepSeconds ||
    f.count !== window.minutes
  ) {
    throw new Error(`build-census: ${f.chain} oracle file is on a different grid`)
  }
}

const inputs: CensusInputs = {
  window,
  aaveCsv: readAaveCsv(INPUTS) as any,
  aaveEvents: gzLines(path.join(ONCHAIN, 'aave-events.jsonl.gz')),
  aaveOracle,
  morphoCsv: readMorphoCsv(INPUTS) as any,
  morphoEvents: gzLines(path.join(ONCHAIN, 'morpho-events.jsonl.gz')),
  morphoOracle,
}

// ---- the census ---------------------------------------------------------------------------
const t0 = Date.now()
const census = buildCensus(inputs)
const noWalkOn = buildCensus(inputs, { stopAfterT0BandSale: true })
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
const protoChain = (r: CensusRow) => `${r.protocol}:${r.chain}`
const byPC = by(rows, protoChain)
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
const sensitivity = {
  noWalkOnAfterT0BandSale: {
    rule: 'The headline walks a delayed position sold at t0 past line x (1 + band) on after that sale, like every other sale (the contract deletes the timer after any sale and the position stays live, LiquidationEngine.sol:1421-1423). This rebuild stops it after the one t0 repay — the behaviour before 2026-10-14.',
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
const inputsMeta = [...inputFiles, path.join(INPUTS, 'chainlink_rounds.csv')].map((f) => {
  const b = fs.readFileSync(f)
  return { path: rel(f), bytes: b.length, sha256: sha(b) }
})
const appInputsMeta = ['evidence.json', 'prices-1m.json'].map((f) => {
  const b = fs.readFileSync(path.join(SERVED, f))
  return { path: `membrane-app:public/data/oct10-2025/${f}`, bytes: b.length, sha256: sha(b) }
})

const method = {
  positions:
    'Every (chain, user) Aave V3 account and every (chain, market, borrower) Morpho Blue position with a liquidation in aave_liquidations_enriched.csv / morpho_liquidations.csv, 2025-10-10T00:00Z .. 2025-10-11T23:59Z.',
  aave: "Composition at the t0 event's block N-1 (the pull's full re-read): collateral = reserves with aToken > 0, collateral flag on and LT > 0 under the user's e-mode; debt = reserves with variable debt > 0. Valued at block-N AaveOracle prices with Aave's rounding (floor collateral, ceil debt). Line = Aave's weighted LT at those prices = sum(coll_i x LT_i) / sum(coll_i); LTV0 = debt / coll. Located iff HF at block N < 1 (the pull's recompute); t0 = the first event, or the first located one. Collateral worth 0 base units at N is dropped (Aave counts it as 0).",
  morpho:
    "Composition at the first event's N-1: collateral amount; borrowed = shares -> assets rounded UP, interest accrued to ts(N). Line = LLTV. LTV(m) = borrowed / (collateral x oracle price(m) / 1e36), anchored at price(N). Not liquidatable at N (LTV_N <= LLTV) -> not walked. Interest after t0 is not added.",
  path: "Each leg moves with its own protocol-oracle minute path (AaveOracle per chain; the market's Morpho oracle), value(m) = value_N x p(m) / p_N for every minute m after t0's minute, where p(m) is the price in force at the minute START (block <= minute start) — no look-ahead. Grid ends at minute 2,879 (2025-10-11T23:59Z).",
  delayClass:
    "collateralClass.ts delayClassOf(<every collateral symbol>, line) on the FULL composition. MIXED -> walked as the two positions Membrane would hold, exactly as compare.ts splitByDelayClass splits one: no-delay legs (sub 0) and delayed legs (sub 1), debt pro rata to collateral value at t0 (both halves open at the position's own LTV), each half at its own LT-weighted line and its own class delayClassOf(its symbols, its line). A half that opens under its own line just walks. The position's Membrane figures are the sum of its halves.",
  membrane:
    'lib/wavefront/kernel.ts per half: DelayTimer from curePath.ts and cureSale (the same sale step cureWalk runs) — repay-to-cap with membraneRepayValue and the liqDebtMinimum floor, seized == repaid (no fee), walk on after a sale (max 20 sales), the conservative sale at the grid end for a delay still running. Repaid/sold USD at the sale minute (Morpho: x the loan token USD). A delayed position past the band at t0 is sold at once and walked on like after any sale (as cureWalk); stopping it after that one repay is meta.sensitivity.noWalkOnAfterT0BandSale.',
  real: 'Aave: debt_to_cover_normalized x the debt reserve AaveOracle price at block N, liquidated_collateral_normalized x the collateral reserve price at N (the event re-read carries both). Morpho: repaid_assets_normalized x loan USD; seized collateral at the event oracle price(N) in loan units x loan USD; realised bad debt reported separately (not repaid). Loan USD: $1.00 for a dollar stable held at one (collateralClass.ts heldAtOne), else the AaveOracle price of the same token on the same chain from the minute path at the event minute, else unpriced (USD null, counted; LTV and every Membrane decision unaffected; the liqDebtMinimum floor is not applied).',
  cluster: `Largest collateral leg by USD at t0: ETH (${ETH_SYMBOLS.join(', ')}), BTC (${BTC_SYMBOLS.join(', ')}), ${NAMED_CLUSTERS.join(', ')}, Stables (collateralClass.ts isStable); any other symbol that is the primary leg of >= ${OWN_CLUSTER_MIN_POSITIONS} positions is its own cluster (${census.stats.ownClusters.join(', ')}); else Other.`,
  sameSet:
    'Both sides are reported on the same positions. USD totals skip a position whose loan token has no USD price, on both sides.',
}

const censusDoc = {
  meta: {
    schema: 'oct10-coverage-census/v1',
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
      oldCensusNote:
        'The old census (public/data/oct10-2025/evidence.json) had 2,350 Aave cohort rows when the pull was planned: 68 of the 2,418 accounts dropped because no event of theirs had a debt symbol with a series. 2,350 + 745 Morpho = the "3,095" quoted earlier. On this branch it has 2,347: Part 1 (L9) stopped pinning sUSD at $1, which drops 3 more (71). This census has every one of the 2,418 + 745 = 3,163 positions.',
    },
    totals: { all, byProtocol: totalsByProtocol, byProtocolChain: totalsByPC },
    stream: {
      records: census.records.length,
      finalTick: census.records[census.records.length - 1],
    },
    classes,
    clusters,
    outcomes,
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
  sensitivity,
  crossCheck: xc.summary,
}

// ---- print ----------------------------------------------------------------------------------
const fmt = (x: number) => `$${(x / 1e6).toFixed(2)}M`
console.log(
  `census: ${rows.length} positions, ${all.walked} walked, ${all.notWalked} not (${elapsed} ms for 2 builds)`,
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

Every liquidated position of the Oct 10-11 2025 window — ${rows.length.toLocaleString('en-US')} = ${totalsByProtocol['aave-v3'].positions.toLocaleString('en-US')} Aave V3 accounts + ${totalsByProtocol['morpho-blue'].positions.toLocaleString('en-US')} Morpho Blue positions — with the protocol's real liquidations on one side and Membrane's engine walked minute by minute on the other, on the same positions, priced from the protocols' OWN oracles read on chain.

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
- \`replay.jsonl.gz\`: the wavefront stream, schema v1 (\`lib/wavefront/stream.ts\`): a header line, then ${census.records.length.toLocaleString('en-US')} records — \`open\`, \`real\`, \`mem\`, \`tick\` — in time order across all positions.

## Coverage

| protocol:chain | positions | walked | not walked |
| --- | ---: | ---: | ---: |
${pcKeys.map((k) => `| ${k} | ${totalsByPC[k].positions} | ${totalsByPC[k].walked} | ${totalsByPC[k].notWalked} |`).join('\n')}
| **all** | **${all.positions}** | **${all.walked}** | **${all.notWalked}** |

Not walked:

${uncovered.map((u) => `- \`${u.pid}\`: ${u.reason}`).join('\n')}

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
