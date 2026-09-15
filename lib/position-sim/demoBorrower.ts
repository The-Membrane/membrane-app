/**
 * THE BORROWER-MODE DEMO WALLET — A REAL ONE AAVE LIQUIDATED, PLUS ONE ASSUMED CLAUSE.
 *
 * The carry page opens on a live carry (demo.ts, a mainnet snapshot). The borrower page
 * cannot: a borrower-first landing has to open on the thing a borrower is afraid of, and
 * the only honest way to show that is a wallet the crash actually took.
 *
 * WHERE IT COMES FROM: public/data/demo-borrower.json is selected out of
 * public/data/oct10-2025/evidence.json — 2,350 measured Aave V3 accounts over the
 * 10-11 Oct 2025 window, each judged against its OWN measured liquidation line. The
 * selection ran the page's own engine over every mainnet row whose collateral the
 * measured price path prices and whose debt is priced or a stable held flat, in the
 * 50k-3M band, and kept the one with the largest equity delta run with NO deployment.
 * SURVIVAL is no longer the criterion and is not claimed: this wallet is liquidated on
 * Membrane too. What differs is how much of the loan each engine closes.
 *
 * WHAT IS MEASURED, AND WHAT IS RECONSTRUCTED — say both:
 *   MEASURED  the address, the collateral and debt USD at the window open, the debt and
 *             collateral symbols, the health factor, the account's own liquidation line,
 *             the number of liquidation events and the USD Aave actually closed.
 *   READ      the Aave V3 risk parameters (LTV / liquidation threshold / bonus) come
 *             from public/data/oct10-2025/protocols.json, read at mainnet block
 *             23543615 — not assumed.
 *   DERIVED   the collateral and debt TOKEN amounts, and the minute-0 valuation. The
 *             evidence row records dollars READ AT THE LIQUIDATING BLOCK, so the token
 *             count is those dollars over `pLiqColl` / `pLiqDebt` — the oracle rounds in
 *             force there — and `valueUsd`, the totals, the LTV and the health factor are
 *             that token count repriced at minute 0 of the path.
 *             FIXED 2026-09-14: this used to divide by the MINUTE-0 price, which
 *             back-solved an amount reproducing the liquidating LTV at midnight. The
 *             fixture then opened already over its line, 21 hours before the wallet
 *             breached, and the hero (which walks from minute 0) sold it repeatedly
 *             across the day where its census row records one sale. The position now
 *             opens healthy and breaches where the price crosses its own line, which is
 *             the census t0. scripts/tests/position-sim.test.ts pins the agreement.
 *   ASSUMED   the deployment, and ONLY the deployment. See below.
 *
 * NO DEPLOYMENT, AND NONE ASSUMED (owner ruling 2026-09-14).
 * This fixture used to ship an ASSUMED deployment - half the measured debt in a venue
 * modelled at 60% recall / 55% fast - on the argument that partial liquidation is no
 * longer a differentiator (Aave V4 has it) and that a page about recall rails needs a
 * wallet with rails. Two measurements retired that argument:
 *
 *   1. The census has NO VENUE IN IT. Every dollar in evidence.json is walked with the
 *      delay window and the repay-to-cap and nothing else. A hero ranked on an assumed
 *      deployment could not be the same claim as the census row underneath it.
 *   2. It is not needed. The bare run already ends ahead on equity, and the gate and the
 *      rank are both taken from it, so the figure on screen is the one the census row
 *      describes rather than the one our venue model produces. (Re-measured 2026-09-14
 *      after the token-amount fix below: the old note here said every candidate went
 *      NEGATIVE under the assumed deployment. That was an artefact of the planted breach
 *      and is no longer true; the deployment is still not shipped, because it is still an
 *      assumption the census does not contain.)
 *
 * So the selection now runs with venue null, gates on equity with no deployment, and
 * ranks on that same figure. The hero equals its census row exactly, and this file has
 * NOTHING assumed left in it: every field is measured, read, or derived.
 *
 * There is no borrow APR in the evidence row, so this wallet still carries NO cost line:
 * the hero shows the safety verdict, which is the whole point of borrower mode.
 *
 * A PASTED ADDRESS NEVER GETS THIS. Simulator.tsx uses `loaded?.detection ?? demoDet` —
 * the assumption belongs to the demo and dies the moment someone types their own address.
 */

import fixture from '../../public/data/demo-borrower.json'
import { stamp, type ProtocolPosition } from './types'
import type { VenueRecall } from './membrane'
import { toVenueRecall, type KnownVenue, type VenueDetection } from './venues'

/** The measured window the evidence set covers, e.g. '2025-10-10T00:00Z to …'. */
export const DEMO_BORROWER_WINDOW: string = fixture.readAt

/** The day the liquidation happened, as the copy says it. */
export const DEMO_BORROWER_DATE = '10 Oct 2025'

/**
 * THERE IS NO DEPLOYMENT. Kept as an export (always null) rather than deleted, so a
 * surface that still reads it gets an explicit absence instead of an undefined.
 */
export const DEMO_BORROWER_ASSUMED = null

