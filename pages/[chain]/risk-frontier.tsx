import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import { RiskFrontier } from '@/components/RiskFrontier/RiskFrontier'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// Risk Frontier sandbox (docs/RISK_FRONTIER_DESIGN.md §3): a test harness for the stress-grid
// and frontier engines. Internal (noindex) until the owner rules on design §8 Q5 — whether the
// MVP may go public before G2. Not in global nav. Invalid chains redirect, as practice.tsx does.
export const getServerSideProps: GetServerSideProps = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  if (!supportedChains.some((c) => c.name === chainName)) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}/risk-frontier`, permanent: false } }
  }
  return { props: {} }
}

const RiskFrontierPage = () => (
  <>
    <PageSeo
      seoClass="internal"
      title="Membrane — Risk Frontier (sandbox)"
      description="Place a hypothetical position inside fixed stress scenarios and see how far it is from arming the delay window or forcing a sale. Stress scenarios, not probabilities."
    />
    <RiskFrontier />
  </>
)

export default RiskFrontierPage
