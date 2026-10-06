import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import { OracleRegistry } from '@/components/OracleRegistry'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'
import type { AssetViewResponse, OracleIndexResponse } from '@/lib/oracleRegistry/apiTypes'
import { getRegistryModel } from '@/lib/oracleRegistry/server'
import { assetSlug, buildAssetView, buildIndex, findAssetKey } from '@/lib/oracleRegistry/view'

// /[chain]/oracles — the oracle registry. Internal (noindex, not in the global nav) while
// it is being shaped. The index and the selected asset (?asset=wsteth, default eth) are
// server-rendered from the collector's files so the first paint is fully populated; the
// other assets load from /api/oracles/[asset]. Missing data degrades to mechanism-only
// cards (available: false), never a 500.

type Props = {
  index: OracleIndexResponse | null
  asset: AssetViewResponse | null
  slug: string
}

const DEFAULT_ASSET = 'eth'

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  if (!supportedChains.some((c) => c.name === chainName)) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}/oracles`, permanent: false } }
  }
  const requested = typeof context.query.asset === 'string' ? context.query.asset : DEFAULT_ASSET
  try {
    const model = getRegistryModel()
    const key =
      findAssetKey(model.inputs.catalog, requested) ??
      findAssetKey(model.inputs.catalog, DEFAULT_ASSET) ??
      model.inputs.catalog.assets[0].key
    // JSON round-trip: Next refuses `undefined` in props; the payload is plain JSON anyway.
    const props = JSON.parse(
      JSON.stringify({
        index: buildIndex(model),
        asset: buildAssetView(model, key),
        slug: assetSlug(key),
      }),
    ) as Props
    return { props }
  } catch {
    return { props: { index: null, asset: null, slug: requested.toLowerCase() } }
  }
}

export default function OraclesPage({ index, asset, slug }: Props) {
  return (
    <>
      <PageSeo
        seoClass="internal"
        title="Oracle registry | Membrane"
        description="The oracles that price ETH, wstETH, weETH, WBTC, cbBTC, USDe, sUSDe and sUSDS in the main Ethereum lending markets, compared with the median of each asset's market feeds, with 30 days of history and the mechanism behind each price."
      />
      <OracleRegistry initialIndex={index} initialAsset={asset} initialSlug={slug} />
    </>
  )
}
