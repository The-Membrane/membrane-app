import type { GetServerSideProps } from 'next'
import Head from 'next/head'
import React from 'react'

import PageSeo from '@/components/PageSeo'
import { ManageAlerts } from '@/components/Alerts/ManageAlerts'
import { FEED_TOKEN_RE } from '@/lib/userAlerts/metrics'

// /alerts/<feed token> — the token-gated "your alerts" page: this one feed's
// thresholds with Stop buttons, linked from every RSS item. The token is the only
// key; the data comes from GET /api/alerts/feed/<token> (client-side), so this
// response carries nothing but the token already in its own URL.
//   - malformed token → 404, before anything else
//   - private, no-store; noindex,nofollow (header + meta); no referrer, so the
//     capability URL never leaks to a linked site
//   - canonical path is "/alerts", never the token

type Props = { token: string; siteUrl: string }

export const getServerSideProps: GetServerSideProps<Props> = async ({ params, res }) => {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const raw = params?.token
  const token = (typeof raw === 'string' ? raw : '').toLowerCase()
  if (!FEED_TOKEN_RE.test(token)) return { notFound: true }
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || 'https://membrane.money').replace(/\/$/, '')
  return { props: { token, siteUrl } }
}

const AlertsPage: React.FC<Props> = ({ token, siteUrl }) => (
  <>
    <PageSeo seoClass="internal" title="Membrane — your alerts" description="Your private alert feed." path="/alerts" />
    <Head>
      <meta name="referrer" content="no-referrer" />
    </Head>
    <ManageAlerts token={token} siteUrl={siteUrl} />
  </>
)

export default AlertsPage
