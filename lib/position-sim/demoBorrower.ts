/**
 * THE BORROWER-MODE DEMO WALLET — AND IT IS A REAL ONE THAT AAVE ACTUALLY LIQUIDATED.
 *
 * The carry page opens on a live carry (demo.ts, a mainnet snapshot). The borrower page
 * cannot: a borrower-first landing has to open on the thing a borrower is afraid of, and
 * the only honest way to show that is a wallet the crash actually took.
 *
 * WHERE IT COMES FROM: public/data/demo-borrower.json is selected out of
 * public/data/oct10-2025/evidence.json — 2,350 measured Aave V3 accounts over the
 * 10-11 Oct 2025 window, each judged against its OWN measured liquidation line. The
 * selection ran the page's own engine over every mainnet row whose collateral the
 * measured price path prices and whose debt is a stable held flat, in the 60k-1.5M band,
 * and kept the one with the largest positive equity delta.
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
 *             minute 0 of the same measured path. Nothing else is invented.
 *
 * WHAT IS DELIBERATELY ABSENT: a deployment. A wallet Aave liquidated in the crash had
 * no venue capital standing behind it, and the borrower demo does not pretend otherwise
 * — demoBorrowerDetection() returns status 'none' and the recall input is null. There is
 * no borrow APR in the evidence row either, so this wallet carries NO cost line at all:
 * the hero shows the safety verdict, which is the whole point of borrower mode.
 */

import fixture from '../../public/data/demo-borrower.json'
import { stamp, type ProtocolPosition } from './types'
import type { VenueDetection } from './venues'

/** The measured window the evidence set covers, e.g. '2025-10-10T00:00Z to …'. */
export const DEMO_BORROWER_WINDOW: string = fixture.readAt

/** The day the liquidation happened, as the copy says it. */
export const DEMO_BORROWER_DATE = '10 Oct 2025'

/** The stamp the UI shows next to the borrower demo wallet. One line, no paragraph. */
export const DEMO_BORROWER_NOTE = `liquidated by Aave V3 · ${DEMO_BORROWER_DATE}`

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
  'measured USD divided by the oracle price at minute 0 of the same path. Paste any ' +
  'address to read a live position instead.'

/** Epoch ms for the window open, so the stamp dates the measurement, not the build. */
const MEASURED_AT = Date.parse(DEMO_BORROWER_WINDOW.slice(0, 16) + ':00Z')

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
      `real wallet · ${DEMO_BORROWER_NOTE}`,
      PROVENANCE_DETAIL,
      Number.isFinite(MEASURED_AT) ? MEASURED_AT : Date.now(),
    ),
  }
}

/**
 * No deployment, stated rather than assumed. The engine gets a null recall input from
 * `toVenueRecall`, so Membrane's side of this run has nothing to recall — it wins or
 * loses on the liquidation mechanics alone.
 */
export function demoBorrowerDetection(): VenueDetection {
  return {
    status: 'none',
    detected: [],
    totalUsd: 0,
    message:
      'This wallet was liquidated in the October 2025 crash. It had no deployment behind ' +
      'it, and none is assumed here.',
    provenance: stamp(
      'dataset',
      `no deployment · ${DEMO_BORROWER_NOTE}`,
      PROVENANCE_DETAIL,
      Number.isFinite(MEASURED_AT) ? MEASURED_AT : Date.now(),
    ),
  }
}

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
