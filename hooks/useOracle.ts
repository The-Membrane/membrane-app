import { useQuery } from '@tanstack/react-query'
import { getPublicClient } from '@/services/chain/client'
import { getOraclePricesByDenom } from '@/services/chain/oracle'
import { useBasket } from './useCDP'
import useAppState from '@/persisted-state/useAppState'
import { useChainRoute } from './useChainRoute'

/**
 * Oracle price/config hooks, rewired onto the EVM read service
 * (services/chain/oracle.ts) via the wallet-independent viem public client.
 *
 * Prices are the real-time (30s) staleTime tier per hook-query-patterns.
 *
 * NOTE: the CosmWasm oracle was keyed by denom string; the EVM Oracle is keyed by
 * bytes32 asset identity and there is no on-chain denom→bytes32 registry. The
 * denom-keyed price/source fetches are therefore TODO-stubbed in the service and
 * resolve to null here until callers migrate to bytes32 AssetKeys (see
 * services/chain/oracle.ts getPrice/getSource).
 */

export const useOraclePrice = () => {
  const { chainName } = useChainRoute()
  const { appState } = useAppState()
  const { data: basket, dataUpdatedAt } = useBasket(appState.rpcUrl)

  return useQuery({
    queryKey: ['oraclePrice', dataUpdatedAt, appState.rpcUrl],
    queryFn: async () => {
      if (!basket) return
      // TODO(evm-migration): denom-keyed price fetch is stubbed (no denom→bytes32
      // registry). Returns null until consumers move to getPrice(bytes32).
      return getOraclePricesByDenom(getPublicClient())
    },
    refetchInterval: false,
    enabled: !!basket,
    staleTime: 1000 * 30,
  })
}
