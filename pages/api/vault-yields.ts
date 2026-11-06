import type { NextApiRequest, NextApiResponse } from 'next'

import { usableVaults, type VaultRow } from '@/components/LiquidationMap/marketsLogic'

// GET /api/vault-yields — where depositors earn: the largest Morpho curator vaults
// on Ethereum (V1 listed + V2), net APY and size, from the public Morpho API.
// Protocol-scoped; filtered by usableVaults. Cached 10 min at the edge.

const API = 'https://blue-api.morpho.org/graphql'

async function gql<T>(query: string): Promise<T | null> {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!r.ok) return null
  return ((await r.json()) as { data?: T }).data ?? null
}

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    type V1 = {
      vaults: {
        items: {
          name: string
          asset: { symbol: string }
          state: { netApy: number | null; totalAssetsUsd: number | null } | null
        }[]
      }
    }
    type V2 = {
      vaultV2s: {
        items: {
          name: string
          asset: { symbol: string }
          netApy: number | null
          totalAssetsUsd: number | null
        }[]
      }
    }
    const [v1, v2] = await Promise.all([
      gql<V1>(
        '{ vaults(first: 40, orderBy: TotalAssetsUsd, orderDirection: Desc, where: { chainId_in: [1], listed: true }) { items { name asset { symbol } state { netApy totalAssetsUsd } } } }',
      ),
      gql<V2>(
        '{ vaultV2s(first: 40, orderBy: TotalAssetsUsd, orderDirection: Desc, where: { chainId_in: [1] }) { items { name asset { symbol } netApy totalAssetsUsd } } }',
      ),
    ])
    const rows: VaultRow[] = [
      ...(v1?.vaults.items ?? []).map((v) => ({
        name: v.name,
        asset: v.asset.symbol,
        netApy: v.state?.netApy ?? -1,
        tvlUsd: v.state?.totalAssetsUsd ?? 0,
        version: 'V1' as const,
      })),
      ...(v2?.vaultV2s.items ?? []).map((v) => ({
        name: v.name,
        asset: v.asset.symbol,
        netApy: v.netApy ?? -1,
        tvlUsd: v.totalAssetsUsd ?? 0,
        version: 'V2' as const,
      })),
    ]
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200')
    return res.status(200).json({
      readAt: new Date().toISOString(),
      kind: 'measured',
      source: 'Morpho public API (Ethereum vaults V1 listed + V2)',
      vaults: usableVaults(rows),
    })
  } catch {
    return res.status(502).json({ error: 'read failed' })
  }
}
