import { useQuery } from '@tanstack/react-query'

import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useChainRoute } from '@/hooks/useChainRoute'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * Scans every managed market and compiles loop/close-position msgs to fulfil users' UXBoost
 * intents (loop_position / close_position on the managed-market contracts).
 *
 * TODO(evm-migration): the managed-market contracts have no ported Solidity equivalents
 * (there is no managed-market entry in config/evm/contracts.ts, no ABI in contracts/abis,
 * and services/managed.ts is CosmWasm-only). The whole scan + msg build is stubbed until a
 * managed-market service exists on EVM.
 */
export const useFulfillManagedMarketIntents = (run = true) => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)

  const { data: queryData } = useQuery<{
    msgs: EvmCall[] | undefined
    status: 'pending' | 'finished' | 'error'
  }>({
    queryKey: ['fulfill_managed_market_intents', address, run],
    queryFn: async () => {
      // TODO(evm-migration): no managed-market contracts on EVM.
      return { msgs: undefined, status: 'finished' as const }
    },
    enabled: !!address && run,
    staleTime: 60 * 1000,
  })

  const msgs = queryData?.msgs
  const status = queryData?.status ?? 'pending'

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['managed_market_intents_sim', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
    msgs,
    status,
  }
}

export default useFulfillManagedMarketIntents
