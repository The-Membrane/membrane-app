import React from 'react'

import PageSeo from '@/components/PageSeo'
import { EarnPage } from '@/components/EarnPage'

const EarnRoutePage = () => {
  return (
    <>
      <PageSeo
        seoClass="app"
        title="Membrane — Earn"
        description="Stake a senior or junior tranche, see what backs your seat, what you can withdraw right now, where losses land first, and what fees you've earned."
      />
      <EarnPage />
    </>
  )
}

export default EarnRoutePage
