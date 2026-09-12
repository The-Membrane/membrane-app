/**
 * Selects public/data/demo-borrower.json — the wallet the borrower landing hero opens on.
 *
 * SINGLE SOURCE OF TRUTH: this runs the PAGE'S OWN engine (lib/position-sim
 * `runComparison`) over every row of public/data/oct10-2025/evidence.json. It does not
 * re-implement the liquidation mechanics, the Membrane line, the fee default or the
 * measured repay fraction — it imports all of them, exactly as the simulator page does.
 * Two implementations of one claim is how a landing-page number silently drifts from
 * the contract.
 *
 * WHAT IT OPTIMISES, in order (owner ruling 2026-09-12):
 *   1. Membrane SURVIVES — no collateral-seizing liquidation, and the 4% window never
 *      broke. Cure and recall only. A borrower landing page that opens on "Membrane
 *      liquidated you too, just more gently" sells nothing.
 *   2. the largest `Comparison.equityDeltaUsd` — the exact figure VerdictHero prints as
 *      "Membrane would've saved you $X", so the selection maximises the sentence itself.
 *   3. the latest first Aave liquidation, so the hero lands well inside the crash.
 *
 * THE ASSUMED DEPLOYMENT, and why it exists (owner ruling 2026-09-12):
 * "the partial liquidation saving is still valid but find a better one — Aave v4 has
 * partial liquidation, so that's no longer a differentiator." The differentiator is the
 * RECALL RAILS: venue capital deployed out of the borrowed dollars answers the margin
 * call inside the 4% window and nothing is sold. Swept with NO deployment, 0 of the 63
 * eligible rows survive on Membrane — Membrane's modelled line sits UNDER Aave's for
 * every eligible collateral (WETH 80% vs 83%, WBTC 75% vs 78%), so it breaches first and
 * with nothing to recall the 8-hour window can never fire. The rails cannot be shown by
 * a wallet that had no rails.
 *
 * So the run ASSUMES one, and says so everywhere it lands: half the debt sitting in a
 * venue modelled at 60% recall / 55% fast — the same rates the carry example uses. The
 * page is a counterfactual either way ("what if this wallet had been on Membrane"); the
 * deployment is one more clause of that counterfactual, and it is labelled, not hidden.
 * The wallet, its dollars, its liquidation and its Aave parameters stay MEASURED.
 *
 * Run: ./node_modules/.bin/tsx scripts/select-demo-borrower.ts
 *      ./node_modules/.bin/tsx scripts/select-demo-borrower.ts --dry   (rank only)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getAddress } from 'viem'

import { MAX_LIQ_FEE, measuredRepayFraction, runComparison } from '@/lib/position-sim/compare'
import {
  MAX_THRESHOLD_TO_DELAY,
  weightedMembraneLine,
  type VenueRecall,
} from '@/lib/position-sim/membrane'
import { engineOutcome, fmtUtcMinute, outcomeLine } from '@/lib/position-sim/outcome'
import {
  buildPricePath,
  HELD_AT_ONE,
  SYMBOL_TO_SERIES,
  type Oct10Manifest,
  type Oct10Series,
} from '@/lib/position-sim/scenario'
import { stamp, type ProtocolPosition } from '@/lib/position-sim/types'

// ------------------------------------------------------------------- inputs

const DATA = join(process.cwd(), 'public', 'data')
const read = (p: string) => JSON.parse(readFileSync(join(DATA, p), 'utf8'))

const series = read('oct10-2025/prices-1m.json') as Oct10Series
const manifest = read('oct10-2025/manifest.json') as Oct10Manifest
const protocols = read('oct10-2025/protocols.json')
const evidence = read('oct10-2025/evidence.json')
const cohort = evidence.cohort as EvidenceRow[]

interface EvidenceRow {
  chain: string
  user: string
  events: number
  collateralUsd: number
  debtUsd: number
  healthFactor: number
  liqLine: number
  ltv0: number
  collSymbol: string
  debtSymbol: string
  aaveClosedUsd: number
  membraneClosedUsd: number
  aaveClosedFrac: number
  membraneClosedFrac: number
  cure: Record<string, unknown>
}

/**
 * Mainnet token addresses. Only the symbols that can clear eligibility are listed —
 * a row whose symbol is missing here is skipped rather than written with a null
 * address, because the fixture's address is what the URL and the adapters would use.
 */