/** Why there is none, straight off the generated fixture. Never hand-edited. */
export const DEMO_BORROWER_NO_DEPLOYMENT = fixture.noDeployment

/**
 * What the census MEASURED on this wallet: Aave's real liquidation events summed, and
 * the grid minute of the first one. The hero's first line is written in the past tense,
 * so it must carry these, never the run's replay of Aave's mechanics (which closes more
 * than Aave's liquidators actually did on this wallet).
 */
export const DEMO_BORROWER_MEASURED: MeasuredCensus = {
  aaveClosedUsd: fixture.censusAaveClosedUsd,
  membraneClosedUsd: fixture.censusMembraneClosedUsd,
  t0Index: fixture.censusT0Index,
}
export interface MeasuredCensus {
  aaveClosedUsd: number
  membraneClosedUsd: number
  t0Index: number
}

/**
 * The stamp the UI shows next to the borrower demo wallet. One line, no paragraph — but
 * it must carry the assumption, because this is the only label some readers will see.
 */
export const DEMO_BORROWER_NOTE =
  `liquidated by Aave V3 · ${DEMO_BORROWER_DATE} · no deployment, and none assumed — this ` +
  'wallet had none, so the figure is the bare census row'

/** A real mainnet borrower, checksummed as the selection recorded it. */
export const DEMO_BORROWER_ADDRESS = fixture.address as `0x${string}`

/** The row itself, so callers can quote measured figures rather than re-deriving them. */
export const DEMO_BORROWER_ROW = fixture.row

const PROVENANCE_DETAIL =
  `Measured account from public/data/oct10-2025/evidence.json (${fixture.row.events} ` +
  `liquidation event${fixture.row.events === 1 ? '' : 's'}, $${Math.round(
    fixture.row.aaveClosedUsd,
  ).toLocaleString()} closed by Aave over ${DEMO_BORROWER_WINDOW}). Collateral and debt ` +
  'dollars, health factor and liquidation line are as measured on-chain; the Aave V3 ' +
  'risk parameters are read from protocols.json; the collateral token amount is the ' +
  'measured USD divided by the oracle round in force in the liquidating block, then ' +
  'repriced at minute 0 of the same path. There is NO ' +
  'deployment: this wallet had none and none is assumed, so nothing on this page is a ' +
  'modelled venue balance. Paste any address to read a live position instead.'

/** The sentence every deployment surface repeats, so the assumption is never implicit. */
export const DEMO_BORROWER_DEPLOYMENT_PROVENANCE =
  'none — this wallet had no deployment and none is assumed'

/** Epoch ms for the window open, so the stamp dates the measurement, not the build. */
const MEASURED_AT = Date.parse(DEMO_BORROWER_WINDOW.slice(0, 16) + ':00Z')
const AT = Number.isFinite(MEASURED_AT) ? MEASURED_AT : Date.now()

/**
 * The demo position. `kind: 'dataset'` — read from a committed, measured file under
 * public/data, which is exactly what this is. Never 'mock'.
 */
export function demoBorrowerPosition(): ProtocolPosition {
  const p = fixture.position as unknown as ProtocolPosition
  return {
    ...p,
    provenance: stamp(
      'dataset',
      `real wallet · liquidated by Aave V3 · ${DEMO_BORROWER_DATE}`,
      PROVENANCE_DETAIL,
      AT,
    ),
  }
}

/**
 * NO VENUE. `demoBorrowerDetection()` returns status 'none', which is what the detector
 * returns for any address with no venue balance - the demo now takes the identical path a
 * pasted address takes, with no special case anywhere in it.
 */
export function demoBorrowerDetection(): VenueDetection {
  return {
    status: 'none',
    detected: [],
    totalUsd: 0,
    message: DEMO_BORROWER_NO_DEPLOYMENT.reason,
    provenance: stamp(
      'dataset',
      `deployment ${DEMO_BORROWER_DEPLOYMENT_PROVENANCE}`,
      DEMO_BORROWER_NO_DEPLOYMENT.reason,
      AT,
    ),
  }
}

/**
 * The recall input the engine takes, derived from the detection above through the same
 * `toVenueRecall` a pasted address goes through — so the two paths cannot diverge. The
 * provenance is re-stamped to name the assumption rather than the generic rate model.
 */
export const DEMO_BORROWER_DEPLOYMENT: VenueRecall | null = toVenueRecall(demoBorrowerDetection())

/** A one-line description of the borrower demo used in copy. 25 words or fewer. */
export function demoBorrowerSummary(): string {
  const p = demoBorrowerPosition()
  const a = DEMO_BORROWER_ADDRESS
  const short = `${a.slice(0, 6)}…${a.slice(-4)}`
  const c = p.collateral[0]
  const amount = c.amount >= 100 ? Math.round(c.amount).toLocaleString() : c.amount.toFixed(1)
  const debt = `${Math.round(p.totalDebtUsd / 1000).toLocaleString()}k ${p.debt[0].symbol}`
  return `${short} — ${amount} ${c.symbol} vs ${debt} on ${p.label}, liquidated ${DEMO_BORROWER_DATE}.`
}
