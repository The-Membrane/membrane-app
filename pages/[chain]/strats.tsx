import React from 'react'

import PageSeo from '@/components/PageSeo'
import { StratsBoard } from '@/components/Strats/StratsBoard'

const StratsPage = () => {
  return (
    <>
      <PageSeo
        seoClass="app"
        title="Membrane — Carry Strats: Real Carry Positions, Auto-Tracked"
        description="A wallet-free, shareable dashboard of real carry strategies auto-discovered on mainnet across sUSDe, sUSDS, scrvUSD, and Aave USDe — each stressed against the instant capacity, cooldown gates, and realized outflow Membrane has actually recorded. Entered → now, at a glance."
      />
      <StratsBoard />
    </>
  )
}

export default StratsPage
