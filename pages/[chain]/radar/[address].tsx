import type { GetServerSideProps } from 'next'
import React from 'react'
import { sql } from 'drizzle-orm'

import PageSeo from '@/components/PageSeo'
import { Radar } from '@/components/Radar/Radar'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'
import {
  normalizeAddress,
  radarOgImagePath,
  radarSeoClass,
  shortAddr,
  type WatchLookup,
} from '@/lib/share/permalink'

// /[chain]/radar/[address] — the shareable permalink for one address's radar read
// (MOAT_TRACKER step 4). The scan itself still runs client-side in <Radar/>; this
// page only fixes the URL, the canonical, the per-result OG card, and the index rule:
// indexable ONLY when the address is already public on the Strats board
// (strat_watches); every other address, and any DB error, is noindex.

type Props = { address: string; lookup: WatchLookup }

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  if (!supportedChains.some((c) => c.name === chainName)) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}/radar`, permanent: false } }
  }

  const address = normalizeAddress(context.params?.address as string | undefined)
  if (!address) {
    return { redirect: { destination: `/${chainName}/radar`, permanent: false } }
  }

  let lookup: WatchLookup = 'error'
  try {
    // Lazy import: a missing DATABASE_URL throws at first use, caught below ⇒ noindex.
    const { db } = await import('@/db')
    const res = await db.execute(sql`
      SELECT 1 FROM strat_watches WHERE lower(address) = ${address} LIMIT 1`)
    lookup = res.rows.length > 0 ? 'watched' : 'not-watched'
  } catch {
    lookup = 'error'
  }

  return { props: { address, lookup } }
}

export default function RadarPermalink({ address, lookup }: Props) {
  return (
    <>
      <PageSeo
        seoClass={radarSeoClass(lookup)}
        path={`/${DEFAULT_CHAIN}/radar/${address}`}
        image={radarOgImagePath(address) ?? undefined}
        title={`${shortAddr(address)} — Carry Radar | Membrane`}
        description={`Positions held by ${shortAddr(address)} in sUSDe, sUSDS, scrvUSD and Aave USDe, stressed against recorded venue capacity and outflow.`}
      />
      <Radar initialAddress={address} />
    </>
  )
}
