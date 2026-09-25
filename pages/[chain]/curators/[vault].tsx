import React from 'react'
import { useRouter } from 'next/router'

import { CuratorProfile } from '@/components/Curators/CuratorProfile'
import PageSeo from '@/components/PageSeo'

// Internal until mainnet: every figure is a local-chain read and must not be indexed.
const CuratorVaultPage = () => {
  const router = useRouter()
  const vault = typeof router.query.vault === 'string' ? router.query.vault : ''
  return (
    <>
      <PageSeo
        seoClass="internal"
        title="Membrane — Curator vault"
        description="One curator vault in CuratorRegistry: bond, AUM cap, ramp, realized rate, bucket, trailing payments, slashes, and its event history."
      />
      {router.isReady && <CuratorProfile vault={vault} />}
    </>
  )
}

export default CuratorVaultPage
