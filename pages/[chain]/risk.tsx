import React from 'react'
import dynamic from 'next/dynamic'

import PageSeo from '@/components/PageSeo'

// Client-only: reads the local anvil from the browser; nothing to prerender.
const RiskDesk = dynamic(() => import('@/components/RiskDesk/RiskDesk'), { ssr: false })

const RiskPage = () => (
  <>
    {/* Rule 0 (docs/SEO_RULESET.md): internal — local-chain data must not be indexed */}
    <PageSeo
      seoClass="internal"
      title="Membrane — Risk Desk"
      description="Per-asset max LTV, its scheduled change, and bad-debt waterfall coverage, read from a local chain."
    />
    <RiskDesk />
  </>
)

export default RiskPage
