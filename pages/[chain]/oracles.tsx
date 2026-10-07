import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import { OracleRegistry } from '@/components/OracleRegistry'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'
import type { AssetViewResponse, OracleIndexResponse } from '@/lib/oracleRegistry/apiTypes'
import type { ConfigCardView, ConfigIndexResponse } from '@/lib/oracleRegistry/config/apiTypes'
import {
  findConfigSubject,
  getConfigCard,
  getConfigIndex,
} from '@/lib/oracleRegistry/config/server'
import { requestedAssetSlug, subjectSlug } from '@/lib/oracleRegistry/config/view'
import { getRegistryModel } from '@/lib/oracleRegistry/server'
import { assetSlug, buildAssetView, buildIndex, findAssetKey } from '@/lib/oracleRegistry/view'

// /[chain]/oracles — the oracle registry. Internal (noindex, not in the global nav) while
// it is being shaped. The index and the selected asset (?asset=wsteth, default eth) are
// server-rendered from the collector's files so the first paint is fully populated; the
// other assets load from /api/oracles/[asset]. Missing data degrades to mechanism-only
// cards (available: false), never a 500.
//
// ?view=config server-renders the selected asset's CONFIG CARD instead (trust configuration
// and change timeline); config-only subjects (?asset=rseth) always open in that view.

type Props = {
  index: OracleIndexResponse | null
  asset: AssetViewResponse | null
  slug: string
  configIndex: ConfigIndexResponse | null
  config: ConfigCardView | null
  view: 'oracles' | 'config'
}

function configIndexOrNull(): ConfigIndexResponse | null {
  try {
    return getConfigIndex()
  } catch {
    return null
  }
}

const DEFAULT_ASSET = 'eth'

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  if (!supportedChains.some((c) => c.name === chainName)) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}/oracles`, permanent: false } }
  }
  const requested = typeof context.query.asset === 'string' ? context.query.asset : DEFAULT_ASSET
  const wantsConfig = context.query.view === 'config'
  const configIndex = configIndexOrNull()
  // A config-only subject (not in the oracle catalog) always opens in the config view.
  const subject = findConfigSubject(requested)
  const configOnly = !!subject && !subject.oracleAssetKey
  const readConfig = (slug: string): ConfigCardView | null => {
    try {
      return getConfigCard(slug)
    } catch {
      return null
    }
  }
  if (configOnly && subject) {
    const slug = subjectSlug(subject)
    let index: OracleIndexResponse | null = null
    try {
      index = buildIndex(getRegistryModel())
    } catch {
      index = null
    }
    const props = JSON.parse(
      JSON.stringify({
        index,
        asset: null,
        slug,
        configIndex,
        config: readConfig(slug),
        view: 'config',
      }),
    ) as Props
    return { props }
  }
  try {
    const model = getRegistryModel()
    const key =
      findAssetKey(model.inputs.catalog, requested) ??
      findAssetKey(model.inputs.catalog, requestedAssetSlug(requested, subject)) ??
      findAssetKey(model.inputs.catalog, DEFAULT_ASSET) ??
      model.inputs.catalog.assets[0].key
    const slug = assetSlug(key)
    const config = wantsConfig ? readConfig(slug) : null
    const view = config ? 'config' : 'oracles'
    // JSON round-trip: Next refuses `undefined` in props; the payload is plain JSON anyway.
    const props = JSON.parse(
      JSON.stringify({
        index: buildIndex(model),
        // The config view does not need the oracle cards on first paint.
        asset: view === 'config' ? null : buildAssetView(model, key),
        slug,
        configIndex,
        config,
        view,
      }),
    ) as Props
    return { props }
  } catch {
    return {
      props: {
        index: null,
        asset: null,
        slug: requested.toLowerCase(),
        configIndex,
        config: null,
        view: 'oracles',
      },
    }
  }
}

export default function OraclesPage({ index, asset, slug, configIndex, config, view }: Props) {
  return (
    <>
      <PageSeo
        seoClass="internal"
        title="Oracle registry | Membrane"
        description="The oracles that price ETH, wstETH, weETH, WBTC, cbBTC, USDe, sUSDe and sUSDS in the main Ethereum lending markets, compared with the median of each asset's market feeds, with 30 days of history and the mechanism behind each price."
      />
      <OracleRegistry
        initialIndex={index}
        initialAsset={asset}
        initialSlug={slug}
        initialConfigIndex={configIndex}
        initialConfig={config}
        initialView={view}
      />
    </>
  )
}
