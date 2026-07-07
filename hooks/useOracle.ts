import { useQuery } from '@tanstack/react-query'
import { getPublicClient } from '@/services/chain/client'
import {
  getOracleConfig,
  getOraclePricesByDenom,
  getOracleSourcesByDenom,
} from '@/services/chain/oracle'
import { useBasket } from './useCDP'
import { AssetInfo } from '@/contracts/codegen/oracle/Oracle.types'
import useAppState from '@/persisted-state/useAppState'
import { useRouter } from 'next/router'
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

export const useOracleConfig = () => {
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['oracleConfig', router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith('/control-room')) return
      return getOracleConfig(getPublicClient())
    },
    refetchInterval: false,
    enabled: true,
    staleTime: 1000 * 30,
  })
}

export const useOracleAssetInfos = (assetInfos: AssetInfo[]) => {
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['oracleAssetInfos', router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith('/control-room') && !router.pathname.endsWith('/isolated')) return []
      // TODO(evm-migration): denom-keyed source fetch is stubbed (no denom→bytes32
      // registry; source shape changed). Returns null until consumers move to
      // getSource(bytes32).
      return getOracleSourcesByDenom(getPublicClient())
    },
    refetchInterval: false,
    enabled: !!assetInfos,
    staleTime: 1000 * 30,
  })
}
