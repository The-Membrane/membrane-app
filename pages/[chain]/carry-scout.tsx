import type { GetServerSideProps } from 'next'
import React from 'react'

import { CarryScout } from '@/components/CarryScout'
import PageSeo from '@/components/PageSeo'
import { DEFAULT_CHAIN, supportedChains } from '@/config/chains'
import {
  CARRY_SCAN_CACHE_CONTROL,
  leanView,
  loadCarryScan,
  loadFallbackSnapshot,
  type CarryScanView,
} from '@/lib/carryScan/load'

// /[chain]/carry-scout — the weekly positive-carry scout. The scan lives on the orphan
// `data` branch and is read at request time (no rebuild); the committed snapshot covers an
// outage. Same SSR pattern as pages/[chain]/venue/[name].tsx, plus a CDN cache.

type Props = { view: CarryScanView }

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  if (!supportedChains.some((c) => c.name === chainName)) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}/carry-scout`, permanent: false } }
  }
  const view = await loadCarryScan({ fallback: loadFallbackSnapshot })
  context.res.setHeader('Cache-Control', CARRY_SCAN_CACHE_CONTROL)
  return { props: { view: leanView(view) } }
}

const CarryScoutPage = ({ view }: Props) => (
  <>
    <PageSeo
      seoClass="indexable"
      path={`/${DEFAULT_CHAIN}/carry-scout`}
      title="Membrane Carry Scout — Ethereum Stable Venues That Beat Their Borrow Rate"
      description="A weekly scan of Ethereum stablecoin venues ranked on market carry: each venue's net yield at your size minus the cheapest borrow of the same stable, verified on-chain, with Membrane carry beside it. Spreads are measured at the last scan, not promised."
    />
    <CarryScout view={view} />
  </>
)

export default CarryScoutPage