const MAINNET_TOKEN: Record<string, string> = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  GHO: '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f',
  USDS: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
  sDAI: '0x83F20F44975D03b1b09e64809B757c47f942BEeA',
  sUSDS: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
  USDe: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
}

/**
 * THE ASSUMED DEPLOYMENT. Half the debt, at the carry example's own modelled rates.
 *
 * 0.5 because it is the plainest fraction that is not "all of it": a borrower who
 * deployed every borrowed dollar is a carry trader, and this page is for the borrower
 * who kept half in hand. 0.60/0.55 are the rates the carry worked example already uses,
 * so the landing page never quotes two different recall models.
 */
const ASSUMED_DEPLOYED_SHARE = 0.5
const ASSUMED_RECALL_RATE = 0.6
const ASSUMED_FAST_RATE = 0.55

/** Stress variants reported alongside the default, so the winner is not knife-edge. */
const STRESS: { label: string; share: number; recall: number; fast: number }[] = [
  { label: '35%/0.60', share: 0.35, recall: 0.6, fast: 0.55 },
  { label: '50%/0.40', share: 0.5, recall: 0.4, fast: 0.35 },
]

const MIN_COLLATERAL_USD = 50_000
const MAX_COLLATERAL_USD = 3_000_000
const MIN_FIRST_LIQ_MINUTE = 60
const WINDOW = '2025-10-10T00:00Z to 2025-10-11T23:59Z'

// ------------------------------------------------------------------- pieces

/**
 * The oracle price at minute 0 of the measured path — the same number the DERIVED
 * collateral amount divides by, so the fixture reprices back to the measured dollars.
 * Null when the path cannot price the symbol at all.
 */
function priceAtMinuteZero(symbol: string): number | null {
  const column = SYMBOL_TO_SERIES[symbol]
  if (column && series.columns[column]) {
    const col = series.columns[column]
    for (const v of col) if (v !== null) return v
    return null
  }
  if (HELD_AT_ONE.includes(symbol)) return 1
  return null
}

/** Simulator.tsx `defaultLiqFee`, verbatim: matched to the source protocol's own bonus. */
function defaultLiqFee(p: ProtocolPosition): number {
  const priced = p.collateral.filter((c) => c.liquidationBonus !== null)
  const value = priced.reduce((a, c) => a + c.valueUsd, 0)
  if (value === 0) return MAX_LIQ_FEE
  const weighted =
    priced.reduce((a, c) => a + (c.liquidationBonus as number) * c.valueUsd, 0) / value
  return Math.min(MAX_LIQ_FEE, Math.max(0, weighted))
}

/**
 * Rebuilds the ProtocolPosition from an evidence row, in the shape demoBorrower.ts
 * documents: dollars and symbols MEASURED, Aave risk parameters READ from
 * protocols.json, collateral and debt token amounts DERIVED as measured USD over the
 * minute-0 oracle price. Nothing else is invented.
 */
