import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Simulator } from '@/components/Simulator'
import { LANDING_PASTE_PROMPT, LANDING_TAGLINE } from '@/lib/position-sim/guarantee'
import { OCT10_SCALE_LINE } from '@/lib/position-sim/oct10Totals'

// Position simulator — a marketing surface, so it is indexable (docs/SEO_RULESET.md
// Rule 0). Demo-first: it renders a fully worked example with no wallet, no connect
// gate and no empty state, which is also what makes it worth landing a stranger on.
//
// BORROWER-FIRST build (owner ruling 2026-09-12). The safety verdict is always the
// headline here and the demo is a real wallet Aave V3 liquidated on 10 Oct 2025. The
// carry-first build lives at /[chain]/carry-simulator; config/simulatorMode.ts decides
// which of the two `/` and the nav point at.
//
// NEWS EDITION (owner rulings T20 / Q11, lane started 2026-10-11): this page is the
// newspaper. It signs nothing, so all of it is news and none of it is a ledger slip.
// The carry-first page and the seniority hero mount the same Simulator unchanged.
const SimulatorPage = () => (
  <>
    <PageSeo
      seoClass="indexable"
      title={`Membrane — ${LANDING_TAGLINE}`}
      description={`${LANDING_PASTE_PROMPT} and replay it through the measured 10 Oct 2025 crash. Membrane's 4% window would have kept ${OCT10_SCALE_LINE.figure} of collateral that day.`}
    />
    <Simulator mode="borrower" edition="news" />
  </>
)

export default SimulatorPage
