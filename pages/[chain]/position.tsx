import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Position } from '@/components/Position'

/**
 * The Position page — the wallet's whole account view (ported from
 * public/proto/dash.html). Demo alias: /[chain]/position?demo (or #demo)
 * forces demo mode via useDemoMode — this replaces the proto's demo.html,
 * which was byte-identical apart from window.__FORCE_DEMO.
 */
const PositionPage = () => {
  return (
    <>
      <PageSeo
        seoClass="app"
        title="Membrane — Position"
        description="Your whole position: collateral, LTV window, headroom, debt, measured yield throughput, per-intent countdowns, survived encounters, and calibration."
      />
      <Position />
    </>
  )
}

export default PositionPage
