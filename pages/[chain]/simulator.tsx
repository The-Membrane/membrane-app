import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Simulator } from '@/components/Simulator'
import { OCT10_SCALE_LINE, OCT10_TOTALS } from '@/lib/position-sim/oct10Totals'

// Position simulator — a marketing surface, so it is indexable (docs/SEO_RULESET.md
// Rule 0). Demo-first: it renders a fully worked example with no wallet, no connect
// gate and no empty state, which is also what makes it worth landing a stranger on.
//
// BORROWER-FIRST build (owner ruling 2026-09-12). The safety verdict is always the
// headline here and the demo is a real wallet Aave V3 liquidated on 10 Oct 2025. The
// carry-first build lives at /[chain]/carry-simulator; config/simulatorMode.ts decides
// which of the two `/` and the nav point at.
const shr = (x: number) => `${(x * 100).toFixed(1)}%`

const SimulatorPage = () => (
  <>
    <PageSeo
      seoClass="indexable"
      title="Membrane — 4%. Cross the line and nothing is sold."
      // The share framing (owner ruling 2026-10-18): each side's own debt, the word by the sign, †.
      description={`Paste any Aave, Spark, Morpho or Compound position and replay it through the measured 10 Oct 2025 crash. On ${OCT10_TOTALS.window}, across ${OCT10_TOTALS.positions.toLocaleString('en-US')} Aave and Morpho liquidations, the protocols force-closed ${shr(OCT10_TOTALS.realShare)} of the debt; at Membrane's own lines a borrower would have lost ${shr(OCT10_TOTALS.membraneShare)}† of theirs, ${OCT10_SCALE_LINE.figure} ${OCT10_SCALE_LINE.direction}, net† (${OCT10_SCALE_LINE.split}). † modelled.`}
    />
    <Simulator mode="borrower" />
  </>
)

export default SimulatorPage
