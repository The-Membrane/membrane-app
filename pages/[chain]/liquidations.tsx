import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import type { GetServerSideProps } from 'next'

import PageSeo from '@/components/PageSeo'
import { LiquidationMap } from '@/components/LiquidationMap/LiquidationMap'
import type { LayersDoc } from '@/components/LiquidationMap/liqmapLogic'
import type { StressDoc } from '@/components/LiquidationMap/StressReplay'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// /[chain]/liquidations — Aave V3 liquidation map (3 layers) and Position X-ray
// (board Q26-TERMINAL-MAP). The snapshot (~9KB) is server-rendered so the first
// paint and crawlers see real figures (docs/SEO_RULESET.md R1).

type Props = { doc: LayersDoc | null; stress: StressDoc | null }

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  if (!supportedChains.some((c) => c.name === chainName)) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}/liquidations`, permanent: false } }
  }
  let doc: LayersDoc | null = null
  try {
    doc = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'public/data/liquidation-map/layers.json'), 'utf8'),
    )
  } catch {
    doc = null
  }
  let stress: StressDoc | null = null
  try {
    stress = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'public/data/liquidation-map/stress.json'), 'utf8'),
    )
  } catch {
    stress = null
  }
  return { props: { doc, stress } }
}

const LiquidationsPage: React.FC<Props> = ({ doc, stress }) => (
  <>
    <PageSeo
      seoClass="indexable"
      title="Aave liquidation map — Membrane"
      description="Aave V3 debt within 10% of liquidation on 7 chains, split into price risk, staked-ETH loops and stablecoin positions, plus a live X-ray of any account."
    />
    <LiquidationMap doc={doc} stress={stress} />
  </>
)

export default LiquidationsPage