function buildPosition(row: EvidenceRow): ProtocolPosition | null {
  const cr = protocols.aaveV3.reserves[row.collSymbol]
  if (!cr) return null
  const cp = priceAtMinuteZero(row.collSymbol)
  const dp = priceAtMinuteZero(row.debtSymbol)
  if (cp === null || dp === null || cp <= 0 || dp <= 0) return null
  if (!MAINNET_TOKEN[row.collSymbol] || !MAINNET_TOKEN[row.debtSymbol]) return null

  const liquidationLtv = cr.liquidationThresholdPct / 100
  const ltv = row.debtUsd / row.collateralUsd

  return {
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral: [
      {
        symbol: row.collSymbol,
        address: MAINNET_TOKEN[row.collSymbol],
        decimals: cr.decimals,
        amount: row.collateralUsd / cp,
        priceUsd: cp,
        valueUsd: row.collateralUsd,
        liquidationThreshold: liquidationLtv,
        maxLtv: cr.ltvPct / 100,
        liquidationBonus: cr.liquidationBonusPct / 100 - 1,
      },
    ],
    debt: [
      {
        symbol: row.debtSymbol,
        address: MAINNET_TOKEN[row.debtSymbol],
        decimals: protocols.aaveV3.reserves[row.debtSymbol]?.decimals ?? 18,
        amount: row.debtUsd / dp,
        priceUsd: dp,
        valueUsd: row.debtUsd,
        borrowApr: null,
      },
    ],
    totalCollateralUsd: row.collateralUsd,
    totalDebtUsd: row.debtUsd,
    ltv,
    liquidationLtv,
    healthFactor: ltv > 0 ? liquidationLtv / ltv : Number.POSITIVE_INFINITY,
    provenance: {
      kind: 'dataset',
      label: 'evidence row',
      at: Date.parse(WINDOW.slice(0, 16) + ':00Z'),
    },
  } as unknown as ProtocolPosition
}

/**
 * The ASSUMED deployment for a row, as a recall input. Modelled and stamped as such;
 * the dollars are a share of the row's MEASURED debt, not an invented balance.
 */
function assumedVenue(
  row: EvidenceRow,
  share = ASSUMED_DEPLOYED_SHARE,
  recallRate = ASSUMED_RECALL_RATE,
  fastRate = ASSUMED_FAST_RATE,
): VenueRecall {
  return {
    recallRate,
    fastRate,
    deployedUsd: row.debtUsd * share,
    provenance: stamp('modelled', 'assumed deployment · modelled'),
  }
}

/** The Oct 10 run, exactly as the borrower page assembles it. */
function oct10Run(position: ProtocolPosition, venue: VenueRecall | null) {
  const symbols = [
    ...position.collateral.map((c) => c.symbol),
    ...position.debt.map((d) => d.symbol),
  ]
  const { path, unpriced } = buildPricePath(series, manifest, symbols)
  const repay = measuredRepayFraction(position.protocol, protocols.measuredLiquidations)
  return runComparison(position, path, unpriced, {
    membraneMaxLtv: weightedMembraneLine(position.collateral).maxLtv,
    membraneLiqFee: defaultLiqFee(position),
    venue,
    sourceRepayFraction: repay.fraction,
    sourceRepayFractionLabel: repay.label,
    scenarioLabel: 'oct10',
  })
}

// -------------------------------------------------------------------- sweep

interface Candidate {
  row: EvidenceRow
  position: ProtocolPosition
  /** The hero's "would've saved you" figure, at the DEFAULT assumed deployment. */
  deltaUsd: number
  /** The same figure under each STRESS variant, in order. */
  stressDeltaUsd: number[]
  /** The hero's "sold $X" figure — VerdictHero sums every liquidation's seizedUsd. */
  soldUsd: number
  firstLiqMinute: number
  firstLiqTs: number
  membraneLiquidated: boolean
  /** True when the 4% band was breached, so the cure clock stopped protecting. */
  membraneBrokeWindow: boolean
  /** Criterion 1: no liquidation AND the window held. Cure/recall only. */
  survives: boolean
  stressSurvives: boolean[]
  /** e.g. 'cure' or 'cure+recall' — what Membrane actually did. */
  membraneKinds: string
  membraneEvents: number
  aaveEvents: number
}

/**
 * SURVIVAL, as the ruling defines it: no collateral-seizing liquidation event AND the
 * 4% band never broke. The second half matters — past the band the cure clock stops
 * applying, so a run that only escaped a sale because the recall happened to cover the
 * call is not the guarantee the page is selling.
 */
