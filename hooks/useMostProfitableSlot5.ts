import { useMemo } from 'react'
import { useDiscoAssets } from '@/hooks/useDiscoData'
import { getAssetByDenom } from '@/helpers/chain'
import { useQueries } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getAssetQueue, getSlotWeights } from '@/services/disco'

export interface MostProfitableSlot5 {
  /** IBC denom of the most profitable asset */
  asset: string
  /** Human-readable symbol (e.g. "USDC", "ATOM") */
  symbol: string
  /** Slot number (always 5) */
  slot: number
  /** Revenue weight for slot 5 of this asset */
  weight: string
  /** Total deposit tokens in slot 5 */
  tvl: string
  /** Profitability score: weight / tvl (higher = more profitable per unit) */
  profitability: number
}

/**
 * Hook to determine the most profitable slot 5 asset across all Disco queues.
 * Profitability = slot 5 revenue weight / slot 5 TVL (higher = better yield per unit deposited).
 */
export const useMostProfitableSlot5 = () => {
  const { appState } = useAppState()
  const { data: client } = useCosmWasmClient(appState.rpcUrl)
  const { data: discoAssets } = useDiscoAssets()

  // Memoized so a fresh `[]` isn't produced every render (which would make the
  // useQueries inputs and the bestSlot5 useMemo below recompute on every render).
  const assets = useMemo(() => discoAssets?.assets || [], [discoAssets?.assets])

  // Query slot weights for each asset
  const weightQueries = useQueries({
    queries: assets.map((asset: string) => ({
      queryKey: ['disco', 'slot_weights', asset, appState.rpcUrl],
      queryFn: () => getSlotWeights(client || null, asset),
      enabled: !!asset,
      staleTime: 1000 * 60 * 5,
    })),
  })

  // Query asset queues for each asset (to get slot 5 TVL)
  const queueQueries = useQueries({
    queries: assets.map((asset: string) => ({
      queryKey: ['disco', 'asset_queue', asset, appState.rpcUrl],
      queryFn: () => getAssetQueue(client || null, asset),
      enabled: !!asset,
      staleTime: 1000 * 60 * 5,
    })),
  })

  const isLoading = weightQueries.some((q) => q.isLoading) || queueQueries.some((q) => q.isLoading)

  const bestSlot5 = useMemo((): MostProfitableSlot5 | null => {
    if (assets.length === 0) return null

    let best: MostProfitableSlot5 | null = null

    assets.forEach((asset: string, index: number) => {
      const weightsData = weightQueries[index]?.data as { weights: [number, string][] } | null | undefined
      const queueData = queueQueries[index]?.data as { queue: { slots: any[] } } | null | undefined

      if (!weightsData?.weights || !queueData?.queue?.slots) return

      // Find slot 5 weight
      const slot5Weight = weightsData.weights.find(
        (w: [number, string]) => w[0] === 5
      )
      if (!slot5Weight) return

      const weight = parseFloat(slot5Weight[1])

      // Find slot 5 TVL from queue
      const slot5 = queueData.queue.slots.find(
        (s: any) => s.index === 5
      )
      if (!slot5) return

      const tvl = parseFloat(slot5.total_deposit_tokens)
      if (tvl <= 0) return

      // Profitability = weight / tvl (revenue share per unit deposited)
      const profitability = weight / tvl

      // Get human-readable symbol
      const assetInfo = getAssetByDenom(asset)
      const symbol = assetInfo?.symbol || asset.slice(0, 12) + '...'

      if (!best || profitability > best.profitability) {
        best = {
          asset,
          symbol,
          slot: 5,
          weight: slot5Weight[1],
          tvl: slot5.total_deposit_tokens,
          profitability,
        }
      }
    })

    return best
  }, [assets, weightQueries, queueQueries])

  return {
    data: bestSlot5,
    isLoading,
  }
}
