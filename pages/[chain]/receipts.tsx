import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Receipts } from '@/components/Receipts/Receipts'

const ReceiptsPage = () => {
  return (
    <>
      <PageSeo
        seoClass="app"
        title="Membrane — Called It: Sign a Venue Call, Get a Scored Receipt"
        description="Sign a probability call on a venue outcome with your wallet. The Membrane recorder scores it against what actually happened and gives you a dated, shareable receipt. Calibration and process only — never returns, never a leaderboard by wins."
      />
      <Receipts />
    </>
  )
}

export default ReceiptsPage
