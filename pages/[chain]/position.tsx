import React from 'react'

import PageSeo from '@/components/PageSeo'
import { PositionV0 } from '@/components/PositionV0'

/**
 * The position page: the reader's own liquidation line, read from Aave V3, Spark, Morpho
 * Blue and Compound V3 for a pasted address or a connected wallet. Read-only; it signs
 * nothing. Replaces the fixture dashboard cut on 2026-10-12 (docs/CUTS-2026-10-12.md, cut 2).
 */
const PositionPage = () => (
  <>
    <PageSeo
      seoClass="app"
      title="Membrane — Your liquidation line"
      description="Paste an address: your liquidation price on Aave, Spark, Morpho or Compound, how far it sits from today's price, how often ETH or BTC moved that far before, and what repay or top-up moves it."
    />
    <PositionV0 />
  </>
)

export default PositionPage
