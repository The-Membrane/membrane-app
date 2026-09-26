import React from 'react'
import dynamic from 'next/dynamic'

import PageSeo from '@/components/PageSeo'

// Client-only: reads the local anvil from the browser; nothing to prerender (same as /risk).
const CuratorsTable = dynamic(() => import('@/components/Curators/CuratorsTable').then((m) => m.CuratorsTable), { ssr: false })

// Internal until mainnet: every figure is a local-chain read and must not be indexed.
const CuratorsPage = () => (
  <>
    <PageSeo
      seoClass="internal"
      title="Membrane — Curators"
      description="Every curator vault listed in CuratorRegistry: bond, AUM cap, ramp, realized rate, bucket, trailing payments, slashes."
    />
    <CuratorsTable />
  </>
)

export default CuratorsPage
