import React from 'react'
import dynamic from 'next/dynamic'

import PageSeo from '@/components/PageSeo'

// Client-rendered: the feed is read from /api/curator-feed (.data/curator-feed, else the
// private datasets repo — lib/curatorFeed/paths.ts) and its pending / executable status
// follows the clock.
const CuratorFeed = dynamic(
  () => import('@/components/CuratorFeed/CuratorFeed').then((m) => m.CuratorFeed),
  { ssr: false },
)

const CuratorFeedPage = () => (
  <>
    <PageSeo
      seoClass="app"
      title="Membrane — Curator action feed"
      description="Supply-cap changes, market removals, queue and timelock changes by MetaMorpho, Vault V2 and Euler Earn curators on Ethereum; clustered exits of one collateral; which vaults hold which collateral."
    />
    <CuratorFeed />
  </>
)

export default CuratorFeedPage
