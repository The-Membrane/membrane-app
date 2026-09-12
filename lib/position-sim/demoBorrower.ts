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
 * 50k-3M band, and kept the one that SURVIVES on Membrane with the largest equity delta.
 *
 * WHAT IS MEASURED, AND WHAT IS RECONSTRUCTED — say both:
 *   MEASURED  the address, the collateral and debt USD at the window open, the debt and
 *             collateral symbols, the health factor, the account's own liquidation line,
 *             the number of liquidation events and the USD Aave actually closed.
 *   READ      the Aave V3 risk parameters (LTV / liquidation threshold / bonus) come
 *             from public/data/oct10-2025/protocols.json, read at mainnet block
 *             23543615 — not assumed.
 *   DERIVED   the collateral TOKEN amount. The evidence row records dollars, so the
 *             amount is the measured USD divided by the collateral's oracle price at
 *             minute 0 of the same measured path.
 *   ASSUMED   the deployment, and ONLY the deployment. See below.
 *
 * THE ONE ASSUMED THING, and why it is here (owner ruling 2026-09-12).
 * The page used to state proudly that the deployment was ABSENT: a wallet Aave liquidated
 * had no venue capital behind it, so demoBorrowerDetection() returned status 'none' and
 * Membrane won on partial-liquidation mechanics alone. Two things killed that:
 *
 *   1. Partial liquidation is no longer a differentiator. Aave V4 has it. Winning by
 *      $6.5k on repay-to-cap sells a feature the competitor also ships.
 *   2. It does not even work. Swept with no deployment, ZERO of the 63 eligible wallets
 *      survive on Membrane — MEMBRANE_ASSET_LTV sits UNDER Aave's liquidation threshold
 *      for every eligible collateral (WETH 80% vs 83%, WBTC 75% vs 78%), so Membrane
 *      breaches FIRST, and with nothing to recall the 8-hour cure window can never fire.
 *      Membrane's line on the chart sat below Aave's on every single real wallet.
 *
 * What actually differs is the RECALL RAILS: capital deployed out of the borrowed dollars
 * answers the margin call inside the 4% window, and nothing is sold. A page about rails
 * cannot open on a wallet with no rails — and no real Oct 10 wallet had any. So the
 * default is a REAL wallet plus an ASSUMED deployment, labelled as such at every surface
 * it touches: half the measured debt in a venue modelled at 60% recall / 55% fast, the
 * same rates the carry worked example already quotes. The whole page is a counterfactual
 * ("what if this wallet had been on Membrane"); the deployment is one more clause of it,
 * stated rather than smuggled. It is counted on BOTH balance sheets — runSource adds
 * deployedUsd to Aave's equity too — so it buys Membrane the recall and nothing else.
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

/** The assumed deployment, straight off the generated fixture. Never hand-edited. */
export const DEMO_BORROWER_ASSUMED = fixture.assumedDeployment

const PCT = (n: number) => `${Math.round(n * 100)}%`

/**
 * The stamp the UI shows next to the borrower demo wallet. One line, no paragraph — but
 * it must carry the assumption, because this is the only label some readers will see.
 */
export const DEMO_BORROWER_NOTE =
  `liquidated by Aave V3 · ${DEMO_BORROWER_DATE} · deployment assumed — the recall rails ` +
  'are the difference, not partial liquidation'

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
  'measured USD divided by the oracle price at minute 0 of the same path. The DEPLOYMENT ' +
  'is the one assumed figure — see the deployment note. Paste any address to read a live ' +
  'position instead.'

/** The sentence every deployment surface repeats, so the assumption is never implicit. */
export const DEMO_BORROWER_DEPLOYMENT_PROVENANCE =
  `assumed — half the debt deployed in a venue modelled at ${PCT(
    DEMO_BORROWER_ASSUMED.recallRate,
  )} recall; the real wallet had none`

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
    provenance: stamp('dataset', `real wallet · liquidated by Aave V3 · ${DEMO_BORROWER_DATE}`, PROVENANCE_DETAIL, AT),
  }
}

/**
 * The ASSUMED venue, shaped as a KnownVenue so it flows through the same
 * `excludeOwnCollateral` → `toVenueRecall` pipe a pasted address goes through and lands
 * in the deployment table with its rates on display.
 *
 * `underlying` is deliberately 'USD' rather than a real ticker: it must not collide with
 * a collateral symbol (excludeOwnCollateral would drop the row) and it must not read as
 * a token this wallet actually held. The address is the zero address for the same
 * reason — there is no contract to point at, because there was no deployment.
 */
const ASSUMED_VENUE: KnownVenue = {
  symbol: 'assumed',
  underlying: 'USD',
  name: 'Assumed deployment (not a detected balance)',
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  exit: `assumed, not read: ${PCT(DEMO_BORROWER_ASSUMED.recallRate)} returns on demand and ` +
    `${PCT(DEMO_BORROWER_ASSUMED.fastRate)} arrives inside the 8-hour window — the carry ` +
    'example’s own rates. This wallet had no deployment; the page assumes one so the ' +
    'recall rails have something to recall.',
  recallRate: DEMO_BORROWER_ASSUMED.recallRate,
  fastRate: DEMO_BORROWER_ASSUMED.fastRate,
}

/**
 * The demo's deployment — ASSUMED, and stamped 'modelled' so no surface can render it as
 * a read. Status is 'detected' because the engine and the deployment table key off that,
 * but every label the user sees says assumed.
 */
export function demoBorrowerDetection(): VenueDetection {
  const deployedUsd = DEMO_BORROWER_ASSUMED.deployedUsd
  return {
    status: 'detected',
    detected: [{ venue: ASSUMED_VENUE, amount: deployedUsd, valueUsd: deployedUsd }],
    totalUsd: deployedUsd,
    message: DEMO_BORROWER_ASSUMED.note,
    provenance: stamp(
      'modelled',
      `deployment ${DEMO_BORROWER_DEPLOYMENT_PROVENANCE}`,
      DEMO_BORROWER_ASSUMED.note,
      AT,
    ),
  }
}

/**
 * The recall input the engine takes, derived from the detection above through the same
 * `toVenueRecall` a pasted address goes through — so the two paths cannot diverge. The
 * provenance is re-stamped to name the assumption rather than the generic rate model.
 */
export const DEMO_BORROWER_DEPLOYMENT: VenueRecall | null = (() => {
  const recall = toVenueRecall(demoBorrowerDetection())
  if (!recall) return null
  return {
    ...recall,
    provenance: stamp(
      'modelled',
      `deployment ${DEMO_BORROWER_DEPLOYMENT_PROVENANCE}`,
      DEMO_BORROWER_ASSUMED.note,
      AT,
    ),
  }
})()

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
