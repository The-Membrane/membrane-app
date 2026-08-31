import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Defend } from '@/components/Defend'

const DefendPage = () => {
  return (
    <>
      <PageSeo
        seoClass="app"
        title="Membrane — Defend: Design a Better Risk Curator"
        description="Submit a risk-curator program, score it over 1,000 randomized simulations against hidden regimes, and rank it by average edge. Compare Membrane's delayed liquidation against instant-venue liquidation in a canvas duel sim."
      />
      <Defend />
    </>
  )
}

export default DefendPage
