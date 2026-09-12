/**
 * THE WALLET THE PAGE OPENS ON — AND IT IS A REAL ONE.
 *
 * DEMO-FIRST (CLAUDE.md V20): the simulator renders fully populated before anyone
 * types an address. There is no empty state and no connect gate.
 *
 * WHAT CHANGED, AND WHY (owner, 2026-09-11): "why is the worked example not just the
 * demo wallet shown?" The page used to open on INVENTED balances — 40 WETH, 1.5 WBTC,
 * 250k of USDC, none of it belonging to anybody — with a made-up deployment attached.
 * A landing page selling a carry product cannot open on a wallet that does not exist,
 * and it certainly cannot put a dollar saving on invented debt.
 *
 * So every number below is READ. public/data/demo-carry.json is a snapshot taken by
 * scripts/snapshot-demo-carry.mjs, which runs THE PAGE'S OWN adapters
 * (lib/position-sim/adapters) and THE PAGE'S OWN venue scan (detectVenues) against a
 * mainnet node and commits the result verbatim. The position, the borrow APR, the
 * liquidation thresholds and the venue balances are all that read. Nothing here is
 * authored by hand; to change the demo, re-run the script.
 *
 * WHAT IS STILL MODELLED: the recall rates. `toVenueRecall` turns the detected
 * balances into a recall input using KNOWN_VENUES' per-venue recallRate/fastRate, which
 * are our reading of each venue's exit mechanics — not measured, and editable in the
 * controls. The DEPLOYED DOLLARS are real; the share of them that comes back inside
 * eight hours is a model, and it is stamped as one.
 *
 * The snapshot is a moment, not a live feed. Say so wherever it renders
 * (DEMO_SNAPSHOT_NOTE) — pasting the same address re-reads it live.
 */

import snapshot from '../../public/data/demo-carry.json'
import { excludeOwnCollateral, toVenueRecall, type VenueDetection } from './venues'
import { stamp, type ProtocolPosition } from './types'
import type { VenueRecall } from './membrane'

/** The snapshot's own date, derived from the file rather than typed twice. */
export const DEMO_SNAPSHOT_DATE = snapshot.readAt.slice(0, 10)

/** The stamp the UI shows next to the demo wallet. One line, no paragraph. */
export const DEMO_SNAPSHOT_NOTE = `snapshot ${DEMO_SNAPSHOT_DATE} · re-read live by pasting the address`

/** A real mainnet borrower, checksummed as the snapshot recorded it. */
export const DEMO_ADDRESS = snapshot.address as `0x${string}`

const PROVENANCE_DETAIL =
  `Read on-chain at block ${snapshot.block} on ${DEMO_SNAPSHOT_DATE} by ` +
  'scripts/snapshot-demo-carry.mjs, through this page’s own adapters. Balances, prices, ' +
  'risk parameters and the borrow rate are all as the protocol reported them at that ' +
  'block. Paste the address to re-read it live.'

const SNAPSHOT_AT = Date.parse(snapshot.readAt)

/**
 * The demo position, exactly as the adapter returned it.
 *
 * The provenance is re-stamped rather than replayed: the committed stamp carries the
 * `at` of the snapshot run, and re-stating it here keeps the label honest about the
 * fact that this is a SNAPSHOT of an on-chain read, not a read happening now.
 */
export function demoPosition(): ProtocolPosition {
  const p = snapshot.position as unknown as ProtocolPosition
  return {
    ...p,
    provenance: stamp(
      'onchain',
      `real wallet · snapshot ${DEMO_SNAPSHOT_DATE}`,
      PROVENANCE_DETAIL,
      SNAPSHOT_AT,
    ),
  }
}

/**
 * The demo's DETECTED deployment — the same venue scan a pasted address gets, through
 * the same collateral filter. The snapshot's raw scan finds the wallet's aEthUSDC, but
 * that IS its Aave collateral: excludeOwnCollateral drops it, so the page shows no
 * deployment rather than crediting the borrower with deploying its own collateral.
 */
export function demoDetection(): VenueDetection {
  const d = excludeOwnCollateral(
    snapshot.detection as unknown as VenueDetection,
    snapshot.position as unknown as { collateral: { symbol: string }[] },
  )
  return {
    ...d,
    provenance: stamp(
      'onchain',
      `venue scan · snapshot ${DEMO_SNAPSHOT_DATE}`,
      PROVENANCE_DETAIL,
      SNAPSHOT_AT,
    ),
  }
}

/**
 * The demo's recall input, DERIVED from the detection above.
 *
 * It is no longer a hand-picked pair of rates on a hand-picked dollar amount: the
 * dollars come from the scan and the rates come from KNOWN_VENUES, through the same
 * `toVenueRecall` a pasted address goes through. Null when the snapshot detected
 * nothing — in which case the page shows no deployment at all rather than assuming one.
 */
export const DEMO_DEPLOYMENT: VenueRecall | null = toVenueRecall(demoDetection())

/** A one-line description of the demo used in copy, so the number never drifts. */
export function demoSummary(): string {
  const p = demoPosition()
  const d = demoDetection()
  const short = `${DEMO_ADDRESS.slice(0, 6)}…${DEMO_ADDRESS.slice(-4)}`
  const debt = `$${Math.round(p.totalDebtUsd / 1000).toLocaleString()}k`
  const backing = p.collateral.map((c) => c.symbol).join(' + ')
  const where = d.detected.length
    ? `deployed in ${d.detected.map((x) => x.venue.symbol).join(' + ')}`
    : 'no deployment detected'
  return `${short} — ${debt} of ${p.debt.map((x) => x.symbol).join(' + ')} on ${p.label} against ${backing}, ${where}, read ${DEMO_SNAPSHOT_DATE}.`
}
