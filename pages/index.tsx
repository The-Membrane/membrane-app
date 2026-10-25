import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import type { GetServerSideProps } from 'next'
import Head from 'next/head'

import PageSeo from '@/components/PageSeo'
import { SITE_URL } from '@/components/Seo'
import ForecastLanding from '@/components/Landing/ForecastLanding'
import { resolveHeadline, type HeadlineKey } from '@/lib/landing/headline'
import { summariseCensus, type CensusSummary, type EvidenceDocLike } from '@/lib/landing/objections'
import { DEMO_BORROWER_ADDRESS } from '@/lib/position-sim/demoBorrower'

// THE LANDING (lane Q41). `/` serves content (SEO R2): the middleware no longer
// redirects it. Indexable; the headline, deck, objection answers and prose are all in
// the server HTML (R1). The headline A/B is assigned here, per request, through the
// existing mechanism (lib/landingVariant isCrawler; ?v= pins; crawlers get the default).

const structuredData = SITE_URL
  ? JSON.stringify([
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'Membrane',
        url: SITE_URL,
        logo: `${SITE_URL}/images/mbrn.svg`,
      },
      { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Membrane', url: SITE_URL },
    ])
  : null

interface Props {
  headline: HeadlineKey
  census: CensusSummary | null
}

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const headline = resolveHeadline({
    query: context.query?.v,
    userAgent: context.req.headers['user-agent'],
    randomId: randomUUID(),
  })
  // The census summary is a few hundred bytes; the 2MB cohort never reaches the client.
  let census: CensusSummary | null = null
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'public/data/oct10-2025/evidence.json'), 'utf8')
    census = summariseCensus(JSON.parse(raw) as EvidenceDocLike)
  } catch {
    census = null
  }
  // Per-request headline: no shared cache may hold one reader's H1 for another.
  context.res.setHeader('Cache-Control', 'private, no-store')
  return { props: { headline, census } }
}

const IndexPage = ({ headline, census }: Props) => (
  <>
    <PageSeo
      seoClass="indexable"
      path="/"
      title="Replay your borrow through 10 Oct 2025 · Membrane"
      description="Paste a wallet with an Aave, Spark, Morpho or Compound borrow. See it replayed through the measured 10 Oct 2025 crash, on your venue and on Membrane."
      image={`/api/og/replay?a=${DEMO_BORROWER_ADDRESS}&s=oct10-2025`}
    />
    {structuredData && (
      <Head>
        <script key="ld-org" type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} />
      </Head>
    )}
    <ForecastLanding headline={headline} census={census} />
  </>
)

export default IndexPage
