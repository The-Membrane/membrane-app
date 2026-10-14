import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import { Wavefront } from '@/components/Wavefront'
import { parseTimeParam } from '@/components/Wavefront/format'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// Same shape as pages/[chain]/evidence.tsx: a stale chain redirects server-side before any
// HTML is sent. The replay itself (~1.5 MB) is fetched client-side; ?t= (ISO or unix
// seconds) opens it at that moment instead of playing it.
export const getServerSideProps: GetServerSideProps = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  if (!supportedChains.some((c) => c.name === chainName)) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}/wavefront`, permanent: false } }
  }
  return { props: { initialT: parseTimeParam(context.query.t) } }
}

/**
 * Real vs Membrane liquidation wavefront (Q28 step 3). Not linked from the navigation yet,
 * so it is `internal` (noindex) until the owner signs it off.
 */
const WavefrontPage = ({ initialT }: { initialT: number | null }) => (
  <>
    <PageSeo
      seoClass="internal"
      path={`/${DEFAULT_CHAIN}/wavefront`}
      title="Membrane: Liquidation wavefront, real vs simulated"
      description="Every position liquidated on Aave V3 and Morpho Blue on 10–11 October 2025, one hex each: what the protocols sold, and what Membrane's position simulator would have done with the same positions."
    />
    <Wavefront initialT={initialT} />
  </>
)

export default WavefrontPage
