import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Carry } from '@/components/Carry'

const CarryPage = () => {
  return (
    <>
      <PageSeo
        seoClass="app"
        title="Membrane — Carry: Borrow Against Dollars That Keep Earning"
        description="Open a carry: borrow CDT against yield-bearing stablecoins and route it through venues in the same motion. One preset picks collateral, leverage, and venue mix; survival is measured against six years of 8-hour moves."
      />
      <Carry />
    </>
  )
}

export default CarryPage
