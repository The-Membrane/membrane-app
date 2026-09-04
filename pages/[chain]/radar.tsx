import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Radar } from '@/components/Radar/Radar'

const RadarPage = () => {
  return (
    <>
      <PageSeo
        seoClass="app"
        title="Membrane — Carry Radar: Stress Any Address Against Real Venue Capacity"
        description="Paste any mainnet address and see its positions across sUSDe, sUSDS, scrvUSD, and Aave USDe — each stressed against the instant capacity, cooldown gates, and realized outflow Membrane has actually recorded. No wallet connect."
      />
      <Radar />
    </>
  )
}

export default RadarPage