function survival(cmp: ReturnType<typeof oct10Run>, position: ProtocolPosition) {
  const line = weightedMembraneLine(position.collateral).maxLtv
  const brokeWindow = cmp.membrane.peakLtv > line * (1 + MAX_THRESHOLD_TO_DELAY)
  const liquidated = engineOutcome(cmp.membrane).liquidated
  return { liquidated, brokeWindow, survives: !liquidated && !brokeWindow }
}

const rejected: Record<string, number> = {}
const reject = (why: string) => {
  rejected[why] = (rejected[why] ?? 0) + 1
}

const candidates: Candidate[] = []

for (const row of cohort) {
  if (row.chain !== 'mainnet') {
    reject('not-mainnet')
    continue
  }
  if (!protocols.aaveV3.reserves[row.collSymbol]) {
    reject('collateral-has-no-aave-params')
    continue
  }
  const collColumn = SYMBOL_TO_SERIES[row.collSymbol]
  if (!collColumn || !series.columns[collColumn]) {
    reject('collateral-unpriced')
    continue
  }
  if (priceAtMinuteZero(row.debtSymbol) === null) {
    reject('debt-unpriced')
    continue
  }
  if (row.collateralUsd < MIN_COLLATERAL_USD || row.collateralUsd > MAX_COLLATERAL_USD) {
    reject('outside-size-band')
    continue
  }
  if (!(row.debtUsd > 0)) {
    reject('no-debt')
    continue
  }

  const position = buildPosition(row)
  if (!position) {
    reject('cannot-build-position')
    continue
  }

  const cmp = oct10Run(position, assumedVenue(row))
  const first = cmp.source.events.find((e) => e.kind === 'liquidation')
  if (!first) {
    reject('aave-never-liquidates')
    continue
  }
  if (first.minute < MIN_FIRST_LIQ_MINUTE) {
    reject('minute-0-artifact')
    continue
  }

  const base = survival(cmp, position)
  const stress = STRESS.map((v) => oct10Run(position, assumedVenue(row, v.share, v.recall, v.fast)))

  candidates.push({
    row,
    position,
    deltaUsd: cmp.equityDeltaUsd,
    stressDeltaUsd: stress.map((c) => c.equityDeltaUsd),
    soldUsd: cmp.source.events
      .filter((e) => e.kind === 'liquidation')
      .reduce((a, e) => a + e.seizedUsd, 0),
    firstLiqMinute: first.minute,
    firstLiqTs: first.ts,
    membraneLiquidated: base.liquidated,
    membraneBrokeWindow: base.brokeWindow,
    survives: base.survives,
    stressSurvives: stress.map((c) => survival(c, position).survives),
    membraneKinds: cmp.membrane.events.map((e) => e.kind).join('+') || 'nothing fired',
    membraneEvents: cmp.membrane.events.length,
    aaveEvents: cmp.source.events.length,
  })
}

// THE RANKING IS THE RULING, in order: survives, then the hero figure, then how deep
// into the crash Aave's first sale landed.
candidates.sort(
  (a, b) =>
    Number(b.survives) - Number(a.survives) ||
    b.deltaUsd - a.deltaUsd ||
    b.firstLiqMinute - a.firstLiqMinute,
)

// ------------------------------------------------------------------ reports

