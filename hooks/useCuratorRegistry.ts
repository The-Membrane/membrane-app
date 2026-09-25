import { useQuery } from '@tanstack/react-query'

import type { Address } from '@/config/evm/contracts'
import { getPublicClient } from '@/services/chain/client'
import {
  getBondCoverageInputs,
  getCuratorProfile,
  getCuratorSnapshot,
} from '@/services/chain/curatorRegistry'

/**
 * CuratorRegistry reads for the curator pages and the BondCoverage seam. Client-side
 * only (enabled on the browser), through the app's one read client
 * (services/chain/client.ts → DEFAULT_EVM_CHAIN; 31337 local anvil until a mainnet
 * target is configured). A null result means the registry was not reachable.
 */

const STALE_MS = 15_000

export function useCuratorSnapshot() {
  return useQuery({
    queryKey: ['curatorRegistry', 'snapshot'],
    queryFn: () => getCuratorSnapshot(getPublicClient()),
    enabled: typeof window !== 'undefined',
    staleTime: STALE_MS,
  })
}

export function useCuratorProfile(vault: Address | undefined) {
  return useQuery({
    queryKey: ['curatorRegistry', 'profile', vault?.toLowerCase()],
    queryFn: () => getCuratorProfile(getPublicClient(), vault as Address),
    enabled: typeof window !== 'undefined' && Boolean(vault),
    staleTime: STALE_MS,
  })
}

/**
 * Supplies BondCoverage's `live` prop: `totalBonded` read directly from the registry,
 * `totalAum` = Σ trackedAum over allVaults (the registry has no `reportedAum`; its AUM
 * figure is the allocator-written `trackedAum`). `live` is undefined until the read lands.
 *
 *   const { live } = useBondCoverageLive()
 *   <BondCoverage live={live} />
 */
export function useBondCoverageLive() {
  const q = useQuery({
    queryKey: ['curatorRegistry', 'bondCoverage'],
    queryFn: () => getBondCoverageInputs(getPublicClient()),
    enabled: typeof window !== 'undefined',
    staleTime: STALE_MS,
  })
  const d = q.data
  return {
    ...q,
    live: d ? { totalBonded: d.totalBonded, totalAum: d.totalAum } : undefined,
    blockNumber: d?.blockNumber,
    registry: d?.registry,
  }
}
