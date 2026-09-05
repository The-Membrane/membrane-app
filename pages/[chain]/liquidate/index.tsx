import Bid from '@/components/Bid'
import React from 'react'
import PageSeo from '@/components/PageSeo'

const BidPage = () => {
  return (
    <>
      {/* Rule 0 (docs/SEO_RULESET.md): app — wallet-gated liquidation bidding tool */}
      <PageSeo
        seoClass="app"
        title="Membrane — Liquidation Bidding"
        description="Place and manage stability pool bids to take part in Membrane liquidations, track your bid risk, and claim liquidation proceeds from your connected wallet."
      />
      <Bid />
    </>
  )
}

export default BidPage
