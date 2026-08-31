import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Borrow } from '@/components/Borrow'

const BorrowPage = () => {
  return (
    <>
      <PageSeo
        seoClass="app"
        title="Membrane — Borrow CDT Against Your Crypto"
        description="Post collateral you already hold and mint CDT straight to your wallet. Plain debt, an 8-hour cure window, and liquidation that repays to the cap, not to zero."
      />
      <Borrow />
    </>
  )
}

export default BorrowPage
