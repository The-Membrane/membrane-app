import Stake from '@/components/Stake'
import PageSeo from '@/components/PageSeo'
import React from 'react'
import { DEFAULT_CHAIN } from '@/config/chains'

const StakePage = () => {
  return (
    <>
      {/* Rule 0 (docs/SEO_RULESET.md): indexable — marketing entry page for MBRN staking */}
      <PageSeo
        seoClass="indexable"
        title="Membrane Stake: MBRN Staking"
        description="Stake MBRN, the Membrane governance token, to earn staking rewards and take part in protocol governance."
        path={`/${DEFAULT_CHAIN}/stake`}
      />
      <Stake />
    </>
  )
}

export default StakePage
