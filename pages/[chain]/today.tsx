import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import { TodayEdition } from '@/components/Today/TodayEdition'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// The Today edition: the newspaper masthead with the market weather strip (gas, ETH
// volatility from DVOL, the M0 regime), then Opportunities when calm or Safety when choppy,
// and how the regime is set. First in the nav, but still seoClass `app` (noindex) while the
// owner decides whether '/' points here. Invalid chains redirect server-side, as on
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
      description="Market weather: the calm or choppy regime from Chainlink and Coinbase, with every input's age. Calm leads with venue rates at your size; choppy leads with your position, venue alarms and curator exits."
    />
    <TodayEdition />
  </>
)

export default TodayPage
