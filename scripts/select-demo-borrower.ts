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
 * WHAT IT OPTIMISES (owner ruling 2026-09-14, superseding the 2026-09-12 survival-first
 * ordering): the largest `Comparison.equityDeltaUsd` under the SHIPPED deployment
 * assumption — the exact figure VerdictHero prints as the equity line, "+$X more equity
 * left" — among rows that clear EVERY eligibility gate below. Ranking on the printed figure and
 * gating on everything else is the honest shape: the gates are the claims, the rank is
 * only which of the qualifying wallets says it loudest.
 *
 * ELIGIBILITY (all must hold; each is a claim the page would otherwise make falsely):
 *   1. the census row is INCLUDED — not excluded, so its breach was actually located;
 *   2. the census says Membrane closes LESS than Aave on it
 *      (membraneClosedUsd < aaveClosedUsd). A hero wallet where the census itself says
 *      Membrane closed more is a page arguing against its own dataset;
 *   3. the census outcome and the live engine AGREE on outcome class (sold vs held) when
 *      the live engine is run the way the census runs — fee 0, NO deployment. The two
 *      engines share a state machine; if they disagree on this row, the row is a seam,
 *      not a story;
 *   4. equityDeltaUsd > 0 under the shipped deployment assumption; AND
 *   5. equityDeltaUsd > 0 with NO deployment at all. Gate 5 is what stops the hero being
 *      an artefact of the assumed venue: the wallet must end ahead on equity even if the
 *      assumption is deleted entirely.
 *
 * THE FEES (owner ruling 2026-09-14). Membrane's liquidation fee is ZERO — that is the
 * deployed configuration, and it is already what the live simulator defaults to
 * (Simulator.tsx defaultLiqFee returns 0). Aave's side keeps its own measured weighted
 * liquidationBonus, read from protocols.json. The comparison is therefore not fee-matched
 * on purpose: each engine is charged what it actually charges.
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
 * THE TOKEN AMOUNTS ARE REAL (fixed 2026-09-14). The collateral amount is the measured
 * USD over `pLiqColl`, the oracle round those dollars were read at — not over the
 * minute-0 price, which back-solved an amount that reproduced the LIQUIDATING LTV at
 * midnight and so planted the breach 21 hours early. See `buildPosition`.
 *
 * Run: ./node_modules/.bin/tsx scripts/select-demo-borrower.ts
 *      ./node_modules/.bin/tsx scripts/select-demo-borrower.ts --dry   (rank only)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getAddress } from 'viem'

import { measuredRepayFraction, runComparison } from '@/lib/position-sim/compare'
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
  /** The census walk's own outcome for this row (curePath.ts CureOutcome). */
  outcome: string
  excluded?: boolean
  collateralUsd: number
  debtUsd: number
  healthFactor: number
  liqLine: number
  ltv0: number
  collSymbol: string
  debtSymbol: string
  /** The oracle rounds IN FORCE IN THE LIQUIDATING BLOCK — the prices collateralUsd and
   *  debtUsd were read at, so the token amounts divide by these and by nothing else. */
  pLiqColl: number
  pLiqDebt: number
  /** Where the census opened this account's walk, and where it sold, in path minutes. */
  t0Index: number
  closedAtIndex: number | null
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
  wstETH: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
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

/**
 * EDITORIAL GUARDRAILS, kept from the 2026-09-12 ruling and overridable for diagnosis.
 *
 * The 2026-09-14 ruling replaced the RANKING and the eligibility gates; it did not say
 * anything about these, so they stand. They are env-overridable (DEMO_MIN_COLL /
 * DEMO_MAX_COLL / DEMO_MIN_MINUTE) purely so a run can report which constraint is the
 * binding one when the funnel empties — the committed fixture is always produced with the
 * defaults.
 *
 * MIN_FIRST_LIQ_MINUTE is NOT editorial. `buildPosition` reprices the measured dollars at
 * minute 0 of the window, so a row whose measured LTV already sits over its liquidation
 * threshold is liquidated at minute 0 of the simulated path — an artefact of the rebuild,
 * not a crash story. Dropping it would let the hero open on a wallet that was already
 * underwater before the window began.
 */
const MIN_COLLATERAL_USD = Number(process.env.DEMO_MIN_COLL ?? 50_000)
const MAX_COLLATERAL_USD = Number(process.env.DEMO_MAX_COLL ?? 3_000_000)
const MIN_FIRST_LIQ_MINUTE = Number(process.env.DEMO_MIN_MINUTE ?? 60)
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

