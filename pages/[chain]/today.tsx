import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import { TodayEdition } from '@/components/Today/TodayEdition'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// The Today edition: the newspaper masthead with the market weather strip (gas, ETH
// volatility from DVOL, the M0 regime) and how the regime is set. UNLINKED while it is built (not in
// the nav), so seoClass `app`: noindex. Invalid chains redirect server-side, as on
// pages/[chain]/glossary.tsx.
export const getServerSideProps: GetServerSideProps = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  if (!supportedChains.some((c) => c.name === chainName)) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}/today`, permanent: false } }
  }
  return { props: {} }
}

const TodayPage = () => (
  <>
    <PageSeo
      seoClass="app"
      title="Membrane — Today"
      description="Market weather: the calm or choppy regime from Chainlink and Coinbase, ETH volatility as options price it (a daily swing, up or down), and the Ethereum base fee, with every input's age."
    />
    <TodayEdition />
  </>
)

export default TodayPage
