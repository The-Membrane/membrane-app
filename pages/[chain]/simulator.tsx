import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Simulator } from '@/components/Simulator'
import { CORPUS_SCALE_LINE, OCT10_SCALE_LINE } from '@/lib/position-sim/oct10Totals'

const SCALE = CORPUS_SCALE_LINE.partial ? OCT10_SCALE_LINE : CORPUS_SCALE_LINE

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
      title={
        CORPUS_SCALE_LINE.partial
          ? `Membrane — ${SCALE.figure} of debt protected in a modeled replay`
          : `Membrane — ${SCALE.figure} of collateral a 4% window would have kept`
      }
      description={
        CORPUS_SCALE_LINE.partial
          ? `Membrane's 4% window would have protected ${SCALE.figure} of debt from forced closure on 10 Oct 2025. Compare your own position with the measured Aave V3 episode.`
          : `Membrane's 4% window would have kept ${SCALE.figure} of collateral over ${CORPUS_SCALE_LINE.years} years of Aave V3 mainnet. Modeled against observed liquidation episodes.`
      }
    />
    <Simulator mode="borrower" />
  </>
)

export default SimulatorPage