/**
 * MEMBRANE'S LIQUIDATION FEE IS ZERO (owner ruling 2026-09-14).
 *
 * This used to mirror the source protocol's own bonus, on the reasoning that charging
 * Membrane less than Aave would be self-serving. The deploy scripts settle it instead:
 * the fee is 0, and the live simulator's own `defaultLiqFee` (Simulator.tsx:182) already
 * returns 0, so mirroring the bonus here made the fixture disagree with the page it feeds.
 * Aave's side is unchanged — it is charged its own weighted `liquidationBonus`, read from
 * protocols.json and carried on each collateral leg (compare.ts:112-115).
 */
const MEMBRANE_LIQ_FEE = 0

/**
 * Rebuilds the ProtocolPosition from an evidence row: dollars and symbols MEASURED,
 * Aave risk parameters READ from protocols.json, token amounts DERIVED, and the position
 * then VALUED at minute 0 of the path the simulator walks.
 *
 * THE ANCHOR IS pLiqColl, NOT THE MINUTE-0 PRICE (fixed 2026-09-14). This used to divide
 * the measured USD by the minute-0 oracle price, which is a different price from the one
 * those dollars were read at. The census reads each account at its own liquidating block:
 * `collateralUsd` IS `snapshotCollateralUsd x pLiqColl / pStateColl` (build-evidence.ts:
 * 608-610), so the physical token count is `collateralUsd / pLiqColl` and nothing else.
 * Dividing by the minute-0 price instead back-solved a token amount that reproduced the
 * LIQUIDATING LTV at MIDNIGHT — it planted the wallet's breach 21 hours before the wallet
 * actually breached, and the simulator, which walks from index 0, then sold it three
 * times over a day when the census row records one sale four minutes after t0.
 *
 * So: amount = measured USD / the price in force when that USD was read; valueUsd, the
 * totals, the LTV and the health factor are then the amount repriced at minute 0. The
 * position the page opens on is the position this wallet actually held at 00:00 UTC, and
 * it breaches where the price crosses debt / (amount x line) — which is the census t0.
 */
