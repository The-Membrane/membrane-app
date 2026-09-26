import React from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'

import PageSeo from '@/components/PageSeo'

// Client-only: reads the local anvil from the browser; nothing to prerender (same as /risk).
const CuratorProfile = dynamic(() => import('@/components/Curators/CuratorProfile').then((m) => m.CuratorProfile), { ssr: false })

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
