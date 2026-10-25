/**
 * THE TWO LANDINGS: `/` for borrowers, `/carry` for carry traders. Same components, same
 * STORY; this picks the copy, the demo wallet and the objection cards.
 */

import {
  DEMO_BORROWER_ADDRESS,
  DEMO_BORROWER_DATE,
  DEMO_BORROWER_ROW,
  demoBorrowerDetection,
  demoBorrowerPosition,
  type ProtocolPosition,
  type VenueDetection,
} from '@/lib/position-sim'

import { CARRY_HEADLINES, CARRY_OBJECTIONS, CARRY_SUBHEAD_DESKTOP, CARRY_SUBHEAD_PHONE } from './carry'
import type { CensusRow } from './census'
import { HEADLINES, SUBHEAD_DESKTOP, SUBHEAD_PHONE, type HeadlineCopy, type HeadlineKey } from './headline'
import { OBJECTIONS, type ObjectionCard } from './objections'

export type LandingPageId = 'borrower' | 'carry'

export interface DemoConfig {
  address: `0x${string}`
  position: () => ProtocolPosition
  detection: () => VenueDetection
  /** The demo's measured census row, when it has one (the borrower demo). */
  census: CensusRow | null
  bannerNote: string
}

export interface LandingPageConfig {
  id: LandingPageId
  path: string
  headlines: Record<HeadlineKey, HeadlineCopy>
  subhead: { desktop: string; phone: string }
  demo: DemoConfig
  objections: ObjectionCard[]
}

const R = DEMO_BORROWER_ROW

/**
 * The census wallet both landings open on (parent review 2026-10-25: the old carry
 * snapshot was a non-event on 10 Oct 2025, so its T beat said nothing was sold). It is the
 * one census row with a vetted fixture (scripts/select-demo-borrower.ts): mainnet, WETH
 * collateral against USDC debt, Aave closed $338,084 (measured). The census holds no
 * deployment, so on /carry this demo shows no recall; the carry tails render only for a
 * pasted wallet that has one.
 */
const CENSUS_DEMO: DemoConfig = {
  address: DEMO_BORROWER_ADDRESS,
  position: demoBorrowerPosition,
  detection: demoBorrowerDetection,
  census: {
    user: R.user,
    events: R.events,
    t0Index: R.t0Index,
    aaveClosedUsd: R.aaveClosedUsd,
    membraneClosedUsd: R.membraneClosedUsd,
    outcome: R.outcome,
    collSymbol: R.collSymbol,
    debtSymbol: R.debtSymbol,
  },
  bannerNote: `liquidated ${DEMO_BORROWER_DATE}`,
}

export const LANDING_PAGES: Record<LandingPageId, LandingPageConfig> = {
  borrower: {
    id: 'borrower',
    path: '/',
    headlines: HEADLINES,
    subhead: { desktop: SUBHEAD_DESKTOP, phone: SUBHEAD_PHONE },
    demo: CENSUS_DEMO,
    objections: OBJECTIONS,
  },
  carry: {
    id: 'carry',
    path: '/carry',
    headlines: CARRY_HEADLINES,
    subhead: { desktop: CARRY_SUBHEAD_DESKTOP, phone: CARRY_SUBHEAD_PHONE },
    demo: CENSUS_DEMO,
    objections: CARRY_OBJECTIONS,
  },
}