function buildPosition(row: EvidenceRow): ProtocolPosition | null {
  const cr = protocols.aaveV3.reserves[row.collSymbol]
  if (!cr) return null
  const cp = priceAtMinuteZero(row.collSymbol)
  const dp = priceAtMinuteZero(row.debtSymbol)
  if (cp === null || dp === null || cp <= 0 || dp <= 0) return null
  if (!MAINNET_TOKEN[row.collSymbol] || !MAINNET_TOKEN[row.debtSymbol]) return null
  // The read prices. Without them there is no token count, only a back-solve.
  const cAnchor = row.pLiqColl
  const dAnchor = row.pLiqDebt
  if (!(cAnchor > 0) || !(dAnchor > 0)) return null

  const collAmount = row.collateralUsd / cAnchor
  const debtAmount = row.debtUsd / dAnchor
  const collValue = collAmount * cp
  const debtValue = debtAmount * dp
  if (!(collValue > 0)) return null

  const liquidationLtv = cr.liquidationThresholdPct / 100
  const ltv = debtValue / collValue

  return {
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral: [
      {
        symbol: row.collSymbol,
        address: MAINNET_TOKEN[row.collSymbol],
        decimals: cr.decimals,
        amount: collAmount,
        priceUsd: cp,
        valueUsd: collValue,
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
        amount: debtAmount,
        priceUsd: dp,
        valueUsd: debtValue,
        borrowApr: null,
      },
    ],
    totalCollateralUsd: collValue,
    totalDebtUsd: debtValue,
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
    membraneLiqFee: MEMBRANE_LIQ_FEE,
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
  /** The hero's equity figure, at the DEFAULT assumed deployment. */
  deltaUsd: number
  /** The same figure with NO deployment — eligibility gate 5, and the honest floor. */
  bareDeltaUsd: number
  /** Census outcome class vs the live engine's, run the census's way (fee 0, no venue). */
  censusSold: boolean
  liveSold: boolean
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
  // EXCLUDED ROWS ARE NOT CANDIDATES (added 2026-09-14). An excluded row is one whose
  // breach the census could not locate at all — its health factor at the snapshot block
  // says it was not liquidatable, so it carries outcome 'sold-immediately-unlocated-line'
  // and a placeholder one-repay figure that reaches no total. A landing hero cannot open
  // on a row the census itself refuses to count; before this filter the selection could
  // (and did) pick one.
  if ((row as unknown as { excluded?: boolean }).excluded) {
    reject('excluded-from-the-census')
    continue
  }
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

  // GATE 2: the census must already say Membrane closes less on this row.
  if (!(row.membraneClosedUsd < row.aaveClosedUsd)) {
    reject('census-says-membrane-closes-more')
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

  /**
   * GATE 3: the census and the live engine must agree on OUTCOME CLASS, with the live
   * engine run exactly the way the census runs it — fee 0 and NO deployment. The census
   * walks a single composite ratio series with no venue; the live engine walks per-leg
   * prices. They share the DelayTimer state machine, so a disagreement on "was this
   * position sold at all" is a seam between the two, and a hero wallet is the worst
   * possible place to discover one.
   */
  const bare = oct10Run(position, null)
  const censusSold = row.outcome.startsWith('sold')
  const liveSold = engineOutcome(bare.membrane).liquidated
  if (censusSold !== liveSold) {
    reject('census-and-live-engine-disagree')
    continue
  }
  /**
   * GATE 4: ahead on equity with NO DEPLOYMENT (owner ruling 2026-09-14). The old gate
   * that also required a gain WITH the assumed deployment is GONE, and so is the
   * deployment. The census has no venue in it; a hero that needs one is a hero about our
   * assumption rather than about the wallet. The bare run is the one that equals the
   * census row, so it is the one that gates and the one that ranks. (The old note here
   * said every census-consistent candidate went NEGATIVE under the assumed deployment.
   * Re-measured after the token-amount fix in `buildPosition`, that is no longer true -
   * it was an artefact of the planted breach. The deployment stays out anyway, because
   * it is still an assumption the census does not contain.)
   */
  if (!(bare.equityDeltaUsd > 0)) {
    reject('no-equity-gain-without-deployment')
    continue
  }

  // Survival is reported off the BARE run, because that is what ships.
  const base = survival(bare, position)
  const stress = STRESS.map((v) => oct10Run(position, assumedVenue(row, v.share, v.recall, v.fast)))

  candidates.push({
    row,
    position,
    deltaUsd: cmp.equityDeltaUsd,
    bareDeltaUsd: bare.equityDeltaUsd,
    censusSold,
    liveSold,
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
    membraneKinds: bare.membrane.events.map((e) => e.kind).join('+') || 'nothing fired',
    membraneEvents: bare.membrane.events.length,
    aaveEvents: bare.source.events.length,
  })
}

/**
 * THE RANKING IS THE RULING (2026-09-14, revised): the largest equityDeltaUsd with NO
 * DEPLOYMENT. That is the run the census itself describes — the census has no venue in
 * it — so ranking on it is the only way the hero figure and the hero's own census row can
 * be the same claim. Ranking on the deployed delta ranked on our assumption. Ties fall
 * back to the census gap (Aave closed minus Membrane closed), which is the mechanism the
 * page is about.
 */
candidates.sort(
  (a, b) =>
    b.bareDeltaUsd - a.bareDeltaUsd ||
    b.row.aaveClosedUsd - b.row.membraneClosedUsd - (a.row.aaveClosedUsd - a.row.membraneClosedUsd),
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
  `survives (no liquidation, window held) with NO deployment: ${survived.length}` +
    ` · for diagnosis, with the removed assumption:` +
    STRESS.map(
      (v, i) => ` · ${candidates.filter((c) => c.stressSurvives[i]).length} at ${v.label}`,
    ).join(''),
)
console.log(
  `bare delta > $10k: ${candidates.filter((c) => c.bareDeltaUsd > 10_000).length} · ` +
    `> $25k: ${candidates.filter((c) => c.bareDeltaUsd > 25_000).length} · ` +
    `> $50k: ${candidates.filter((c) => c.bareDeltaUsd > 50_000).length}`,
)
console.log()
console.log(
  [
    'user',
    'coll/debt',
    'collateralUsd',
    'debtUsd',
    'census',
    'aave closed',
    'membrane closed',
    'membrane run',
    'delta(shipped)',
    'delta(no deploy)',
    ...STRESS.map((v) => v.label),
  ].join('\t'),
)
for (const c of candidates.slice(0, 8)) {
  console.log(
    [
      c.row.user,
      `${c.row.collSymbol}/${c.row.debtSymbol}`,
      usd(c.row.collateralUsd),
      usd(c.row.debtUsd),
      c.row.outcome,
      usd(c.row.aaveClosedUsd),
      usd(c.row.membraneClosedUsd),
      (c.survives
        ? 'SURVIVED'
        : c.membraneLiquidated
          ? `liq x${c.membraneEvents}`
          : 'window BROKE') + ` (${c.membraneKinds})`,
      usd(c.deltaUsd),
      usd(c.bareDeltaUsd),
      ...c.stressDeltaUsd.map(usd),
    ].join('\t'),
  )
}

const winner = candidates[0]
if (!winner) {
  console.error(
    'NO CANDIDATE PASSES. The eligibility gates admit nothing, so public/data/' +
      'demo-borrower.json is LEFT UNCHANGED. Rejection tally above says which gate bit.',
  )
  process.exit(2)
}
const bareRun = oct10Run(winner.position, null)
const bareSurvival = survival(bareRun, winner.position)
if (!bareSurvival.survives) {
  console.warn(
    'NOTE: the top candidate is liquidated on Membrane too, with no deployment. That is ' +
      'not a disqualification any more — the gate is equity, not survival — but the hero ' +
      'copy must not promise a survival it does not have.',
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

/** Reported for diagnosis only: the shipped fixture assumes NO deployment at all. */
const breakEven = recallBreakEven(winner)
const outcome = outcomeLine(bareRun).line

console.log()
/** The hero's own three lines, built the way VerdictHero builds them from the run. */
const heroAaveClosed = bareRun.source.events
  .filter((e) => e.kind === 'liquidation')
  .reduce((a, e) => a + e.repaidUsd, 0)
const heroMembraneSales = bareRun.membrane.events.filter((e) => e.repaidUsd > 0)
const heroMembraneClosed = heroMembraneSales.reduce((a, e) => a + e.repaidUsd, 0)
const heroLagMinutes =
  heroMembraneSales.length && winner.firstLiqMinute != null
    ? heroMembraneSales[0].minute - winner.firstLiqMinute
    : null
console.log(
  `winner ${winner.row.user} — hero: "Aave V3 closed ${usd(heroAaveClosed)} of this loan ` +
    `at ${clock(winner.firstLiqTs)}. Membrane would have closed ${usd(heroMembraneClosed)} ` +
    `${heroMembraneClosed <= 0 ? 'and sold nothing' : heroLagMinutes ? `${Math.abs(heroLagMinutes)} minutes ${heroLagMinutes > 0 ? 'later' : 'earlier'}` : 'and nothing more'}. ` +
    `${usd(winner.bareDeltaUsd)} more equity left." (NO deployment)`,
)
console.log()
console.log('TOP 5 (ranked on the no-deployment equity delta):')
console.log(
  [
    '#',
    'user',
    'census outcome',
    'aave closed',
    'membrane closed',
    'equity delta (bare)',
    'first liq min',
  ].join('\t'),
)
for (const [i, c] of candidates.slice(0, 5).entries()) {
  console.log(
    [
      i + 1,
      c.row.user,
      c.row.outcome,
      usd(c.row.aaveClosedUsd),
      usd(c.row.membraneClosedUsd),
      usd(c.bareDeltaUsd),
      c.firstLiqMinute,
    ].join('\t'),
  )
}
console.log(`  outcomeLine: ${outcome}`)
console.log(`  membrane did: ${winner.membraneKinds} · window broke: ${winner.membraneBrokeWindow}`)
console.log(
  `  deployment: NONE (fixture ships venue null). For diagnosis only — with the old ` +
    `assumed ${(ASSUMED_DEPLOYED_SHARE * 100).toFixed(0)}% deployment this wallet's delta ` +
    `would be ${usd(winner.deltaUsd)} and its recall break-even ` +
    `${breakEven === null ? 'never survives' : (breakEven * 100).toFixed(0) + '%'}.`,
)
console.log(
  `  gates: census ${winner.row.outcome} vs live ${winner.liveSold ? 'sold' : 'held'} (agree) · ` +
    `census aave ${usd(winner.row.aaveClosedUsd)} > membrane ${usd(winner.row.membraneClosedUsd)} · ` +
    `RANKED delta (no deployment) ${usd(winner.bareDeltaUsd)} · with-deployment ${usd(winner.deltaUsd)} (not used)`,
)

if (process.argv.includes('--dry')) process.exit(0)

// ------------------------------------------------------------------- commit

const fixture = {
  address: getAddress(winner.row.user),
  readAt: WINDOW,
  provenance: 'measured wallet · no deployment',
  source: 'public/data/oct10-2025/evidence.json',
  selection:
    'Generated by scripts/select-demo-borrower.ts, which runs the page engine ' +
    '(lib/position-sim runComparison) over every evidence row with NO deployment and ' +
    'ranks by equityDeltaUsd, ties broken by the census gap (Aave closed minus Membrane ' +
    'closed). Eligible: the census row is INCLUDED (not one whose breach the census could ' +
    'not locate); mainnet (protocols.json is a mainnet read, so its risk parameters and ' +
    'the token addresses only apply there); a single collateral leg priced by the measured ' +
    'path AND present in protocols.json aaveV3.reserves; debt priced or a $1 stable held ' +
    'flat; collateralUsd ' +
    `$${(MIN_COLLATERAL_USD / 1000).toFixed(0)}k-$${(MAX_COLLATERAL_USD / 1e6).toFixed(0)}M ` +
    `(no whales); the first Aave liquidation at least ${MIN_FIRST_LIQ_MINUTE} minutes into ` +
    'the path, so the hero is not a minute-0 artifact; the census says Membrane closes ' +
    'LESS than Aave on it; the census outcome and the live engine agree on outcome class ' +
    "when the live engine is run the census's way (fee 0, no deployment); and " +
    'equityDeltaUsd > 0 with NO deployment. ' +
    `${candidates.length} rows cleared every gate and this one won on the ranked figure at ` +
    `${usd(winner.bareDeltaUsd)}. ` +
    'THE TOKEN AMOUNTS ARE REAL (fixed 2026-09-14): the collateral and debt amounts are ' +
    'the measured USD over the oracle rounds in force in the liquidating block ' +
    '(pLiqColl / pLiqDebt), then repriced at minute 0. They used to be the measured USD ' +
    'over the MINUTE-0 price, which back-solved an amount that reproduced the ' +
    'liquidating LTV at midnight - a breached position planted 21 hours before the ' +
    'wallet breached. ' +
    'WHAT CHANGED (owner ruling 2026-09-14): the fixture used to ship an ASSUMED ' +
    'deployment - half the measured debt in a venue modelled at 60% recall / 55% fast - ' +
    'and rank on the equity delta that assumption produced. It is gone. The census has no ' +
    'venue anywhere in it, so a hero ranked on a venue was a hero about the assumption. ' +
    'The hero now equals its own census row exactly. Membrane is charged a ZERO ' +
    "liquidation fee (the live simulator's own default); Aave is charged its own measured " +
    'weighted liquidationBonus.',
  /**
   * NO DEPLOYMENT. This wallet had none, the census models none, and none is assumed.
   * The key is kept (as null) rather than deleted so any surface that reads it gets an
   * explicit "there is no deployment" instead of an undefined it might render as one.
   */
  deployment: null,
  noDeployment: {
    reason:
      'MEASURED ABSENCE, not a modelling choice. Aave liquidated this wallet and the ' +
      'borrowed dollars were gone; no venue balance is detectable behind it, and the Oct ' +
      '10 census has no venue in it either. The fixture therefore ships venue null and ' +
      'the hero figure is the bare run, which is the same number its census row carries.',
    /** Reported so the deleted assumption is auditable, never so a surface can use it. */
    diagnosticWithOldAssumedDeployment: {
      deployedShareOfDebt: ASSUMED_DEPLOYED_SHARE,
      recallRate: ASSUMED_RECALL_RATE,
      fastRate: ASSUMED_FAST_RATE,
      deployedUsd: Math.round(winner.row.debtUsd * ASSUMED_DEPLOYED_SHARE),
      equityDeltaUsd: Math.round(winner.deltaUsd),
      recallBreakEven: breakEven,
      note: 'NOT SHIPPED. Retained only so the ruling that removed it can be checked.',
    },
    equityDeltaUsd: Math.round(winner.bareDeltaUsd),
    membraneLiquidated: bareSurvival.liquidated,
    membraneBrokeWindow: bareSurvival.brokeWindow,
  },
  /**
   * THE CENSUS ROW'S OWN FIGURES, lifted to the top level so any surface (and
   * scripts/tests/position-sim.test.ts) can check the live run against the census
   * without re-reading evidence.json. `censusClosedAtIndex` is relative to
   * `censusT0Index`: the census walk opens at t0 and counts minutes from there, so the
   * full-path minute of the census sale is censusT0Index + censusClosedAtIndex.
   */
  censusT0Index: winner.row.t0Index,
  censusOutcome: winner.row.outcome,
  censusAaveClosedUsd: winner.row.aaveClosedUsd,
  censusMembraneClosedUsd: winner.row.membraneClosedUsd,
  censusClosedAtIndex: winner.row.closedAtIndex,
  row: winner.row,
  position: winner.position,
}

writeFileSync(join(DATA, 'demo-borrower.json'), JSON.stringify(fixture, null, 1) + '\n')
console.log(`wrote public/data/demo-borrower.json — ${fixture.address}`)
