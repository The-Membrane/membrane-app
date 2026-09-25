import React from 'react'
import type { GetServerSideProps } from 'next'
import Head from 'next/head'

import PageSeo from '@/components/PageSeo'
import { SITE_URL } from '@/components/Seo'
import { Glossary } from '@/components/Glossary/Glossary'
import { buildDefinedTermSet } from '@/components/Glossary/terms'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// Public glossary: seoClass `indexable`, one canonical URL (/ethereum/glossary),
// server-rendered so a crawler sees every definition. Invalid chains redirect
// server-side, same as pages/[chain]/evidence.tsx.
export const getServerSideProps: GetServerSideProps = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  if (!supportedChains.some((c) => c.name === chainName)) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}/glossary`, permanent: false } }
  }
  return { props: {} }
}

// Emitted only when the canonical origin is known (pages/[chain]/index.tsx pattern).
const structuredData = SITE_URL ? JSON.stringify(buildDefinedTermSet(SITE_URL, DEFAULT_CHAIN)) : null

const GlossaryPage = () => (
  <>
    <PageSeo
      seoClass="indexable"
      path={`/${DEFAULT_CHAIN}/glossary`}
      title="Membrane: Glossary"
      description="Definitions of exit legs (instant, cooldown, flow), verdicts (clear, caution, exposed), size tiers (instant, cooldown, stranded), instant swap-out depth and venue alarm rules, with the thresholds the code uses."
    />
    {structuredData && (
      <Head>
        <script key="ld-glossary" type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} />
      </Head>
    )}
    <Glossary />
  </>
)

export default GlossaryPage
