import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Carry } from '@/components/Carry'
import { DEFAULT_CHAIN } from '@/config/chains'

const CarryPage = () => {
  return (
    <>
      <PageSeo
        seoClass="indexable"
        path={`/${DEFAULT_CHAIN}/carry`}
        title="Membrane Carry — The Measured Stablecoin Yield Board, Exit Costs Priced In"
        description="The carry board: real stablecoin yields across sUSDe, sUSDS, scrvUSD and Aave USDe, each stressed against the withdrawal capacity and realized outflow we have actually recorded. Find the spread, size in, and see the exit before you take it."
      />
      <Carry />
    </>
  )
}

export default CarryPage
