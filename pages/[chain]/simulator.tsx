import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Simulator } from '@/components/Simulator'

// Position simulator — a marketing surface, so it is indexable (docs/SEO_RULESET.md
// Rule 0). Demo-first: it renders a fully worked example with no wallet, no connect
// gate and no empty state, which is also what makes it worth landing a stranger on.
//
// BORROWER-FIRST build (owner ruling 2026-09-12). The safety verdict is always the
// headline here and the demo is a real wallet Aave V3 liquidated on 10 Oct 2025. The
// carry-first build lives at /[chain]/carry-simulator; config/simulatorMode.ts decides
// which of the two `/` and the nav point at.
const SimulatorPage = () => (
  <>
    <PageSeo
      seoClass="indexable"
      title="Membrane — Position Simulator"
      description="Take any lending position on Aave, Spark, Morpho or Compound and replay it through the measured October 2025 crash under two liquidation engines. Same prices, same collateral, different endings."
    />
    <Simulator mode="borrower" />
  </>
)

export default SimulatorPage
