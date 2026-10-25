import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import ForecastLanding from '@/components/Landing/ForecastLanding'
import { resolveHeadline, type HeadlineKey } from '@/lib/landing/headline'
import { comparisonRows, type ComparisonRow, type VenueDoc } from '@/lib/landing/comparison'
import { summariseCensus, type CensusSummary, type EvidenceDocLike } from '@/lib/landing/objections'
import { DEMO_ADDRESS } from '@/lib/position-sim/demo'

// THE CARRY LANDING (owner, 2026-10-25): carry traders and points farmers. Same STORY and
// components as `/`; copy, demo wallet and objections from lib/landing/pages.ts. The
// /[chain]/carry app is a separate page and is unchanged. Indexable; headline, subhead,
// objection answers and prose are in the server HTML (SEO R1).

interface Props {
  headline: HeadlineKey
  census: CensusSummary | null
  rows: ComparisonRow[]
}

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const headline = resolveHeadline({
    query: context.query?.v,
    userAgent: context.req.headers['user-agent'],
    randomId: randomUUID(),
  })
  let census: CensusSummary | null = null
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'public/data/oct10-2025/evidence.json'), 'utf8')
    census = summariseCensus(JSON.parse(raw) as EvidenceDocLike)
  } catch {
    census = null
  }
  // The checkmark table's venue cells come from the committed protocols snapshot.
  let venues: VenueDoc | null = null
  try {
    venues = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/data/oct10-2025/protocols.json'), 'utf8')) as VenueDoc
  } catch {
    venues = null
  }
  const rows = comparisonRows(venues, true)
  context.res.setHeader('Cache-Control', 'private, no-store')
  return { props: { headline, census, rows } }
}

const CarryPage = ({ headline, census, rows }: Props) => (
  <>
    <PageSeo
      seoClass="indexable"
      path="/carry"
      title="Earn the carry without managing it · Membrane"
      description="Paste a carry wallet and replay it through the 10 Oct 2025 crash: what your venue would have sold, and the same carry on Membrane with an 8-hour window."
      image={`/api/og/replay?a=${DEMO_ADDRESS}&s=oct10-2025`}
    />
    <ForecastLanding page="carry" headline={headline} census={census} comparisonRows={rows} />
  </>
)

export default CarryPage
