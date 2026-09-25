import React from 'react'

import { CuratorsTable } from '@/components/Curators/CuratorsTable'
import PageSeo from '@/components/PageSeo'

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