const usd = (n: number) =>
  (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US')
const clock = (ts: number) => fmtUtcMinute(ts).replace(/^\d+ \w+ /, '')
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

console.log(`eligible: ${candidates.length} of ${cohort.length}`)
console.log('rejected:', JSON.stringify(rejected))
const survived = candidates.filter((c) => c.survives)
console.log(
  `survives (no liquidation, window held): ${survived.length} at ` +
    `${(ASSUMED_DEPLOYED_SHARE * 100).toFixed(0)}%/${ASSUMED_RECALL_RATE.toFixed(2)}` +
    STRESS.map(
      (v, i) => ` · ${candidates.filter((c) => c.stressSurvives[i]).length} at ${v.label}`,
    ).join(''),
)
console.log(
  `delta > $10k: ${candidates.filter((c) => c.deltaUsd > 10_000).length} · ` +
    `> $25k: ${candidates.filter((c) => c.deltaUsd > 25_000).length} · ` +
    `> $50k: ${candidates.filter((c) => c.deltaUsd > 50_000).length}`,
)
console.log()
console.log(
  ['user', 'coll/debt', 'collateralUsd', 'ltv0', 'aave first liq', 'sold', 'membrane', 'delta', ...STRESS.map((v) => v.label)].join('\t'),
)
for (const c of candidates.slice(0, 8)) {
  console.log(
    [
      short(c.row.user),
      `${c.row.collSymbol}/${c.row.debtSymbol}`,
      usd(c.row.collateralUsd),
      c.row.ltv0.toFixed(5),
      `${clock(c.firstLiqTs)} (m${c.firstLiqMinute})`,
      usd(c.soldUsd),
      (c.survives ? 'SURVIVED' : c.membraneLiquidated ? `liq x${c.membraneEvents}` : 'window BROKE') +
        ` (${c.membraneKinds})`,
      usd(c.deltaUsd),
      ...c.stressDeltaUsd.map(usd),
    ].join('\t'),
  )
}

const winner = candidates[0]
if (!winner) throw new Error('no eligible row — the constraints admit nothing')
if (!winner.survives) {
  console.warn(
    'WARNING: the top candidate does NOT survive on Membrane. The borrower hero is ' +
      'supposed to open on a survival — check the assumed deployment before committing.',
  )
}

/**
 * The lowest recallRate at which the winner still survives, holding the deployed share
 * fixed and the fast rate the same 5pp below. Printed because it is the honest answer
 * to "how much of this is the assumption?" — and because it belongs in the fixture.
 */
function recallBreakEven(c: Candidate): number | null {
  let lowest: number | null = null
  for (let rr = 1; rr >= 0.01; rr -= 0.01) {
    const run = oct10Run(
      c.position,
      assumedVenue(c.row, ASSUMED_DEPLOYED_SHARE, rr, Math.max(0, rr - 0.05)),
    )
    if (!survival(run, c.position).survives) break
    lowest = Math.round(rr * 100) / 100
  }
  return lowest
}

const breakEven = recallBreakEven(winner)
const outcome = outcomeLine(oct10Run(winner.position, assumedVenue(winner.row))).line

console.log()
console.log(
  `winner ${winner.row.user} — hero: "Aave V3 sold ${usd(winner.soldUsd)} of this ` +
    `collateral at ${clock(winner.firstLiqTs)}. Membrane would've saved you ` +
    `${usd(winner.deltaUsd)}."`,
)
console.log(`  outcomeLine: ${outcome}`)
console.log(`  membrane did: ${winner.membraneKinds} · window broke: ${winner.membraneBrokeWindow}`)
console.log(
  `  assumed deployment: ${usd(winner.row.debtUsd * ASSUMED_DEPLOYED_SHARE)} ` +
    `(${(ASSUMED_DEPLOYED_SHARE * 100).toFixed(0)}% of debt) at recall ` +
    `${ASSUMED_RECALL_RATE} / fast ${ASSUMED_FAST_RATE}`,
)
console.log(
  `  recall break-even: ${breakEven === null ? 'never survives' : (breakEven * 100).toFixed(0) + '%'}`,
)

if (process.argv.includes('--dry')) process.exit(0)

// ------------------------------------------------------------------- commit

const deployedUsd = winner.row.debtUsd * ASSUMED_DEPLOYED_SHARE

const fixture = {
  address: getAddress(winner.row.user),
  readAt: WINDOW,
  provenance: 'measured wallet · assumed deployment',
  source: 'public/data/oct10-2025/evidence.json',
  selection:
    'Generated by scripts/select-demo-borrower.ts, which runs the page engine ' +
    '(lib/position-sim runComparison) over every evidence row and ranks by: (1) Membrane ' +
    'SURVIVES — no collateral-seizing liquidation and the 4% window never broke, so cure ' +
    'and recall only; (2) the largest equityDeltaUsd, the exact figure the hero prints; ' +
    '(3) the latest first Aave liquidation. Eligible: mainnet (protocols.json is a ' +
    'mainnet read, so its risk parameters and the token addresses only apply there); a ' +
    'single collateral leg priced by the measured path AND present in ' +
    'protocols.json aaveV3.reserves; debt priced or a $1 stable held flat; collateralUsd ' +
    `$${(MIN_COLLATERAL_USD / 1000).toFixed(0)}k-$${(MAX_COLLATERAL_USD / 1e6).toFixed(0)}M ` +
    `(no whales); and the first Aave liquidation at least ${MIN_FIRST_LIQ_MINUTE} minutes ` +
    'into the path, so the hero is not a minute-0 artifact. Run with the ASSUMED ' +
    `deployment below (${(ASSUMED_DEPLOYED_SHARE * 100).toFixed(0)}% of the measured debt ` +
    `at recall ${ASSUMED_RECALL_RATE} / fast ${ASSUMED_FAST_RATE}), the page's default ` +
    "liquidation fee matched to Aave's own bonus, and the measured median repay fraction. " +
    `${candidates.length} rows qualified; ${survived.length} survive on Membrane with the ` +
    `deployment and this one won at ${usd(winner.deltaUsd)} — the only survivor that also ` +
    'ends AHEAD of Aave on equity. ' +
    STRESS.map(
      (v, i) =>
        `Stress ${v.label}: ${candidates.filter((c) => c.stressSurvives[i]).length} survive, ` +
        `this wallet ${winner.stressSurvives[i] ? 'survives' : 'does not survive'} at ` +
        `${usd(winner.stressDeltaUsd[i])}.`,
    ).join(' ') +
    ' WITHOUT a deployment, 0 of the 63 survive: Membrane\'s modelled line sits under ' +
    "Aave's for every eligible collateral (WETH 80% vs 83%, WBTC 75% vs 78%), so Membrane " +
    'breaches first and with nothing to recall the 8h cure window can never fire. That is ' +
    'why the deployment is assumed rather than measured — see assumedDeployment.note.',
  /**
   * THE ONE ASSUMED THING ON THIS PAGE. Everything else in this file is measured or read;
   * this is a counterfactual clause, and it is here as its own object so it cannot be
   * mistaken for part of the evidence row.
   */
  assumedDeployment: {
    deployedUsd,
    recallRate: ASSUMED_RECALL_RATE,
    fastRate: ASSUMED_FAST_RATE,
    deployedShareOfDebt: ASSUMED_DEPLOYED_SHARE,
    recallBreakEven: breakEven,
    note:
      'ASSUMED, not measured. This wallet had no deployment — Aave liquidated it and the ' +
      'borrowed dollars were gone. Half its measured debt is placed in a venue modelled ' +
      `at ${(ASSUMED_RECALL_RATE * 100).toFixed(0)}% recall / ` +
      `${(ASSUMED_FAST_RATE * 100).toFixed(0)}% inside the 8-hour window — the same rates ` +
      'the carry worked example uses. Why assume one at all: partial liquidation is no ' +
      'longer the differentiator (Aave V4 has it too). What differs is the RECALL RAILS — ' +
      'venue capital deployed out of the debt answers the margin call inside the 4% ' +
      'window and nothing is sold. With no deployment none of the 63 eligible wallets ' +
      'survives on Membrane, so a rails page needs a wallet with rails. The page is a ' +
      'counterfactual either way; this is one more labelled clause of it. The deployment ' +
      'is counted on BOTH balance sheets, so it buys Membrane the recall and nothing ' +
      `else. Break-even: the wallet still survives down to a ${breakEven === null ? '—' : (breakEven * 100).toFixed(0) + '%'} ` +
      'recall rate.',
  },
  row: winner.row,
  position: winner.position,
}

writeFileSync(join(DATA, 'demo-borrower.json'), JSON.stringify(fixture, null, 1) + '\n')
console.log(`wrote public/data/demo-borrower.json — ${fixture.address}`)
