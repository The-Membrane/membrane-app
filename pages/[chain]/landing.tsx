import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Landing } from '@/components/Landing'

/**
 * The marketing surface — the one indexable page. Operable before any wallet:
 * the hero instrument, counterfactual, risk numbers and measured routes all
 * render from illustrative/measured fixtures with no connect gate.
 */
const LandingPage = () => {
  return (
    <>
      <PageSeo
        seoClass="indexable"
        title="Membrane — Borrow Against Your Bitcoin, Keep the Bitcoin"
        description="Post BTC, mint the CDT stablecoin, and deploy it into measured on-chain venues. See what selling would have cost, an 8-hour cure timer instead of an instant close, and 1,245 real carry positions measured on-chain."
      />
      <Landing />
    </>
  )
}

export default LandingPage
