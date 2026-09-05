import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Borrow } from '@/components/Borrow'
import { DEFAULT_CHAIN } from '@/config/chains'

// seoClass `indexable`, not `app`: docs/SEO_RULESET.md lists borrow as the indexable
// example, and this is the highest-intent product page — the one AI engines cite at
// the decision moment (docs/GEO_AUDIT.md P0). Explicit `path` so canonical/og:url
// resolve to the chain route rather than the visitor's arrival URL.
const BorrowPage = () => {
  return (
    <>
      <PageSeo
        seoClass="indexable"
        path={`/${DEFAULT_CHAIN}/borrow`}
        title="Membrane — Borrow CDT Against Your Crypto"
        description="Post collateral you already hold and mint CDT straight to your wallet. Plain debt, an 8-hour cure window, and liquidation that repays to the cap, not to zero."
      />
      <Borrow />
    </>
  )
}

export default BorrowPage
